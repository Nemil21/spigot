import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import weeklyJob from '../jobs/payout-weekly.job.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import { FakePayPalExtras } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import { setPayoutDeps, type PayoutDeps } from './deps.js';
import type { PayoutRunDeps } from './payoutRun.js';
import { pollRecentBatches, pollStaleBatches } from './poll.js';
import { runWeeklyPayout, weeklySlot, WEEKLY_CATCH_UP_MS } from './weekly.js';

/**
 * SP-060 on FakePayPal with a fake clock (`*.db.test.ts`, CI's db job): two firings for the same
 * week → one batch (also racing on two pools), a FAILED / RETURNED item's amount is in the next
 * week's batch, UNCLAIMED blocks the publisher, an empty week stays empty, the catch-up window,
 * crash-resume, and the `payouts.weekly` job file.
 */

const MERCHANT = 'merchant@spigot.example';
const UNREGISTERED = 'nobody-yet@payee.example';
const WEEK_MS = 7 * 24 * 3_600_000;
const MIN = 60_000;

describe.skipIf(!testDatabaseUrl)('weekly payout', { timeout: 60_000 }, () => {
  let pools: TwoPools;
  let db: Db;
  let fake: FakePayPalExtras;
  let deps: PayoutRunDeps & PayoutDeps;
  /** Next Monday 09:00 PT after the real clock, so charges made now fall inside its period. */
  let monday0: Date;
  /** Monday 09:00 PT `week` weeks after `monday0` (DST-safe), plus `plusMs`. */
  const monday = (week: number, plusMs = 0) =>
    new Date(
      weeklySlot(new Date(monday0.getTime() + week * WEEK_MS + 12 * 60 * MIN)).getTime() + plusMs,
    );

  beforeEach(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
    fake = new FakePayPalExtras({
      payouts: { merchantEmail: MERCHANT, unregisteredEmails: [UNREGISTERED], settlesAfterGets: 2 },
    });
    deps = {
      pool: pools.a,
      pp: moneyOut(fake.transport({ timeoutMs: 1_000 }), undefined),
      retryDelayMs: 0,
    };
    monday0 = weeklySlot(new Date(Date.now() + WEEK_MS));
  }, 30_000);
  afterEach(async () => {
    vi.useRealTimers();
    setPayoutDeps(undefined);
    await pools?.close();
  }, 30_000);

  async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await pools.a.query(sql, params)).rows as T[];
  }

  async function newPublisher(email = `${randomUUID()}@payee.example`): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('Pub', $1, $2) RETURNING id`,
      [`${randomUUID()}@pub.example`, email],
    );
    return row!.id;
  }

  /** One charge of `priceMicros` at 20% commission: payable += 80%. */
  async function charge(publisherId: string, priceMicros: number): Promise<void> {
    await db.tx(async (tx) => {
      const platform = await platformAccounts(tx);
      const [b] = (await tx.query(`INSERT INTO buyers (name) VALUES ('B') RETURNING id`)).rows;
      const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', b.id);
      const publisher = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', publisherId);
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, priceMicros),
      });
      await post(tx, {
        kind: 'CHARGE',
        idempotencyKey: `charge:${randomUUID()}`,
        entries: chargeEntries(
          { buyer, publisher, platformRevenue: platform.platformRevenue },
          priceMicros,
          2000,
        ),
      });
    });
  }

  const payable = async (publisherId: string) =>
    Number(
      (
        await q<{ b: string }>(
          `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'PUBLISHER_PAYABLE' AND owner_id = $1`,
          [publisherId],
        )
      )[0]?.b ?? 0,
    );
  const batches = () =>
    q<{ id: string; trigger: string; status: string; period_end: Date; item_count: number }>(
      `SELECT * FROM payout_batches ORDER BY created_at`,
    );
  const itemsOf = (batchId: string) =>
    q<{ id: string; publisher_id: string; status: string; net_cents: number }>(
      `SELECT * FROM payout_items WHERE batch_id = $1 ORDER BY created_at`,
      [batchId],
    );
  const latestItem = async (publisherId: string) =>
    (
      await q<{ id: string; batch_id: string; status: string; paypal_item_id: string | null }>(
        `SELECT * FROM payout_items WHERE publisher_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [publisherId],
      )
    )[0]!;
  const expectLedgerOk = async () => expect((await ledgerCheck(pools.a)).mismatches).toEqual([]);

  /** Make the batch look submitted `minutes` ago, so the daily poll picks it up. */
  async function submittedAgo(batchId: string, minutes: number): Promise<void> {
    await pools.a.query(
      `INSERT INTO audit_events (at, actor_type, actor_id, entity, entity_id, action)
       SELECT now() - make_interval(mins => $2), 'WORKFLOW', 'test', 'payout_item', id, 'PAYOUT_SENT'
       FROM payout_items WHERE batch_id = $1`,
      [batchId, minutes],
    );
  }

  test('two firings for the same week → one batch, one PayPal payout', async () => {
    const a = await newPublisher();
    await charge(a, 15_000_000); // $12.00 payable
    const first = await runWeeklyPayout(deps, monday(0, 1 * MIN));
    expect(first).toMatchObject({ outcome: 'PENDING', periodEnd: monday(0) });

    // More money arrives; a later firing the same week (restart, second process) builds nothing.
    await charge(await newPublisher(), 15_000_000);
    const second = await runWeeklyPayout(deps, monday(0, 3 * 60 * MIN));
    expect(second).toMatchObject({ outcome: 'PERIOD_TAKEN', periodEnd: monday(0) });

    const all = await batches();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ trigger: 'SCHEDULE', item_count: 1 });
    expect(all[0]!.period_end.toISOString()).toBe(monday(0).toISOString());
    expect(fake.payouts.batchesCreated).toBe(1);
    await expectLedgerOk();
  });

  test('race: two firings at once on two pools → one batch, one item per publisher', async () => {
    const pubs = [await newPublisher(), await newPublisher(), await newPublisher()];
    for (const p of pubs) await charge(p, 15_000_000);
    const [r1, r2] = await Promise.all([
      runWeeklyPayout(deps, monday(0, 5 * MIN)),
      runWeeklyPayout({ ...deps, pool: pools.b }, monday(0, 5 * MIN + 2_000)),
    ]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['PENDING', 'PERIOD_TAKEN']);

    const all = await batches();
    expect(all).toHaveLength(1);
    const items = await itemsOf(all[0]!.id);
    expect(items.map((i) => i.publisher_id).sort()).toEqual([...pubs].sort());
    expect(fake.payouts.batchesCreated).toBe(1);
    for (const p of pubs) expect(await payable(p)).toBe(0);
    await expectLedgerOk();
  });

  test("a FAILED item's amount is in the next week's batch", async () => {
    const ok = await newPublisher();
    const failing = await newPublisher(MERCHANT); // SELF_PAY_NOT_ALLOWED in PayPal
    await charge(ok, 15_000_000);
    await charge(failing, 15_000_000);
    const week0 = await runWeeklyPayout(deps, monday(0, MIN));
    expect(week0.outcome).toBe('PENDING');
    for (let i = 0; i < 3; i++) await pollRecentBatches(deps);
    const failed = await latestItem(failing);
    expect(failed.status).toBe('FAILED');
    expect(await payable(failing)).toBe(12_000_000); // PAYOUT_RETURNED: back in payable

    // The publisher fixes their payout email and earns $4 more during the week.
    await q(`UPDATE publishers SET payout_email = $2 WHERE id = $1`, [
      failing,
      `${randomUUID()}@payee.example`,
    ]);
    await charge(failing, 5_000_000);

    const week1 = await runWeeklyPayout(deps, monday(1, MIN));
    expect(week1).toMatchObject({ outcome: 'PENDING', periodEnd: monday(1) });
    expect(week1.outcome === 'PENDING' && week1.batchId).not.toBe(failed.batch_id);
    const items = await itemsOf((week1 as { batchId: string }).batchId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ publisher_id: failing, net_cents: 1_600 }); // $12 + $4
    expect(await payable(failing)).toBe(0);
    await expectLedgerOk();
  });

  test('UNCLAIMED blocks the publisher; once RETURNED the amount is in the next weekly batch', async () => {
    const u = await newPublisher(UNREGISTERED);
    const other = await newPublisher();
    await charge(u, 15_000_000);
    const week0 = await runWeeklyPayout(deps, monday(0, MIN));
    expect(week0.outcome).toBe('PENDING');
    for (let i = 0; i < 3; i++) await pollRecentBatches(deps);
    const unclaimed = await latestItem(u);
    expect(unclaimed.status).toBe('UNCLAIMED');

    // Week 1: u earned more but is blocked by the UNCLAIMED item; the other publisher is paid.
    await charge(u, 5_000_000);
    await charge(other, 15_000_000);
    const week1 = await runWeeklyPayout(deps, monday(1, MIN));
    expect(week1.outcome).toBe('PENDING');
    const items1 = await itemsOf((week1 as { batchId: string }).batchId);
    expect(items1.map((i) => i.publisher_id)).toEqual([other]);
    expect(await payable(u)).toBe(4_000_000);

    // 30 days unclaimed → RETURNED (daily poll) → back in payable.
    fake.returnPayout(unclaimed.paypal_item_id!);
    await submittedAgo(unclaimed.batch_id, 60 * 24 * 30);
    await pollStaleBatches(deps);
    await pollStaleBatches(deps);
    expect((await latestItem(u)).status).toBe('RETURNED');
    expect(await payable(u)).toBe(16_000_000);

    // u's payout email is still unregistered; the item goes out again (and PayPal decides).
    const week2 = await runWeeklyPayout(deps, monday(2, MIN));
    expect(week2.outcome).toBe('PENDING');
    const items2 = await itemsOf((week2 as { batchId: string }).batchId);
    expect(items2).toEqual([expect.objectContaining({ publisher_id: u, net_cents: 1_600 })]);
    await expectLedgerOk();
  });

  test('an empty week stays empty: later firings that week build nothing; next week pays', async () => {
    const a = await newPublisher();
    expect(await runWeeklyPayout(deps, monday(0, MIN))).toMatchObject({ outcome: 'NO_ITEMS' });

    await charge(a, 15_000_000);
    expect(await runWeeklyPayout(deps, monday(0, 6 * 60 * MIN))).toMatchObject({
      outcome: 'EMPTY_SLOT',
      periodEnd: monday(0),
    });
    expect(await batches()).toHaveLength(0);

    expect(await runWeeklyPayout(deps, monday(1, MIN))).toMatchObject({
      outcome: 'PENDING',
      periodEnd: monday(1),
    });
    expect(await batches()).toHaveLength(1);
  });

  test('catch-up window: up to 24 h after Monday 09:00 PT; later firings wait for next Monday', async () => {
    const a = await newPublisher();
    await charge(a, 15_000_000);
    expect(await runWeeklyPayout(deps, monday(0, -MIN))).toMatchObject({
      outcome: 'OUTSIDE_WINDOW',
      periodEnd: monday(-1),
    });
    expect(await runWeeklyPayout(deps, monday(0, WEEKLY_CATCH_UP_MS))).toMatchObject({
      outcome: 'OUTSIDE_WINDOW',
      periodEnd: monday(0),
    });
    expect(await batches()).toHaveLength(0);

    // Down all Monday morning, back at Tuesday 08:59 PT: still this week's run.
    expect(await runWeeklyPayout(deps, monday(0, WEEKLY_CATCH_UP_MS - MIN))).toMatchObject({
      outcome: 'PENDING',
      periodEnd: monday(0),
    });
  });

  test('PayPal down → the next firing in the window resumes the same batch; still one payout', async () => {
    const a = await newPublisher();
    await charge(a, 15_000_000);
    fake.failNext('payout', { kind: 'status', http: 503 }, 3);
    const first = await runWeeklyPayout(deps, monday(0, MIN));
    expect(first).toMatchObject({ outcome: 'RETRY_LATER' });

    const second = await runWeeklyPayout(deps, monday(0, 6 * MIN));
    expect(second).toMatchObject({ outcome: 'PENDING', resumed: true });
    expect((second as { batchId: string }).batchId).toBe((first as { batchId: string }).batchId);
    expect(await runWeeklyPayout(deps, monday(0, 11 * MIN))).toMatchObject({
      outcome: 'PERIOD_TAKEN',
    });
    expect(await batches()).toHaveLength(1);
    expect(fake.payouts.batchesCreated).toBe(1);
    await expectLedgerOk();
  });

  test('the payouts.weekly job runs the week once on the (fake) clock', async () => {
    expect(weeklyJob.name).toBe('payouts.weekly');
    setPayoutDeps(deps);
    const a = await newPublisher();
    await charge(a, 15_000_000);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(monday(0, -10 * MIN)); // Monday 08:50 PT: last week's window is over
    await weeklyJob.run();
    expect(await batches()).toHaveLength(0);

    vi.setSystemTime(monday(0, 5 * MIN));
    await weeklyJob.run();
    vi.setSystemTime(monday(0, 10 * MIN));
    await weeklyJob.run();
    vi.useRealTimers();

    const all = await batches();
    expect(all).toHaveLength(1);
    expect(all[0]!.period_end.toISOString()).toBe(monday(0).toISOString());
    expect(fake.payouts.batchesCreated).toBe(1);
  });
});
