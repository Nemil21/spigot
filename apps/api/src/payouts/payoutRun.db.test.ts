import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { tryAdvisoryLock } from '../db/locks.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { transition } from '../db/transition.js';
import { createDb, type Db } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, payoutReturnedEntries, topupEntries } from '../ledger/postings.js';
import { FakePayPal } from '../paypal/fake/core.js';
import { FakePayPalExtras } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import type { PayPalTransport } from '../paypal/transport.js';
import { buildBatch } from './buildBatch.js';
import { payoutRun, PAYOUT_LOCK, type PayoutRunDeps } from './payoutRun.js';
import { INSUFFICIENT_FUNDS_ALERT, PAYOUT_ALERT, type PayoutsClient } from './submit.js';

/** SP-020 acceptance, race and idempotency tests on FakePayPal (`*.db.test.ts`, CI's db job). */

const MERCHANT = 'merchant@spigot.example';

describe.skipIf(!testDatabaseUrl)('payoutRun', { timeout: 30_000 }, () => {
  let pools: TwoPools;
  let db: Db;
  let fake: FakePayPalExtras;

  beforeEach(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
    fake = new FakePayPalExtras({ payouts: { merchantEmail: MERCHANT } });
  }, 30_000);
  afterEach(async () => {
    await pools?.close();
  }, 30_000);

  const ppOver = (http: PayPalTransport): PayoutsClient => moneyOut(http, undefined);
  const deps = (over: Partial<PayoutRunDeps> = {}): PayoutRunDeps => ({
    pool: pools.a,
    pp: ppOver(fake.transport({ timeoutMs: 100 })),
    retryDelayMs: 0,
    ...over,
  });

  async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await pools.a.query(sql, params)).rows as T[];
  }

  async function newPublisher(opts: { email?: string; thresholdCents?: number } = {}) {
    const [row] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email, payout_threshold_cents)
       VALUES ('Pub', $1, $2, $3) RETURNING id`,
      [
        `${randomUUID()}@pub.example`,
        opts.email ?? `${randomUUID()}@payee.example`,
        opts.thresholdCents ?? 1000,
      ],
    );
    return row!.id;
  }

  /** One charged API call of `priceMicros` (20% commission) returning `records` records. */
  async function charge(publisherId: string, priceMicros: number, records = 1000): Promise<void> {
    await db.tx(async (tx) => {
      const platform = await platformAccounts(tx);
      const [b] = (await tx.query(`INSERT INTO buyers (name) VALUES ('B') RETURNING id`)).rows;
      const [k] = (
        await tx.query(
          `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'sk_test', $2) RETURNING id`,
          [b.id, randomUUID()],
        )
      ).rows;
      const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', b.id);
      const publisher = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', publisherId);
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, priceMicros),
      });
      const callId = randomUUID();
      const charged = await post(tx, {
        kind: 'CHARGE',
        idempotencyKey: `charge:${callId}`,
        refType: 'api_call',
        refId: callId,
        entries: chargeEntries(
          { buyer, publisher, platformRevenue: platform.platformRevenue },
          priceMicros,
          2000,
        ),
      });
      await tx.query(
        `INSERT INTO api_calls (id, buyer_id, api_key_id, channel, idempotency_key, status,
                                records_returned, price_micros, commission_bps, charge_txn_id)
         VALUES ($1, $2, $3, 'REST', $4, 'CHARGED', $5, $6, 2000, $7)`,
        [callId, b.id, k.id, callId, records, priceMicros, charged.txn.id],
      );
    });
  }

  async function payable(publisherId: string): Promise<number> {
    const [r] = await q<{ b: number }>(
      `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'PUBLISHER_PAYABLE' AND owner_id = $1`,
      [publisherId],
    );
    return r?.b ?? 0;
  }
  async function inFlight(): Promise<number> {
    const [r] = await q<{ b: number }>(
      `SELECT coalesce(sum(balance_micros), 0)::bigint AS b FROM ledger_accounts WHERE kind = 'PAYOUTS_IN_FLIGHT'`,
    );
    return r!.b;
  }
  const batches = () =>
    q<{
      id: string;
      status: string;
      paypal_batch_id: string | null;
      needs_reconcile: boolean;
      total_cents: number;
      item_count: number;
    }>(`SELECT * FROM payout_batches ORDER BY created_at`);
  const items = (batchId?: string) =>
    q<{
      id: string;
      publisher_id: string;
      status: string;
      net_cents: number;
      error_code: string | null;
      receiver_email: string;
      gross_micros: number;
      commission_micros: number;
      ledger_txn_id: string;
    }>(
      `SELECT * FROM payout_items ${batchId ? 'WHERE batch_id = $1' : ''} ORDER BY created_at`,
      batchId ? [batchId] : [],
    );
  const alerts = () =>
    q<{ entity_id: string; data: { code: string; message: string } }>(
      `SELECT entity_id, data FROM audit_events WHERE action = $1 ORDER BY id`,
      [PAYOUT_ALERT],
    );
  async function expectLedgerOk() {
    expect((await ledgerCheck(pools.a)).mismatches).toEqual([]);
  }
  async function expectLockFree() {
    const lock = await tryAdvisoryLock(pools.b, PAYOUT_LOCK);
    expect(lock).not.toBeNull();
    await lock!.release();
  }

  test('after charges: one batch, one item per eligible publisher, net = floor(payable / 10,000), remainder stays', async () => {
    const a = await newPublisher();
    const b = await newPublisher();
    const small = await newPublisher();
    await charge(a, 15_000_123, 8_112); // payable 12,000,099 → $12.00, 99 micros left
    await charge(b, 20_000_000, 500);
    await charge(b, 10_000_000, 250); // payable 24,000,000 → $24.00
    await charge(small, 5_000_000); // $4.00 < $10 threshold

    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res.outcome).toBe('PENDING');
    if (res.outcome !== 'PENDING') return;

    const [batch] = await batches();
    expect(batch).toMatchObject({
      id: res.batchId,
      status: 'PENDING',
      paypal_batch_id: res.paypalBatchId,
      item_count: 2,
      total_cents: 3_600,
    });
    const rows = await items(res.batchId);
    expect(rows).toHaveLength(2);
    const byPub = Object.fromEntries(rows.map((r) => [r.publisher_id, r]));
    expect(byPub[a]).toMatchObject({
      net_cents: 1_200,
      status: 'PENDING',
      gross_micros: 15_000_123,
      commission_micros: 3_000_024,
    });
    expect(byPub[b]).toMatchObject({
      net_cents: 2_400,
      gross_micros: 30_000_000,
      commission_micros: 6_000_000,
    });
    expect(byPub[small]).toBeUndefined();
    expect(await payable(a)).toBe(99);
    expect(await payable(b)).toBe(0);
    expect(await payable(small)).toBe(4_000_000);
    expect(await inFlight()).toBe(36_000_000);

    // PAYOUT_SENT per item, keyed payout_item:<id>.
    const txns = await q<{ idempotency_key: string; kind: string }>(
      `SELECT idempotency_key, kind FROM ledger_txns WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.ledger_txn_id)],
    );
    expect(txns.map((t) => t.kind)).toEqual(['PAYOUT_SENT', 'PAYOUT_SENT']);
    expect(txns.map((t) => t.idempotency_key).sort()).toEqual(
      rows.map((r) => `payout_item:${r.id}`).sort(),
    );

    // PayPal got sender_batch_id = batch id, sender_item_id = item id, the subject and the note.
    const sent = fake.payouts.batchBySenderId(res.batchId)!;
    expect(sent.id).toBe(res.paypalBatchId);
    expect(sent.emailSubject).toBe('Your Spigot earnings');
    const sentItems = fake.payouts.itemsOf(sent.id);
    expect(sentItems.map((i) => i.senderItemId).sort()).toEqual(rows.map((r) => r.id).sort());
    const noteA = sentItems.find((i) => i.senderItemId === byPub[a]!.id)!.note!;
    expect(noteA).toMatch(/^Spigot: 8,112 records sold, [A-Z][a-z]{2} \d+/);
    expect(sentItems.find((i) => i.senderItemId === byPub[b]!.id)!.note).toMatch(
      /^Spigot: 750 records sold/,
    );
    expect(
      fake.calls.filter((c) => c.op === 'payout').every((c) => c.requestId === res.batchId),
    ).toBe(true);

    const audits = await q(`SELECT entity_id FROM audit_events WHERE action = 'PAYOUT_SENT'`);
    expect(audits).toHaveLength(2);
    await expectLedgerOk();
    await expectLockFree();
  });

  test('a second immediate run creates no items', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    expect((await payoutRun('MANUAL_DEMO', {}, deps())).outcome).toBe('PENDING');
    await charge(a, 20_000_000); // more earnings, but the PENDING item blocks the publisher
    const second = await payoutRun('MANUAL_DEMO', {}, deps());
    expect(second.outcome).toBe('NO_ITEMS');
    expect(await batches()).toHaveLength(1);
    expect(await items()).toHaveLength(1);
    expect(fake.payouts.batchesCreated).toBe(1);
  });

  test('demo threshold override (min $1, MANUAL_DEMO only)', async () => {
    const four = await newPublisher();
    const cents80 = await newPublisher();
    await charge(four, 5_000_000); // $4.00
    await charge(cents80, 1_000_000); // $0.80
    await expect(
      payoutRun({ trigger: 'SCHEDULE', thresholdCentsOverride: 100 }, deps()),
    ).rejects.toThrow(/MANUAL_DEMO/);
    const res = await payoutRun('MANUAL_DEMO', { thresholdCentsOverride: 50 }, deps()); // clamped to $1
    expect(res.outcome).toBe('PENDING');
    const rows = await items();
    expect(rows.map((r) => r.publisher_id)).toEqual([four]);
    expect(rows[0]!.net_cents).toBe(400);
    await expectLockFree();
  });

  test('race: two payoutRun in parallel on two pools → one batch, one item per publisher', async () => {
    fake.latencyMs = 20;
    const pubs = [await newPublisher(), await newPublisher(), await newPublisher()];
    for (const p of pubs) await charge(p, 15_000_000);
    const results = await Promise.all([
      payoutRun({ trigger: 'MANUAL_DEMO' }, deps({ pool: pools.a })),
      payoutRun({ trigger: 'MANUAL_DEMO' }, deps({ pool: pools.b })),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['NO_ITEMS', 'PENDING']);
    expect(await batches()).toHaveLength(1);
    const rows = await items();
    expect(rows.map((r) => r.publisher_id).sort()).toEqual([...pubs].sort());
    expect(fake.payouts.batchesCreated).toBe(1);
    await expectLedgerOk();
  });

  test('crash after PAYOUT_SENT, before the PayPal call → next run resubmits the same sender_batch_id; one payout', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    // The "crashed" run: the batch is built and committed, then the process dies.
    const client = await pools.a.connect();
    const built = await buildBatch(client, { trigger: 'MANUAL_DEMO' }).finally(() =>
      client.release(),
    );
    expect(built.kind).toBe('BUILT');
    if (built.kind !== 'BUILT') return;
    expect((await batches())[0]!.status).toBe('BUILDING');
    expect(await payable(a)).toBe(0);

    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res).toMatchObject({ outcome: 'PENDING', resumed: true, batchId: built.batchId });
    expect(fake.payouts.batchesCreated).toBe(1);
    expect(fake.payouts.batchBySenderId(built.batchId)).toBeDefined();
    expect(await items()).toHaveLength(1);
    expect((await payoutRun({ trigger: 'MANUAL_DEMO' }, deps())).outcome).toBe('NO_ITEMS');
    await expectLedgerOk();
  });

  test('crash after SUBMITTED, after PayPal accepted, before the response → duplicate without id → needs_reconcile, no second payout', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    const real = ppOver(fake.transport());
    const crashing: PayoutsClient = {
      async payout(input) {
        await real.payout(input); // PayPal creates the batch…
        throw new Error('process crashed'); // …and we die before saving the answer.
      },
    };
    await expect(payoutRun({ trigger: 'MANUAL_DEMO' }, deps({ pp: crashing }))).rejects.toThrow(
      'process crashed',
    );
    const [crashed] = await batches();
    expect(crashed).toMatchObject({
      status: 'SUBMITTED',
      paypal_batch_id: null,
      needs_reconcile: false,
    });
    await expectLockFree();

    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res).toMatchObject({
      outcome: 'NEEDS_RECONCILE',
      resumed: true,
      batchId: crashed!.id,
      errorCode: 'USER_BUSINESS_ERROR',
    });
    expect(await batches()).toEqual([
      expect.objectContaining({ id: crashed!.id, status: 'SUBMITTED', needs_reconcile: true }),
    ]);
    expect((await items()).map((i) => i.status)).toEqual(['PENDING']);
    expect(await inFlight()).toBe(16_000_000); // money in flight, not returned
    expect(await payable(a)).toBe(0);
    expect(await alerts()).toEqual([expect.objectContaining({ entity_id: crashed!.id })]);
    expect(fake.payouts.batchesCreated).toBe(1);

    // A later run neither resubmits the reconcile batch nor pays the publisher again.
    expect((await payoutRun({ trigger: 'MANUAL_DEMO' }, deps())).outcome).toBe('NO_ITEMS');
    expect(fake.calls.filter((c) => c.op === 'payout')).toHaveLength(2);
    expect(fake.payouts.batchesCreated).toBe(1);
    await expectLedgerOk();
  });

  test('crash after SUBMITTED, before PayPal saw the call → next run resubmits the same id → 201 PENDING', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    const dead: PayoutsClient = {
      payout: () => Promise.reject(new Error('process crashed')),
    };
    await expect(payoutRun({ trigger: 'MANUAL_DEMO' }, deps({ pp: dead }))).rejects.toThrow();
    const [crashed] = await batches();
    expect(crashed!.status).toBe('SUBMITTED');

    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res).toMatchObject({ outcome: 'PENDING', resumed: true, batchId: crashed!.id });
    expect(fake.payouts.batchBySenderId(crashed!.id)?.id).toBe(
      (await batches())[0]!.paypal_batch_id,
    );
    expect(fake.payouts.batchesCreated).toBe(1);
  });

  test('response lost after PayPal accepted → retry with the same sender_batch_id → no second payout; batch PENDING', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    fake.failNext('payout', { kind: 'drop_response' });
    // PayPal's duplicate error carrying the payout_batch_id (the shape SP-001c reads, if PayPal sends it).
    const inner = fake.transport({ timeoutMs: 100 });
    const withId: PayPalTransport = {
      async request(call, method, path, opts) {
        const res = await inner.request(call, method, path, opts);
        const senderId = (opts?.body as { sender_batch_header?: { sender_batch_id?: string } })
          ?.sender_batch_header?.sender_batch_id;
        const existing = senderId ? fake.payouts.batchBySenderId(senderId) : undefined;
        if (res.http === 400 && existing)
          res.json = { ...res.json, batch_header: { payout_batch_id: existing.id } };
        return res;
      },
    };
    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps({ pp: ppOver(withId) }));
    expect(res.outcome).toBe('PENDING');
    const [batch] = await batches();
    expect(batch).toMatchObject({ status: 'PENDING', needs_reconcile: false });
    expect(batch!.paypal_batch_id).toBe(fake.payouts.batchBySenderId(batch!.id)!.id);
    expect(fake.calls.filter((c) => c.op === 'payout').map((c) => c.requestId)).toEqual([
      batch!.id,
      batch!.id,
    ]);
    expect(fake.payouts.batchesCreated).toBe(1);
    await expectLedgerOk();
  });

  test('response lost, and the duplicate has no batch id (S10) → needs_reconcile within the same run', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    fake.failNext('payout', { kind: 'drop_response' });
    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res.outcome).toBe('NEEDS_RECONCILE');
    expect((await batches())[0]).toMatchObject({ status: 'SUBMITTED', needs_reconcile: true });
    expect(fake.payouts.batchesCreated).toBe(1);
    expect(await inFlight()).toBe(16_000_000);
  });

  test('network / 5xx → 3 tries with the same id; still failing → SUBMITTED, resumed next run', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    fake.failNext('payout', { kind: 'status', http: 503 }, 3);
    const first = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(first).toMatchObject({ outcome: 'RETRY_LATER' });
    expect((await batches())[0]!.status).toBe('SUBMITTED');
    expect(fake.calls.filter((c) => c.op === 'payout')).toHaveLength(3);
    await expectLockFree();

    fake.failNext('payout', { kind: 'status', http: 500 }, 1);
    const second = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(second).toMatchObject({ outcome: 'PENDING', resumed: true, batchId: first.batchId });
    const ids = new Set(fake.calls.filter((c) => c.op === 'payout').map((c) => c.requestId));
    expect([...ids]).toEqual([first.batchId]);
    expect(fake.payouts.batchesCreated).toBe(1);
  });

  test('INSUFFICIENT_FUNDS → payable restored, items + batch FAILED, alert, ledger check passes; next run builds a new batch', async () => {
    const a = await newPublisher();
    const b = await newPublisher();
    await charge(a, 20_000_123);
    await charge(b, 30_000_000);
    const before = [await payable(a), await payable(b)];
    fake.payouts.insufficientFundsNext();

    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res).toMatchObject({ outcome: 'FAILED', errorCode: 'INSUFFICIENT_FUNDS' });
    expect([await payable(a), await payable(b)]).toEqual(before);
    expect(await inFlight()).toBe(0);
    expect((await batches())[0]!.status).toBe('FAILED');
    const failed = await items();
    expect(failed.map((i) => [i.status, i.error_code])).toEqual([
      ['FAILED', 'INSUFFICIENT_FUNDS'],
      ['FAILED', 'INSUFFICIENT_FUNDS'],
    ]);
    expect(await alerts()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'INSUFFICIENT_FUNDS',
          message: INSUFFICIENT_FUNDS_ALERT,
        }),
      }),
    ]);
    const returned = await q<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM ledger_txns WHERE kind = 'PAYOUT_RETURNED'`,
    );
    expect(returned.map((r) => r.idempotency_key).sort()).toEqual(
      failed.map((i) => `payout_returned:${i.id}`).sort(),
    );
    expect(fake.payouts.batchesCreated).toBe(0);
    await expectLedgerOk();

    // SP-021's poller can't return the same item again: same key, and the item is no longer PENDING.
    await db.tx(async (tx) => {
      const platform = await platformAccounts(tx);
      const item = failed[0]!;
      expect(await transition(tx, 'payout_items', item.id, 'PENDING', 'FAILED')).toBeNull();
      const again = await post(tx, {
        kind: 'PAYOUT_RETURNED',
        idempotencyKey: `payout_returned:${item.id}`,
        entries: payoutReturnedEntries(
          {
            payoutsInFlight: platform.payoutsInFlight,
            publisher: await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', item.publisher_id),
          },
          item.net_cents * 10_000,
        ),
      });
      expect(again.replay).toBe(true);
    });
    expect([await payable(a), await payable(b)]).toEqual(before);

    const next = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(next.outcome).toBe('PENDING');
    expect(next.batchId).not.toBe(res.batchId);
    expect(await items(next.batchId!)).toHaveLength(2);
    await expectLedgerOk();
    await expectLockFree();
  });

  test('SELF_PAY_NOT_ALLOWED as a definite 4xx → returned to payable, error_code stored', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    fake.failNext('payout', {
      kind: 'status',
      http: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'SELF_PAY_NOT_ALLOWED' }] },
    });
    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res).toMatchObject({ outcome: 'FAILED', errorCode: 'SELF_PAY_NOT_ALLOWED' });
    expect((await items())[0]).toMatchObject({
      status: 'FAILED',
      error_code: 'SELF_PAY_NOT_ALLOWED',
    });
    expect(await payable(a)).toBe(16_000_000);
    expect((await alerts())[0]!.data.code).toBe('SELF_PAY_NOT_ALLOWED');
    await expectLedgerOk();
  });

  test('SELF_PAY_NOT_ALLOWED as PayPal really sends it (201, item FAILED later) → PENDING here; SP-021 settles it', async () => {
    const self = await newPublisher({ email: MERCHANT });
    await charge(self, 20_000_000);
    const res = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps());
    expect(res.outcome).toBe('PENDING');
    if (res.outcome !== 'PENDING') return;
    expect((await items())[0]).toMatchObject({ status: 'PENDING', receiver_email: MERCHANT });
    fake.payouts.settleBatch(res.paypalBatchId);
    expect(fake.payouts.batch(res.paypalBatchId)!.status).toBe('DENIED');
    expect(fake.payouts.itemsOf(res.paypalBatchId)[0]).toMatchObject({
      status: 'FAILED',
      errorName: 'SELF_PAY_NOT_ALLOWED',
    });
    expect(await inFlight()).toBe(16_000_000); // still in flight until SP-021's poller returns it
  });

  test('the advisory lock is released after a run that throws, too', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    const boom: PayoutsClient = { payout: () => Promise.reject(new Error('boom')) };
    await expect(payoutRun({ trigger: 'MANUAL_DEMO' }, deps({ pp: boom }))).rejects.toThrow('boom');
    await expectLockFree();
    const [r] = await q<{ n: number }>(
      // pg_locks is cluster-wide: count only this test database's locks (other test files and
      // worktrees share the Postgres server).
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    expect(r!.n).toBe(0);
  });

  test('SCHEDULE runs are unique per period_end', async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    const periodEnd = new Date(Date.now() - 1_000);
    expect((await payoutRun({ trigger: 'SCHEDULE', periodEnd }, deps())).outcome).toBe('PENDING');
    await charge(await newPublisher(), 20_000_000);
    expect((await payoutRun({ trigger: 'SCHEDULE', periodEnd }, deps())).outcome).toBe(
      'PERIOD_TAKEN',
    );
    expect(await batches()).toHaveLength(1);
  });

  test("SP-001b's PayPal client (PAYPAL_MODE=stub path) plugs in as `pp`", async () => {
    const a = await newPublisher();
    await charge(a, 20_000_000);
    const core = new FakePayPal();
    const res = await payoutRun('MANUAL_DEMO', {}, deps({ pp: core.client() }));
    expect(res.outcome).toBe('PENDING');
    expect(core.extras.payouts.batchBySenderId(res.batchId!)).toBeDefined();
  });

  test('needs deps', async () => {
    await expect(payoutRun({ trigger: 'MANUAL_DEMO' })).rejects.toThrow(/setPayoutRunDeps/);
  });
});
