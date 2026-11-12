import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parsePublisherEvent, PUBLISHER_EVENTS_CHANNEL } from '@spigot/shared';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { chargeAndRecord, simAuditSampled, type ChargeInput, type MeterContext } from './charge.js';

// The races serialize on one buyer row; on a loaded laptop (several workers) that can take a while.
describe.skipIf(!testDatabaseUrl)('chargeAndRecord', { timeout: 60_000 }, () => {
  let pools: TwoPools;
  let dbA: Db;
  let dbB: Db;

  beforeAll(async () => {
    pools = await twoPools();
    dbA = createDb(pools.a);
    dbB = createDb(pools.b);
  });
  afterAll(async () => {
    await pools?.close();
  });

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pools.a.query(sql, params)).rows as T[];

  interface World {
    publisherId: string;
    datasetId: string;
    buyerId: string;
    apiKeyId: string;
  }

  /** A publisher with one dataset, and a buyer with one API key and `balanceMicros` topped up. */
  async function world(
    opts: { balanceMicros?: number; simulated?: boolean; commissionBps?: number } = {},
  ) {
    const tag = randomUUID().slice(0, 8);
    const [pub] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email, commission_bps) VALUES ($1, $2, $2, $3) RETURNING id`,
      [`Pub ${tag}`, `pub-${tag}@example.com`, opts.commissionBps ?? 2000],
    );
    const [site] = await q<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
       VALUES ($1, $2, 'v', 'c', 'g') RETURNING id`,
      [pub!.id, `https://${tag}.example.com`],
    );
    const [ds] = await q<{ id: string }>(
      `INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'listings', 'Listing') RETURNING id`,
      [site!.id],
    );
    const [buyer] = await q<{ id: string }>(
      `INSERT INTO buyers (name, is_simulated) VALUES ($1, $2) RETURNING id`,
      [`Buyer ${tag}`, opts.simulated ?? false],
    );
    const [key] = await q<{ id: string }>(
      `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, $2, $3) RETURNING id`,
      [buyer!.id, tag, `hash-${randomUUID()}`],
    );
    const w: World = {
      publisherId: pub!.id,
      datasetId: ds!.id,
      buyerId: buyer!.id,
      apiKeyId: key!.id,
    };
    if (opts.balanceMicros) await topUp(w, opts.balanceMicros);
    return w;
  }

  async function topUp(w: World, micros: number) {
    await dbA.tx(async (tx) => {
      const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', w.buyerId);
      const { paypalCash } = await platformAccounts(tx);
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer, paypalCash }, micros),
      });
    });
  }

  const ctx = (w: World, db = dbA, extra: Partial<MeterContext> = {}): MeterContext => ({
    db,
    buyerId: w.buyerId,
    apiKeyId: w.apiKeyId,
    channel: 'REST',
    ...extra,
  });

  /** `count` records at $1.50 / 1,000 (1,500 micros each). */
  const input = (w: World, over: Partial<ChargeInput> = {}): ChargeInput => {
    const count = over.count ?? 2;
    const records = Array.from({ length: count }, (_, i) => ({
      key: `listings/${i}`,
      data: { i },
    }));
    return {
      dataset: { id: w.datasetId },
      endpoint: 'records.search',
      idempotencyKey: randomUUID(),
      request: { city: 'Austin', limit: 50 },
      body: { records, charged: { records: count, priceMicros: count * 1500 } },
      servedKeys: records.map((r) => ({ key: r.key, hash: `h${r.key}` })),
      unitPriceMicros: 1500,
      count,
      isSimulated: false,
      ...over,
    };
  };

  const balance = async (w: World) =>
    (
      await q<{ b: number }>(
        `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
        [w.buyerId],
      )
    )[0]?.b ?? 0;

  const chargeTxns = async (callId: string) =>
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_txns WHERE kind = 'CHARGE' AND ref_id = $1`,
        [callId],
      )
    )[0]!.n;

  const call = async (callId: string) =>
    (await q<Record<string, unknown>>(`SELECT * FROM api_calls WHERE id = $1`, [callId]))[0]!;

  test('charges once: CHARGED row, CHARGE txn split by commission, body stored, balance returned', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const res = await chargeAndRecord(ctx(w), input(w, { count: 3 }));
    expect(res).toMatchObject({
      status: 200,
      chargedMicros: 4500,
      balanceMicros: 995_500,
      replay: false,
    });
    const row = await call(res.callId);
    expect(row).toMatchObject({
      status: 'CHARGED',
      price_micros: 4500,
      unit_price_micros: 1500,
      records_returned: 3,
      commission_bps: 2000,
      http_status: 200,
      response_body: res.body,
    });
    expect(row.served_record_keys).toHaveLength(3);
    const entries = await q<{ kind: string; amount: number }>(
      `SELECT a.kind, e.amount_micros AS amount FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id WHERE e.txn_id = $1 ORDER BY a.kind`,
      [row.charge_txn_id],
    );
    expect(entries).toEqual([
      { kind: 'BUYER_BALANCE', amount: -4500 },
      { kind: 'PLATFORM_REVENUE', amount: 900 },
      { kind: 'PUBLISHER_PAYABLE', amount: 3600 },
    ]);
  });

  test('50 parallel identical calls with one key → one CHARGE, 49 replays of the same body', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const one = input(w, { count: 4 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => chargeAndRecord(ctx(w, i % 2 ? dbB : dbA), one)),
    );
    const fresh = results.filter((r) => !r.replay);
    expect(fresh).toHaveLength(1);
    expect(results.filter((r) => r.replay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.callId)).size).toBe(1);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual(one.body);
    }
    expect(await chargeTxns(fresh[0]!.callId)).toBe(1);
    expect(await balance(w)).toBe(1_000_000 - 6000);
  });

  test('50 parallel different calls on a $0.05 balance → ≤ $0.05 charged, the rest 402, never negative', async () => {
    const w = await world({ balanceMicros: 50_000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        chargeAndRecord(ctx(w, i % 2 ? dbB : dbA), input(w, { count: 1 })),
      ),
    );
    const charged = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 402);
    expect(charged.length + refused.length).toBe(50);
    // Every charge sees the balance left by the one before it: exactly floor(50,000 / 1,500).
    expect(charged).toHaveLength(33);
    const total = charged.reduce((s, r) => s + r.chargedMicros, 0);
    expect(total).toBeLessThanOrEqual(50_000);
    expect(await balance(w)).toBe(50_000 - total);
    const rows = await q<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM api_calls WHERE buyer_id = $1 GROUP BY status ORDER BY status`,
      [w.buyerId],
    );
    expect(rows).toEqual([
      { status: 'CHARGED', n: 33 },
      { status: 'PAYMENT_REQUIRED', n: 17 },
    ]);
    expect(await ledgerCheck(pools.a)).toMatchObject({ sumMicros: 0, mismatches: [] });
  });

  test('a forced exception after the query and before commit leaves no CHARGE and no CHARGED row', async () => {
    const w = await world({ balanceMicros: 100_000 });
    const crashing: Db = {
      pool: dbA.pool,
      tx: (fn) =>
        dbA.tx(async (tx) => {
          await fn(tx);
          throw new Error('crash before COMMIT');
        }),
    };
    const one = input(w);
    const charges = async () =>
      (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
           WHERE a.kind = 'BUYER_BALANCE' AND a.owner_id = $1 AND e.amount_micros < 0`,
          [w.buyerId],
        )
      )[0]!.n;
    const chargesBefore = await charges();
    await expect(chargeAndRecord(ctx(w, crashing), one)).rejects.toThrow('crash before COMMIT');
    expect(await q(`SELECT 1 FROM api_calls WHERE buyer_id = $1`, [w.buyerId])).toHaveLength(0);
    expect(await charges()).toBe(chargesBefore);
    expect(await balance(w)).toBe(100_000);
    // The client retries with the same key: charged once.
    const res = await chargeAndRecord(ctx(w), one);
    expect(res).toMatchObject({ status: 200, replay: false, chargedMicros: 3000 });
    expect(await balance(w)).toBe(97_000);
  });

  test('same key, different request → 409 IDEMPOTENCY_MISMATCH, no new charge', async () => {
    const w = await world({ balanceMicros: 100_000 });
    const first = input(w);
    await chargeAndRecord(ctx(w), first);
    await expect(
      chargeAndRecord(ctx(w), { ...first, request: { city: 'Dallas', limit: 50 } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', status: 409 });
    // Another endpoint or dataset with the same key is a different request too.
    await expect(
      chargeAndRecord(ctx(w), { ...first, endpoint: 'changes.list' }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    });
    expect(await balance(w)).toBe(97_000);
  });

  test('zero records → 200, NOT_CHARGED, no ledger txn', async () => {
    const w = await world({ balanceMicros: 0 });
    const res = await chargeAndRecord(ctx(w), input(w, { count: 0 }));
    expect(res).toMatchObject({ status: 200, chargedMicros: 0, balanceMicros: 0, replay: false });
    expect(await call(res.callId)).toMatchObject({
      status: 'NOT_CHARGED',
      price_micros: 0,
      charge_txn_id: null,
      http_status: 200,
    });
    expect(await chargeTxns(res.callId)).toBe(0);
  });

  test('short balance → commits a PAYMENT_REQUIRED row with the 402 body and no ledger txn', async () => {
    const w = await world({ balanceMicros: 1000 });
    const res = await chargeAndRecord(ctx(w), input(w, { count: 2 }));
    expect(res).toMatchObject({
      status: 402,
      chargedMicros: 0,
      balanceMicros: 1000,
      replay: false,
    });
    expect(res.body).toMatchObject({
      error: { code: 'INSUFFICIENT_BALANCE' },
      quote: { records: 2, priceMicros: 3000 },
      balanceMicros: 1000,
    });
    expect(await call(res.callId)).toMatchObject({
      status: 'PAYMENT_REQUIRED',
      http_status: 402,
      response_body: res.body,
      charge_txn_id: null,
      price_micros: 0,
    });
    expect(await chargeTxns(res.callId)).toBe(0);
    expect(await balance(w)).toBe(1000);
  });

  test('a caller-built 402 body (SP-017a contract) is stored as is', async () => {
    const w = await world();
    const res = await chargeAndRecord(
      ctx(w),
      input(w, {
        paymentRequiredBody: (quote) => ({
          error: { code: 'INSUFFICIENT_BALANCE' },
          site: 'X',
          quote,
        }),
      }),
    );
    expect(res.body).toEqual({
      error: { code: 'INSUFFICIENT_BALANCE' },
      site: 'X',
      quote: { priceMicros: 3000, balanceMicros: 0, count: 2 },
    });
    expect((await call(res.callId)).response_body).toEqual(res.body);
  });

  test('402 → top-up → retry with the same key → 200, charged once; the row moves PAYMENT_REQUIRED → CHARGED', async () => {
    const w = await world({ balanceMicros: 1000 });
    const one = input(w);
    const refused = await chargeAndRecord(ctx(w), one);
    expect(refused.status).toBe(402);
    await topUp(w, 10_000);
    const ok = await chargeAndRecord(ctx(w), one);
    expect(ok).toMatchObject({
      status: 200,
      replay: false,
      chargedMicros: 3000,
      balanceMicros: 8000,
    });
    expect(ok.callId).toBe(refused.callId);
    expect(await call(ok.callId)).toMatchObject({
      status: 'CHARGED',
      price_micros: 3000,
      http_status: 200,
    });
    expect(await chargeTxns(ok.callId)).toBe(1);
    // And now it replays.
    const again = await chargeAndRecord(ctx(w), one);
    expect(again).toMatchObject({
      status: 200,
      replay: true,
      chargedMicros: 0,
      balanceMicros: 8000,
    });
    expect(again.body).toEqual(one.body);
  });

  test('a 402 retried without a top-up stays 402 and still has no ledger txn', async () => {
    const w = await world({ balanceMicros: 1000 });
    const one = input(w);
    const a = await chargeAndRecord(ctx(w), one);
    const b = await chargeAndRecord(ctx(w), one);
    expect([a.status, b.status]).toEqual([402, 402]);
    expect(b.callId).toBe(a.callId);
    expect(await chargeTxns(a.callId)).toBe(0);
  });

  test('two retries of the same PAYMENT_REQUIRED key racing after a top-up → one CHARGE, the other replays', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world({ balanceMicros: 1000 });
      const one = input(w);
      const refused = await chargeAndRecord(ctx(w), one);
      expect(refused.status).toBe(402);
      await topUp(w, 100_000);
      const [x, y] = await Promise.all([
        chargeAndRecord(ctx(w, dbA), one),
        chargeAndRecord(ctx(w, dbB), one),
      ]);
      expect([x!.status, y!.status]).toEqual([200, 200]);
      expect([x!.replay, y!.replay].sort()).toEqual([false, true]);
      expect(x!.body).toEqual(y!.body);
      expect(await chargeTxns(refused.callId)).toBe(1);
      expect(await balance(w)).toBe(98_000);
    }
  });

  test('client disconnects after commit and retries → replay of the stored body, no new charge', async () => {
    const w = await world({ balanceMicros: 100_000 });
    const one = input(w);
    const first = await chargeAndRecord(ctx(w), one);
    // The response never reached the client; the retry carries the same key and request.
    const retry = await chargeAndRecord(ctx(w, dbB), {
      ...one,
      body: { different: 'rebuilt body' },
    });
    expect(retry).toMatchObject({
      status: 200,
      replay: true,
      chargedMicros: 0,
      callId: first.callId,
    });
    expect(retry.body).toEqual(one.body);
    expect(await chargeTxns(first.callId)).toBe(1);
    expect(await balance(w)).toBe(97_000);
  });

  test('replay of a CHARGED call whose body was purged → 409 IDEMPOTENCY_KEY_EXPIRED, no ledger txn', async () => {
    const w = await world({ balanceMicros: 100_000 });
    const one = input(w);
    const first = await chargeAndRecord(ctx(w), one);
    await q(`UPDATE api_calls SET response_body = NULL WHERE id = $1`, [first.callId]);
    await expect(chargeAndRecord(ctx(w), one)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_EXPIRED',
      status: 409,
    });
    expect(await chargeTxns(first.callId)).toBe(1);
    expect(await balance(w)).toBe(97_000);
  });

  test('api_calls.commission_bps is the rate at charge time, even after it changes', async () => {
    const w = await world({ balanceMicros: 100_000, commissionBps: 1500 });
    const before = await chargeAndRecord(ctx(w), input(w));
    await q(`UPDATE publishers SET commission_bps = 3000 WHERE id = $1`, [w.publisherId]);
    const after = await chargeAndRecord(ctx(w), input(w));
    expect((await call(before.callId)).commission_bps).toBe(1500);
    expect((await call(after.callId)).commission_bps).toBe(3000);
    const revenue = await q<{ amount: number }>(
      `SELECT e.amount_micros AS amount FROM api_calls c JOIN ledger_entries e ON e.txn_id = c.charge_txn_id
       JOIN ledger_accounts a ON a.id = e.account_id AND a.kind = 'PLATFORM_REVENUE' WHERE c.id = $1`,
      [before.callId],
    );
    expect(revenue).toEqual([{ amount: 450 }]);
  });

  test('100 SIM charges audit the deterministic 1-in-20 sample; 100 real charges audit all 100', async () => {
    const sim = await world({ balanceMicros: 1_000_000, simulated: true });
    const real = await world({ balanceMicros: 1_000_000 });
    const hundred = (w: World, isSimulated: boolean) =>
      Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          chargeAndRecord(ctx(w, i % 2 ? dbB : dbA), input(w, { count: 1, isSimulated })),
        ),
      );
    const simIds = (await hundred(sim, true)).map((r) => r.callId);
    await hundred(real, false);
    const audited = async (w: World) =>
      (
        await q<{ id: string; actor: string }>(
          `SELECT entity_id AS id, actor_type AS actor FROM audit_events
           WHERE action = 'CALL_CHARGED' AND publisher_id = $1`,
          [w.publisherId],
        )
      ).map((r) => r.id);
    const simAudited = await audited(sim);
    expect(simAudited.sort()).toEqual(simIds.filter(simAuditSampled).sort());
    expect(simAudited.length).toBeLessThan(20);
    expect(await audited(real)).toHaveLength(100);
  });

  test('simulatedAt passes through to api_calls, the CHARGE txn and its audit row for a SIM buyer only', async () => {
    const sim = await world({ balanceMicros: 100_000, simulated: true });
    const at = new Date('2026-11-06T15:30:00Z');
    const res = await chargeAndRecord(ctx(sim), input(sim, { isSimulated: true, simulatedAt: at }));
    const row = await call(res.callId);
    expect(row).toMatchObject({ status: 'CHARGED', is_simulated: true, created_at: at });
    const [txn] = await q<{ created_at: Date; is_simulated: boolean }>(
      `SELECT created_at, is_simulated FROM ledger_txns WHERE id = $1`,
      [row.charge_txn_id],
    );
    expect(txn).toEqual({ created_at: at, is_simulated: true });

    const real = await world({ balanceMicros: 100_000 });
    await expect(
      chargeAndRecord(ctx(real), input(real, { isSimulated: true, simulatedAt: at })),
    ).rejects.toThrow(/is_simulated buyer/);
    await expect(chargeAndRecord(ctx(real), input(real, { simulatedAt: at }))).rejects.toThrow(
      TypeError,
    );
    expect(await q(`SELECT 1 FROM api_calls WHERE buyer_id = $1`, [real.buyerId])).toHaveLength(0);
  });

  test('no Idempotency-Key: the auto key replays within the minute and charges again in the next one', async () => {
    const w = await world({ balanceMicros: 100_000 });
    let now = new Date('2026-11-12T10:00:10Z');
    const c = ctx(w, dbA, { now: () => now });
    const noKey = input(w, { idempotencyKey: undefined });
    const a = await chargeAndRecord(c, noKey);
    now = new Date('2026-11-12T10:00:50Z');
    const b = await chargeAndRecord(c, noKey);
    now = new Date('2026-11-12T10:01:00Z');
    const d = await chargeAndRecord(c, noKey);
    expect([a.replay, b.replay, d.replay]).toEqual([false, true, false]);
    expect(b.callId).toBe(a.callId);
    expect(d.callId).not.toBe(a.callId);
    expect((await call(a.callId)).idempotency_key).toMatch(/^auto:[0-9a-f]{64}$/);
    expect(await balance(w)).toBe(94_000);
  });

  test('onInsufficient: runs outside the transaction; true retries the charge once, false records the 402', async () => {
    const w = await world({ balanceMicros: 1000 });
    const seen: unknown[] = [];
    const ok = await chargeAndRecord(
      ctx(w, dbA, {
        onInsufficient: async (short) => {
          seen.push(short);
          // The rolled-back metering txn holds no locks and left no row behind.
          expect(await q(`SELECT 1 FROM api_calls WHERE id = $1`, [short.callId])).toHaveLength(0);
          await topUp(w, 20_000);
          return true;
        },
      }),
      input(w),
    );
    expect(ok).toMatchObject({ status: 200, chargedMicros: 3000, balanceMicros: 18_000 });
    expect(seen).toEqual([
      { buyerId: w.buyerId, callId: expect.any(String), priceMicros: 3000, balanceMicros: 1000 },
    ]);

    const poor = await world({ balanceMicros: 1000 });
    let calls = 0;
    const refused = await chargeAndRecord(
      ctx(poor, dbA, {
        onInsufficient: async () => {
          calls++;
          throw new Error('vault declined');
        },
      }),
      input(poor),
    );
    expect(refused.status).toBe(402);
    expect(calls).toBe(1);
    expect(await call(refused.callId)).toMatchObject({ status: 'PAYMENT_REQUIRED' });
  });

  test('notifies publisher_events call.charged on commit only', async () => {
    const w = await world({ balanceMicros: 100_000 });
    const listener = new pg.Client({ connectionString: pools.db.url });
    await listener.connect();
    const events: unknown[] = [];
    listener.on('notification', (n) => {
      const e =
        n.channel === PUBLISHER_EVENTS_CHANNEL ? parsePublisherEvent(n.payload ?? '') : null;
      if (e?.publisherId === w.publisherId) events.push(e);
    });
    await listener.query(`LISTEN ${PUBLISHER_EVENTS_CHANNEL}`);
    try {
      const res = await chargeAndRecord(ctx(w), input(w));
      await chargeAndRecord(ctx(w), input(w, { count: 0 }));
      await new Promise((r) => setTimeout(r, 200));
      expect(events).toEqual([
        expect.objectContaining({
          type: 'call.charged',
          publisherId: w.publisherId,
          ids: [res.callId],
        }),
      ]);
    } finally {
      await listener.end();
    }
  });
});
