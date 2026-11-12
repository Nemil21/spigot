import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PUBLISHER_EVENTS_CHANNEL } from '@spigot/shared';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import { FakePayPalExtras } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import type { PayoutDeps } from './deps.js';
import { payoutRun } from './payoutRun.js';
import { pollBatch, pollRecentBatches, pollStaleBatches, reconcileBatch } from './poll.js';
import { applyItemStatus } from './reconcile.js';
import { PAYOUT_ALERT } from './submit.js';

/**
 * SP-021 acceptance, race and idempotency tests on FakePayPal (`*.db.test.ts`, CI's db job):
 * poll → PENDING → PROCESSING → SUCCESS, UNCLAIMED → SUCCESS / RETURNED, FAILED, fee_cents,
 * "the same status twice posts once", and a poller racing a webhook for the same item.
 */

const MERCHANT = 'merchant@spigot.example';
const UNREGISTERED = 'nobody-yet@payee.example';

describe.skipIf(!testDatabaseUrl)('payout status reconcile', { timeout: 60_000 }, () => {
  let pools: TwoPools;
  let db: Db;
  let fake: FakePayPalExtras;
  let deps: PayoutDeps;

  beforeEach(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
    fake = new FakePayPalExtras({
      payouts: { merchantEmail: MERCHANT, unregisteredEmails: [UNREGISTERED], settlesAfterGets: 2 },
    });
    deps = { pool: pools.a, pp: moneyOut(fake.transport({ timeoutMs: 1_000 }), undefined) };
  }, 30_000);
  afterEach(async () => {
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
  const inFlight = async () =>
    Number(
      (
        await q<{ b: string }>(
          `SELECT coalesce(sum(balance_micros), 0)::bigint AS b FROM ledger_accounts WHERE kind = 'PAYOUTS_IN_FLIGHT'`,
        )
      )[0]!.b,
    );
  const item = async (publisherId: string) =>
    (
      await q<{
        id: string;
        batch_id: string;
        status: string;
        fee_cents: number | null;
        paypal_item_id: string | null;
        error_code: string | null;
      }>(`SELECT * FROM payout_items WHERE publisher_id = $1 ORDER BY created_at DESC LIMIT 1`, [
        publisherId,
      ])
    )[0]!;
  const batchStatus = async (id: string) =>
    (await q<{ status: string }>(`SELECT status FROM payout_batches WHERE id = $1`, [id]))[0]!
      .status;
  const txnCount = async (key: string) =>
    Number(
      (
        await q<{ n: string }>(`SELECT count(*) AS n FROM ledger_txns WHERE idempotency_key = $1`, [
          key,
        ])
      )[0]!.n,
    );
  const expectLedgerOk = async () => expect((await ledgerCheck(pools.a)).mismatches).toEqual([]);

  /** Charge, run, and return the PENDING batch id. */
  async function runFor(...publishers: string[]): Promise<string> {
    for (const p of publishers) await charge(p, 15_000_000); // $12.00 payable each
    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, { ...deps, retryDelayMs: 0 });
    expect(res.outcome).toBe('PENDING');
    return res.batchId!;
  }

  /** Make the batch look submitted `minutes` ago (audit rows are append-only: add an older one). */
  async function submittedAgo(batchId: string, minutes: number): Promise<void> {
    await pools.a.query(
      `INSERT INTO audit_events (at, actor_type, actor_id, entity, entity_id, action)
       SELECT now() - make_interval(mins => $2), 'WORKFLOW', 'test', 'payout_item', id, 'PAYOUT_SENT'
       FROM payout_items WHERE batch_id = $1`,
      [batchId, minutes],
    );
  }

  test('sandbox shape: run → PENDING → PROCESSING → SUCCESS; settled once, fee stored, in-flight 0', async () => {
    const a = await newPublisher();
    const batchId = await runFor(a);
    expect(await inFlight()).toBe(12_000_000);

    const listener = await pools.b.connect();
    const events: string[] = [];
    listener.on('notification', (m) => events.push(m.payload ?? ''));
    await listener.query(`LISTEN ${PUBLISHER_EVENTS_CHANNEL}`);
    try {
      // GET 1: PENDING. GET 2: PROCESSING. GET 3: settled.
      let r = (await pollRecentBatches(deps))[0]!;
      expect(r.paypalStatus).toBe('PENDING');
      expect(await batchStatus(batchId)).toBe('PENDING');
      r = (await pollRecentBatches(deps))[0]!;
      expect(r.paypalStatus).toBe('PROCESSING');
      expect(await batchStatus(batchId)).toBe('PROCESSING');
      r = (await pollRecentBatches(deps))[0]!;
      expect(r.paypalStatus).toBe('SUCCESS');
      expect(r.batchStatus).toBe('SUCCESS');
      await new Promise((res) => setTimeout(res, 100));
    } finally {
      await listener.query('UNLISTEN *');
      listener.release();
    }

    const it = await item(a);
    expect(it).toMatchObject({ status: 'SUCCESS', fee_cents: 25 });
    expect(it.paypal_item_id).toBeTruthy();
    expect(await txnCount(`payout_settled:${it.id}`)).toBe(1);
    expect(await inFlight()).toBe(0);
    expect(await payable(a)).toBe(0);
    await expectLedgerOk();

    const [aud] = await q<{ paypal_id: string; data: { paypalBatchId: string } }>(
      `SELECT paypal_id, data FROM audit_events WHERE action = 'PAYOUT_SETTLED' AND entity_id = $1`,
      [it.id],
    );
    expect(aud!.paypal_id).toBe(it.paypal_item_id);
    expect(aud!.data.paypalBatchId).toBeTruthy();
    expect(events.map((e) => JSON.parse(e))).toContainEqual(
      expect.objectContaining({ type: 'payout.updated', publisherId: a, ids: [batchId] }),
    );

    // Out of the 30-min window's statuses: nothing left to poll.
    expect(await pollRecentBatches(deps)).toEqual([]);
  });

  test('applying the same status twice posts one ledger txn', async () => {
    const a = await newPublisher();
    await runFor(a);
    const it = await item(a);
    const update = { itemId: it.id, paypalStatus: 'SUCCESS', paypalItemId: 'PPI1', feeCents: 25 };
    const first = await applyItemStatus(pools.a, update);
    const second = await applyItemStatus(pools.a, update);
    expect(first.changed).toBe(true);
    expect(second).toMatchObject({ changed: false, status: 'SUCCESS' });
    expect(await txnCount(`payout_settled:${it.id}`)).toBe(1);
    // A late refusal on a settled item never returns money.
    await applyItemStatus(pools.a, { itemId: it.id, paypalStatus: 'RETURNED' });
    expect(await txnCount(`payout_returned:${it.id}`)).toBe(0);
    await expectLedgerOk();
  });

  test('race: poller and a webhook apply SUCCESS for the same item at once → one PAYOUT_SETTLED', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await newPublisher();
      const batchId = await runFor(a);
      const paypalBatchId = (
        await q<{ p: string }>(`SELECT paypal_batch_id AS p FROM payout_batches WHERE id = $1`, [
          batchId,
        ])
      )[0]!.p;
      fake.payouts.settleBatch(paypalBatchId);
      const [ppItem] = fake.payouts.itemsOf(paypalBatchId);
      const it = await item(a);

      // The webhook resource (PAYMENT.PAYOUTS-ITEM.SUCCEEDED) as SP-059 would apply it, on the
      // other pool (another API process).
      const webhook = {
        payout_item_id: ppItem!.id,
        transaction_status: 'SUCCESS',
        payout_batch_id: paypalBatchId,
        payout_item_fee: { currency: 'USD', value: '0.25' },
        payout_item: { sender_item_id: it.id },
      };
      const fromWebhook = () =>
        applyItemStatus(pools.b, {
          itemId: webhook.payout_item.sender_item_id,
          paypalStatus: webhook.transaction_status,
          paypalItemId: webhook.payout_item_id,
          feeCents: 25,
          paypalBatchId: webhook.payout_batch_id,
          actorType: 'PAYPAL_WEBHOOK',
          actorId: 'WH-test',
        });
      const results = await Promise.all([
        pollBatch(deps, batchId),
        fromWebhook(),
        pollBatch(deps, batchId),
        fromWebhook(),
      ]);
      const changed = [results[0]!.applied, [results[1]], results[2]!.applied, [results[3]]]
        .flat()
        .filter((r) => r?.changed);
      expect(changed).toHaveLength(1);
      expect(await txnCount(`payout_settled:${it.id}`)).toBe(1);
      expect((await item(a)).status).toBe('SUCCESS');
      expect(await batchStatus(batchId)).toBe('SUCCESS');
    }
    expect(await inFlight()).toBe(0);
    await expectLedgerOk();
  });

  test('UNCLAIMED stays in flight with an alert; claimed later → one PAYOUT_SETTLED via the daily poll', async () => {
    const u = await newPublisher(UNREGISTERED);
    const batchId = await runFor(u);
    for (let i = 0; i < 3; i++) await pollRecentBatches(deps);

    const it = await item(u);
    expect(it).toMatchObject({ status: 'UNCLAIMED', error_code: 'RECEIVER_UNREGISTERED' });
    expect(await batchStatus(batchId)).toBe('PROCESSING');
    expect(await inFlight()).toBe(12_000_000);
    const [alert] = await q<{ data: { message: string; code: string } }>(
      `SELECT data FROM audit_events WHERE action = $1 AND entity_id = $2`,
      [PAYOUT_ALERT, it.id],
    );
    expect(alert!.data.code).toBe('RECEIVER_UNREGISTERED');
    expect(alert!.data.message).toContain('Claim it with nobody-yet@…');
    expect(alert!.data.message).not.toContain('payee.example');
    await expectLedgerOk();

    // SP-020: a publisher with an UNCLAIMED item is skipped.
    await charge(u, 15_000_000);
    expect((await payoutRun({ trigger: 'MANUAL_DEMO' }, deps)).outcome).toBe('NO_ITEMS');

    // The receiver signs up and claims; the daily job (after the 30-min window) picks it up.
    fake.claimPayout(it.paypal_item_id!);
    expect(await pollStaleBatches(deps)).toEqual([]); // still inside the 30-min window
    await submittedAgo(batchId, 45);
    const [r] = await pollStaleBatches(deps);
    expect(r!.applied.filter((x) => x.changed)).toHaveLength(1);
    expect((await item(u)).status).toBe('SUCCESS');
    expect(await batchStatus(batchId)).toBe('SUCCESS');
    expect(await txnCount(`payout_settled:${it.id}`)).toBe(1);
    await pollStaleBatches(deps);
    expect(await txnCount(`payout_settled:${it.id}`)).toBe(1);
    expect(await inFlight()).toBe(0);
    await expectLedgerOk();
  });

  test('UNCLAIMED → RETURNED (30 days) posts one PAYOUT_RETURNED; the publisher is eligible again', async () => {
    const u = await newPublisher(UNREGISTERED);
    const batchId = await runFor(u);
    for (let i = 0; i < 3; i++) await pollRecentBatches(deps);
    const it = await item(u);
    expect(it.status).toBe('UNCLAIMED');

    fake.returnPayout(it.paypal_item_id!);
    await submittedAgo(batchId, 60 * 24 * 30);
    await pollStaleBatches(deps);
    await pollStaleBatches(deps);
    expect((await item(u)).status).toBe('RETURNED');
    expect(await batchStatus(batchId)).toBe('DENIED');
    expect(await txnCount(`payout_returned:${it.id}`)).toBe(1);
    expect(await payable(u)).toBe(12_000_000);
    expect(await inFlight()).toBe(0);
    await expectLedgerOk();

    const next = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps);
    expect(next.outcome).toBe('PENDING');
    expect(next.batchId).not.toBe(batchId);
    expect(await payable(u)).toBe(0);
  });

  test('FAILED item (SELF_PAY_NOT_ALLOWED) → payable restored, mixed batch PARTIAL', async () => {
    const ok = await newPublisher();
    const self = await newPublisher(MERCHANT);
    const batchId = await runFor(ok, self);
    for (let i = 0; i < 3; i++) await pollRecentBatches(deps);
    expect((await item(self)).status).toBe('FAILED');
    expect((await item(self)).error_code).toBe('SELF_PAY_NOT_ALLOWED');
    expect((await item(ok)).status).toBe('SUCCESS');
    expect(await batchStatus(batchId)).toBe('PARTIAL');
    expect(await payable(self)).toBe(12_000_000);
    expect(await inFlight()).toBe(0);
    await expectLedgerOk();
  });

  test('an item SP-020 already returned on a 4xx is not returned again by the poller', async () => {
    const a = await newPublisher();
    await charge(a, 15_000_000);
    fake.payouts.insufficientFundsNext();
    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, { ...deps, retryDelayMs: 0 });
    expect(res.outcome).toBe('FAILED');
    const it = await item(a);
    const out = await applyItemStatus(pools.a, { itemId: it.id, paypalStatus: 'FAILED' });
    expect(out.changed).toBe(false);
    expect(await txnCount(`payout_returned:${it.id}`)).toBe(1);
    await expectLedgerOk();
  });

  test('reconcile a needs_reconcile batch: wrong PayPal id refused, right one → PENDING and polled', async () => {
    const a = await newPublisher();
    const batchId = await runFor(a);
    const paypalBatchId = fake.payouts.batchBySenderId(batchId)!.id;
    // SP-020's duplicate-without-id outcome: SUBMITTED, no paypal_batch_id, needs_reconcile.
    await pools.a.query(
      `UPDATE payout_batches SET status = 'SUBMITTED', paypal_batch_id = NULL, needs_reconcile = true
       WHERE id = $1`,
      [batchId],
    );

    const other = await newPublisher();
    const otherBatch = await runFor(other);
    const otherPaypal = fake.payouts.batchBySenderId(otherBatch)!.id;
    await expect(reconcileBatch(deps, batchId, otherPaypal, a)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(reconcileBatch(deps, batchId, 'NOPE123', a)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    fake.payouts.settleBatch(paypalBatchId);
    const r = await reconcileBatch(deps, batchId, paypalBatchId, a);
    expect(r.batchStatus).toBe('SUCCESS');
    const [b] = await q<{ status: string; paypal_batch_id: string; needs_reconcile: boolean }>(
      `SELECT * FROM payout_batches WHERE id = $1`,
      [batchId],
    );
    expect(b).toMatchObject({
      status: 'SUCCESS',
      paypal_batch_id: paypalBatchId,
      needs_reconcile: false,
    });
    // Idempotent: a second call with the same id re-polls, posts nothing new.
    await reconcileBatch(deps, batchId, paypalBatchId, a);
    expect(await txnCount(`payout_settled:${(await item(a)).id}`)).toBe(1);
    // A batch that isn't waiting for reconcile is refused.
    await expect(reconcileBatch(deps, otherBatch, paypalBatchId, a)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    await expectLedgerOk();
  });

  test('a PayPal error on one batch does not stop the others', async () => {
    const a = await newPublisher();
    const b = await newPublisher();
    const first = await runFor(a);
    const second = await runFor(b);
    await pools.a.query(`UPDATE payout_batches SET paypal_batch_id = 'MISSING1' WHERE id = $1`, [
      first,
    ]);
    const errors: string[] = [];
    const results = await pollRecentBatches(deps, (msg) => errors.push(msg));
    expect(results.map((r) => r.batchId)).toEqual([second]);
    expect(errors).toHaveLength(1);
  });
});
