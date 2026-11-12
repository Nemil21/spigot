import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { build402, parsePolicy } from '@spigot/gate';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { balance } from './balance.js';
import { catalog } from './catalog.js';
import { describe as describeDataset } from './describe.js';
import {
  paidRead,
  paymentRequired,
  type PaidReadContext,
  type PaidReadParams,
} from './paidRead.js';
import { quote } from './quote.js';

const BASE = 'https://spigot.test';

/** Demo Listing schema; `agent_phone` is extracted but hidden. */
const FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  {
    name: 'price_usd',
    type: 'integer',
    visible: true,
    filterable: ['eq', 'lt', 'lte', 'gt', 'gte'],
  },
  { name: 'bedrooms', type: 'integer', visible: true, filterable: ['eq', 'gte', 'lte'] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq', 'in'] },
  { name: 'agent_phone', type: 'string', visible: false, filterable: ['eq'] },
];
const SECRET = '512-555-';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return `${e.status} ${e.code}`;
    throw e;
  }
  return 'resolved';
}

describe.skipIf(!testDatabaseUrl)('paid-read services', { timeout: 120_000 }, () => {
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
    site: string;
    siteId: string;
    datasetId: string;
    buyerId: string;
    apiKeyId: string;
  }

  /**
   * A publisher "Pub <tag>" with site `s-<tag>`, one LIVE `listings` dataset of `n` records
   * (cities cycle Austin / Dallas / Waco) with `n` published `add` changes, and a buyer with
   * one key and `balanceMicros`.
   */
  async function world(
    opts: { n?: number; balanceMicros?: number; perCallMax?: number; simulated?: boolean } = {},
  ): Promise<World> {
    const n = opts.n ?? 120;
    const tag = randomUUID().slice(0, 8);
    const site = `s-${tag}`;
    const [pub] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ($1, $2, $2) RETURNING id`,
      [`Pub ${tag}`, `pub-${tag}@example.com`],
    );
    const [s] = await q<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, 'v', 'c', 'g', 'READY') RETURNING id`,
      [pub!.id, `https://${tag}.example.com`, site],
    );
    const [ds] = await q<{ id: string }>(
      `INSERT INTO datasets (site_id, slug, type_name, status, record_count)
       VALUES ($1, 'listings', 'Listing', 'LIVE', $2) RETURNING id`,
      [s!.id, n],
    );
    const [sv] = await q<{ id: string }>(
      `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
      [ds!.id, JSON.stringify(FIELDS)],
    );
    await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
    if (n > 0) {
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
         SELECT $1, 'l-' || i,
                jsonb_build_object('title', 'Listing ' || i, 'price_usd', 1000 + i,
                  'bedrooms', i % 5, 'city', (ARRAY['Austin','Dallas','Waco'])[i % 3 + 1],
                  'agent_phone', '${SECRET}' || lpad(i::text, 4, '0')),
                md5(i::text), 1, now(), timestamptz '2026-11-11T00:00:00Z' + i * interval '1 second'
           FROM generate_series(1, $2) i`,
        [ds!.id, n],
      );
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
         SELECT $1, r.id, 1, 'add', jsonb_build_array(jsonb_build_object('op','add','path','','value', r.data)), r.hash
           FROM records r WHERE r.dataset_id = $1 ORDER BY r.updated_at`,
        [ds!.id],
      );
      await q(
        `UPDATE datasets SET published_seq = (SELECT max(seq) FROM record_versions WHERE dataset_id = $1) WHERE id = $1`,
        [ds!.id],
      );
    }
    const [buyer] = await q<{ id: string }>(
      `INSERT INTO buyers (name, per_call_max_micros, is_simulated) VALUES ($1, $2, $3) RETURNING id`,
      [`Buyer ${tag}`, opts.perCallMax ?? 1_000_000, opts.simulated ?? false],
    );
    const [key] = await q<{ id: string }>(
      `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, $2, $3) RETURNING id`,
      [buyer!.id, tag, `hash-${randomUUID()}`],
    );
    const w = { site, siteId: s!.id, datasetId: ds!.id, buyerId: buyer!.id, apiKeyId: key!.id };
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

  const ctx = (w: World, extra: Partial<PaidReadContext> = {}): PaidReadContext => ({
    db: dbA,
    buyerId: w.buyerId,
    apiKeyId: w.apiKeyId,
    channel: 'REST',
    baseUrl: BASE,
    ...extra,
  });

  const read = (w: World, over: Partial<PaidReadParams> = {}): PaidReadParams => ({
    site: w.site,
    dataset: 'listings',
    kind: 'records',
    idempotencyKey: randomUUID(),
    ...over,
  });

  const bal = async (w: World) => (await balance({ db: pools.a }, w.buyerId)).balanceMicros;
  const calls = async (w: World) =>
    q<Record<string, unknown>>(`SELECT * FROM api_calls WHERE buyer_id = $1 ORDER BY created_at`, [
      w.buyerId,
    ]);
  const charges = async (w: World) =>
    (
      await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_txns t JOIN api_calls c ON c.id = t.ref_id
          WHERE t.kind = 'CHARGE' AND c.buyer_id = $1`,
        [w.buyerId],
      )
    )[0]!.n;

  test('quote equals the later charge for the same query (filters, default and clamped limits, cursor)', async () => {
    const w = await world({ balanceMicros: 10_000_000 });
    const variants: Partial<PaidReadParams>[] = [
      { filters: { city: 'Austin', 'bedrooms[gte]': '2' }, limit: '30' },
      { filters: { city: 'Austin' } }, // default 50
      { limit: 500 }, // clamped to max_records_per_call = 100
      { filters: [{ field: 'city', op: 'in', value: ['Dallas', 'Waco'] }], limit: 7 },
      { filters: { city: 'Nowhere' } },
    ];
    for (const v of variants) {
      const before = await bal(w);
      const qt = await quote({ db: pools.a, buyerId: w.buyerId }, { ...read(w), ...v });
      expect(qt.validForSeconds).toBe(60);
      expect(qt.unitPriceMicros).toBe(1500);
      expect(qt.balanceMicros).toBe(before);
      const res = await paidRead(ctx(w), read(w, v));
      expect(res.status).toBe(200);
      expect(res.count).toBe(qt.records);
      expect(res.chargedMicros).toBe(qt.priceMicros);
      expect(before - (await bal(w))).toBe(qt.priceMicros);
    }
    expect(
      (await quote({ db: pools.a, buyerId: w.buyerId }, { ...read(w), limit: 500 })).records,
    ).toBe(100);

    // With a cursor: the quote counts the page after it.
    const first = await paidRead(ctx(w), read(w, { limit: 100 }));
    const next = (first.body as { next: string }).next;
    expect(next).toBeTruthy();
    const qt = await quote(
      { db: pools.a, buyerId: w.buyerId },
      { ...read(w), limit: 100, cursor: next },
    );
    expect(qt.records).toBe(20);
    const page2 = await paidRead(ctx(w), read(w, { limit: 100, cursor: next }));
    expect(page2.chargedMicros).toBe(qt.priceMicros);
  });

  test('200 body: visible fields only, charged, balance; api_calls snapshot, channel and served keys', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const res = await paidRead(ctx(w), read(w, { filters: { city: 'Austin' }, limit: 3 }));
    const body = res.body as {
      records: { key: string; data: Record<string, unknown> }[];
      charged: unknown;
      balanceMicros: number;
    };
    expect(res).toMatchObject({
      status: 200,
      chargedMicros: 4500,
      replay: false,
      count: 3,
      headers: null,
    });
    expect(body.charged).toEqual({ records: 3, priceMicros: 4500 });
    expect(body.balanceMicros).toBe(995_500);
    expect(res.balanceMicros).toBe(995_500);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    for (const r of body.records) expect(r.data).not.toHaveProperty('agent_phone');

    const [row] = await calls(w);
    expect(row).toMatchObject({
      id: res.callId,
      status: 'CHARGED',
      channel: 'REST',
      endpoint: 'records.search',
      unit_price_micros: 1500,
      price_micros: 4500,
      records_returned: 3,
    });
    expect(row!.served_record_keys).toEqual(
      body.records.map((r) => ({ key: r.key, hash: expect.stringMatching(/^[0-9a-f]{32}$/) })),
    );
    // Stored body has no balance (it changes); replays add the current one.
    expect(row!.response_body).not.toHaveProperty('balanceMicros');
    const audit = await q(`SELECT actor_type FROM audit_events WHERE entity_id = $1`, [res.callId]);
    expect(audit).toEqual([{ actor_type: 'BUYER' }]);
  });

  test('MCP channel is recorded on api_calls and as MCP_CLIENT in the audit', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const res = await paidRead(ctx(w, { channel: 'MCP' }), read(w, { limit: 2 }));
    expect(res.status).toBe(200);
    const [row] = await calls(w);
    expect(row!.channel).toBe('MCP');
    const audit = await q(`SELECT actor_type FROM audit_events WHERE entity_id = $1`, [res.callId]);
    expect(audit).toEqual([{ actor_type: 'MCP_CLIENT' }]);
  });

  test('maxPriceMicros below the price → 402 PRICE_ABOVE_MAX with the quote; no txn, no api_calls row', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const res = await paidRead(ctx(w), read(w, { limit: 10, maxPriceMicros: '14999' }));
    expect(res.status).toBe(402);
    expect(res).toMatchObject({
      callId: null,
      chargedMicros: 0,
      count: 0,
      balanceMicros: 1_000_000,
    });
    expect(res.body).toMatchObject({
      error: { code: 'PRICE_ABOVE_MAX' },
      quote: { records: 10, priceMicros: 15_000 },
      maxPriceMicros: 14_999,
      site: expect.stringMatching(/^Pub /),
      pay: { topUpUrl: `${BASE}/buyers/topup` },
    });
    expect(res.headers?.['Cache-Control']).toBe('no-store');
    expect(await calls(w)).toEqual([]);
    expect(await charges(w)).toBe(0);
    expect(await bal(w)).toBe(1_000_000);

    // Exactly at the cap is fine.
    expect((await paidRead(ctx(w), read(w, { limit: 10, maxPriceMicros: 15_000 }))).status).toBe(
      200,
    );
    expect(await code(paidRead(ctx(w), read(w, { maxPriceMicros: '-1' })))).toBe(
      '400 VALIDATION_ERROR',
    );
  });

  test("the buyer's per_call_max_micros is the default cap", async () => {
    const w = await world({ balanceMicros: 1_000_000, perCallMax: 3000 });
    const res = await paidRead(ctx(w), read(w, { limit: 3 }));
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: { code: 'PRICE_ABOVE_MAX' }, maxPriceMicros: 3000 });
    expect(await calls(w)).toEqual([]);
    // An explicit higher cap overrides it.
    expect((await paidRead(ctx(w), read(w, { limit: 3, maxPriceMicros: 4500 }))).status).toBe(200);
  });

  test('UNPUBLISHED → 410 for reads, quotes and describe, with no charge and no row; PROPOSED → 404', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    await q(`UPDATE datasets SET status = 'UNPUBLISHED' WHERE id = $1`, [w.datasetId]);
    for (const kind of ['records', 'record', 'changes'] as const) {
      expect(
        await code(
          paidRead(
            ctx(w),
            read(w, { kind, key: 'listings/l-1', cursor: kind === 'changes' ? 0 : null }),
          ),
        ),
      ).toBe('410 DATASET_UNPUBLISHED');
    }
    expect(await code(quote({ db: pools.a, buyerId: w.buyerId }, read(w)))).toBe(
      '410 DATASET_UNPUBLISHED',
    );
    expect(await code(describeDataset({ db: pools.a, baseUrl: BASE }, w.site, 'listings'))).toBe(
      '410 DATASET_UNPUBLISHED',
    );
    expect(await code(paymentRequired({ db: pools.a, baseUrl: BASE }, w.site, 'listings'))).toBe(
      '410 DATASET_UNPUBLISHED',
    );
    expect(await calls(w)).toEqual([]);
    expect(await charges(w)).toBe(0);
    expect(await bal(w)).toBe(1_000_000);

    await q(`UPDATE datasets SET status = 'PROPOSED' WHERE id = $1`, [w.datasetId]);
    expect(await code(paidRead(ctx(w), read(w)))).toBe('404 NOT_FOUND');
    expect(await code(paidRead(ctx(w), read(w, { dataset: 'nope' })))).toBe('404 NOT_FOUND');
    expect(await code(paidRead(ctx(w), read(w, { site: 'no-such-site' })))).toBe('404 NOT_FOUND');
  });

  test('LIVE_STALE is still served and charged, with staleSince', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    await q(`UPDATE datasets SET status = 'LIVE_STALE', stale_since = now() WHERE id = $1`, [
      w.datasetId,
    ]);
    const res = await paidRead(ctx(w), read(w, { limit: 1 }));
    expect(res.status).toBe(200);
    expect(res.chargedMicros).toBe(1500);
    const rec = (res.body as { records: { freshness: { staleSince: string | null } }[] })
      .records[0]!;
    expect(rec.freshness.staleSince).not.toBeNull();
  });

  test('unit price is snapshotted: an owner price change mid-call does not change the charge', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const res = await paidRead(
      ctx(w, {
        afterQuery: async () => {
          await q(`UPDATE datasets SET price_per_record_micros = 3000 WHERE id = $1`, [
            w.datasetId,
          ]);
        },
      }),
      read(w, { limit: 4 }),
    );
    expect(res.chargedMicros).toBe(6000);
    expect(await bal(w)).toBe(994_000);
    const [row] = await calls(w);
    expect(row).toMatchObject({ unit_price_micros: 1500, price_micros: 6000 });
    // The next call uses the new price.
    expect((await paidRead(ctx(w), read(w, { limit: 4 }))).chargedMicros).toBe(12_000);
  });

  test('zero results → 200 NOT_CHARGED, price 0', async () => {
    const w = await world({ balanceMicros: 0 });
    const res = await paidRead(ctx(w), read(w, { filters: { city: 'Nowhere' } }));
    expect(res).toMatchObject({ status: 200, chargedMicros: 0, count: 0 });
    const [row] = await calls(w);
    expect(row).toMatchObject({ status: 'NOT_CHARGED', price_micros: 0 });
  });

  test('short balance → 402 INSUFFICIENT_BALANCE with quote, balance, topUpUrl (and top_up over MCP); no charge', async () => {
    const w = await world({ balanceMicros: 12_000 });
    const rest = await paidRead(ctx(w), read(w, { limit: 37 }));
    expect(rest.status).toBe(402);
    expect(rest.body).toMatchObject({
      error: { code: 'INSUFFICIENT_BALANCE' },
      quote: { records: 37, priceMicros: 55_500 },
      balanceMicros: 12_000,
      topUpUrl: `${BASE}/buyers/topup`,
      datasets: [{ slug: 'listings', perRecordMicros: 1500 }],
    });
    expect(rest.body).not.toHaveProperty('top_up');
    expect(rest.headers?.Link).toHaveLength(2);
    expect(await charges(w)).toBe(0);

    const mcp = await paidRead(ctx(w, { channel: 'MCP' }), read(w, { limit: 37 }));
    expect(mcp.body).toMatchObject({ top_up: { tool: 'top_up', amountCents: 500 } });
    expect((await calls(w)).map((c) => c.status)).toEqual(['PAYMENT_REQUIRED', 'PAYMENT_REQUIRED']);
  });

  test('a retry after a 402 with the same key charges once the buyer tops up', async () => {
    const w = await world({ balanceMicros: 1000 });
    const p = read(w, { limit: 5 });
    expect((await paidRead(ctx(w), p)).status).toBe(402);
    await topUp(w, 1_000_000);
    const res = await paidRead(ctx(w), p);
    expect(res).toMatchObject({ status: 200, chargedMicros: 7500, replay: false });
    expect(await calls(w)).toHaveLength(1);
  });

  test('idempotency: same key replays free (even after unpublish); different request → 409', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const p = read(w, { filters: { city: 'Austin', 'bedrooms[gte]': 2 }, limit: 5 });
    const first = await paidRead(ctx(w), p);
    // Filter order doesn't matter.
    const again = await paidRead(ctx(w), {
      ...p,
      filters: { 'bedrooms[gte]': '2', city: 'Austin' },
    });
    expect(again).toMatchObject({
      status: 200,
      replay: true,
      chargedMicros: 0,
      callId: first.callId,
      count: 5,
    });
    expect((again.body as { records: unknown }).records).toEqual(
      (first.body as { records: unknown }).records,
    );
    expect(await charges(w)).toBe(1);

    await q(`UPDATE datasets SET status = 'UNPUBLISHED' WHERE id = $1`, [w.datasetId]);
    expect((await paidRead(ctx(w), p)).replay).toBe(true);
    await q(`UPDATE datasets SET status = 'LIVE' WHERE id = $1`, [w.datasetId]);

    expect(await code(paidRead(ctx(w), { ...p, limit: 6 }))).toBe('409 IDEMPOTENCY_MISMATCH');
    expect(await code(paidRead(ctx(w), { ...p, kind: 'changes', cursor: 0 }))).toBe(
      '409 IDEMPOTENCY_MISMATCH',
    );
    expect(await charges(w)).toBe(1);
  });

  test('idempotency: an owner changing max_records_per_call does not turn a retry into a 409', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    await q(`UPDATE datasets SET max_records_per_call = 10 WHERE id = $1`, [w.datasetId]);
    const explicit = read(w, { limit: 500 }); // clamped to 10
    const omitted = read(w); // default 50, clamped to 10
    const a = await paidRead(ctx(w), explicit);
    const b = await paidRead(ctx(w), omitted);
    expect([a.count, b.count]).toEqual([10, 10]);

    await q(`UPDATE datasets SET max_records_per_call = 100 WHERE id = $1`, [w.datasetId]);
    const a2 = await paidRead(ctx(w), explicit);
    const b2 = await paidRead(ctx(w), omitted);
    expect(a2).toMatchObject({
      status: 200,
      replay: true,
      callId: a.callId,
      chargedMicros: 0,
      count: 10,
    });
    expect(b2).toMatchObject({
      status: 200,
      replay: true,
      callId: b.callId,
      chargedMicros: 0,
      count: 10,
    });
    expect(await charges(w)).toBe(2);

    // A new key gets the new clamp.
    expect((await paidRead(ctx(w), read(w, { limit: 500 }))).count).toBe(100);
  });

  test('no Idempotency-Key: an identical call within the minute replays (auto key)', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const now = new Date('2026-11-12T10:00:10Z');
    const p = read(w, { idempotencyKey: undefined, limit: 2 });
    const a = await paidRead(ctx(w, { now: () => now }), p);
    const b = await paidRead(ctx(w, { now: () => new Date('2026-11-12T10:00:50Z') }), p);
    expect(b).toMatchObject({ replay: true, callId: a.callId });
    const c = await paidRead(ctx(w, { now: () => new Date('2026-11-12T10:01:01Z') }), p);
    expect(c.replay).toBe(false);
    expect(await charges(w)).toBe(2);
  });

  test('race: concurrent calls with one key from two processes charge once', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const p = read(w, { limit: 4 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => paidRead(ctx(w, { db: i % 2 ? dbB : dbA }), p)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.callId)).size).toBe(1);
    expect(await charges(w)).toBe(1);
    expect(await bal(w)).toBe(1_000_000 - 6000);
  });

  test('race: concurrent different calls never overdraw the balance', async () => {
    const w = await world({ balanceMicros: 10_000 }); // enough for 6 records
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        paidRead(ctx(w, { db: i % 2 ? dbB : dbA }), read(w, { limit: 2 })),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    expect(await bal(w)).toBe(1000);
  });

  test('record kind: one record at the record price; unknown key → 404 with no row', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    const res = await paidRead(ctx(w), read(w, { kind: 'record', key: 'listings/l-7' }));
    expect(res).toMatchObject({ status: 200, chargedMicros: 1500, count: 1 });
    const body = res.body as { record: { key: string; data: Record<string, unknown> } };
    expect(body.record.key).toBe('listings/l-7');
    expect(body.record.data).not.toHaveProperty('agent_phone');
    expect(await code(paidRead(ctx(w), read(w, { kind: 'record', key: 'listings/nope' })))).toBe(
      '404 NOT_FOUND',
    );
    expect(await calls(w)).toHaveLength(1);
    const [row] = await calls(w);
    expect(row).toMatchObject({ endpoint: 'records.get', records_returned: 1 });
  });

  test('changes kind: charged per change at the change price; no since → free start cursor', async () => {
    const w = await world({ n: 12, balanceMicros: 1_000_000 });
    const start = await paidRead(ctx(w), read(w, { kind: 'changes' }));
    expect(start).toMatchObject({ status: 200, chargedMicros: 0, count: 0 });

    const all = await paidRead(
      ctx(w),
      read(w, { kind: 'changes', cursor: 0, limit: 5, includeRecord: true }),
    );
    expect(all).toMatchObject({ status: 200, chargedMicros: 2500, count: 5 });
    const body = all.body as { changes: unknown[]; hasMore: boolean; charged: unknown };
    expect(body.charged).toEqual({ changes: 5, priceMicros: 2500 });
    expect(body.hasMore).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const rows = await calls(w);
    expect(rows[1]).toMatchObject({
      endpoint: 'changes.list',
      changes_returned: 5,
      unit_price_micros: 500,
    });
    expect((rows[1]!.served_record_keys as unknown[]).length).toBe(5);
  });

  test('hidden fields can be neither filtered nor read', async () => {
    const w = await world({ balanceMicros: 1_000_000 });
    expect(
      await code(paidRead(ctx(w), read(w, { filters: { agent_phone: `${SECRET}0001` } }))),
    ).toBe('400 UNSUPPORTED_FILTER');
    expect(
      await code(
        quote({ db: pools.a, buyerId: w.buyerId }, { ...read(w), filters: { agent_phone: 'x' } }),
      ),
    ).toBe('400 UNSUPPORTED_FILTER');
    const d = await describeDataset({ db: pools.a, baseUrl: BASE }, w.site, 'listings');
    expect(d.fields.map((f) => f.name)).not.toContain('agent_phone');
    expect(await calls(w)).toEqual([]);
  });

  test('unauthenticated PAYMENT_REQUIRED matches the gate build402 body for the same site', async () => {
    const w = await world();
    const res = await paymentRequired({ db: pools.a, baseUrl: BASE }, w.site, 'listings');
    const name = (
      await q<{ name: string }>(
        `SELECT p.name FROM publishers p JOIN sites s ON s.publisher_id = p.id WHERE s.id = $1`,
        [w.siteId],
      )
    )[0]!.name;
    const gate = build402(
      parsePolicy({
        siteId: w.siteId,
        policyVersion: 1,
        apiBase: `${BASE}/v1/${w.site}`,
        catalogUrl: `${BASE}/c/${w.site}`,
        gatedPaths: [],
        decisions: {
          SEARCH: 'PASS',
          AI_TRAINING: 'QUOTE',
          AI_AGENT: 'QUOTE',
          SCRAPER_TOOL: 'QUOTE',
          UNKNOWN: 'PASS',
        },
        prices: [{ dataset: 'listings', perRecordMicros: 1500, type: 'Listing', records: 120 }],
        siteName: name,
      }),
    );
    expect(res.status).toBe(402);
    expect(JSON.stringify(res.body)).toBe(gate.json);
    expect(res.headers).toEqual(gate.headers);
    const siteOnly = await paymentRequired({ db: pools.a, baseUrl: BASE }, w.site);
    expect(siteOnly.body).toEqual(gate.body);
    expect(await code(paymentRequired({ db: pools.a, baseUrl: BASE }, 'no-such-site'))).toBe(
      '404 NOT_FOUND',
    );
  });

  test('catalog lists sold datasets only; describe gives visible fields, ops, pricing, licence', async () => {
    const w = await world();
    const hidden = await world();
    await q(`UPDATE datasets SET status = 'PROPOSED' WHERE id = $1`, [hidden.datasetId]);
    await q(
      `INSERT INTO crawl_runs (site_id, trigger, status, finished_at) VALUES ($1, 'MANUAL', 'SUCCEEDED', '2026-11-12T01:00:00Z')`,
      [w.siteId],
    );
    const c = await catalog(pools.a);
    expect(c.sites.find((s) => s.slug === hidden.site)).toBeUndefined();
    const site = c.sites.find((s) => s.slug === w.site)!;
    expect(site.name).toMatch(/^Pub /);
    expect(site.datasets).toEqual([
      {
        slug: 'listings',
        type: 'Listing',
        records: 120,
        perRecordMicros: 1500,
        perChangeMicros: 500,
        freshness: { lastCrawlAt: '2026-11-12T01:00:00.000Z', staleSince: null },
      },
    ]);

    const d = await describeDataset({ db: pools.a, baseUrl: BASE }, w.site, 'listings');
    expect(d).toMatchObject({
      type: 'Listing',
      version: 1,
      records: 120,
      pricing: { perRecordMicros: 1500, perChangeMicros: 500, display: '$1.50 / 1,000 records' },
      maxRecordsPerCall: 100,
      license: `${BASE}/c/${w.site}/terms`,
      freshness: { lastCrawlAt: '2026-11-12T01:00:00.000Z' },
    });
    expect(d.fields).toEqual([
      { name: 'title', type: 'string', filterable: [] },
      { name: 'price_usd', type: 'integer', filterable: ['eq', 'lt', 'lte', 'gt', 'gte'] },
      { name: 'bedrooms', type: 'integer', filterable: ['eq', 'gte', 'lte'] },
      { name: 'city', type: 'string', filterable: ['eq', 'in'] },
      { name: 'updated_at', type: 'datetime', filterable: ['gte'] },
    ]);
    expect(
      await code(describeDataset({ db: pools.a, baseUrl: BASE }, hidden.site, 'listings')),
    ).toBe('404 NOT_FOUND');
  });

  test('balance: balance and auto top-up status; quote reports wouldAutoTopUp', async () => {
    const w = await world({ balanceMicros: 1000 });
    expect(await balance({ db: pools.a }, w.buyerId)).toEqual({
      balanceMicros: 1000,
      autoTopup: {
        enabled: false,
        thresholdMicros: 2_000_000,
        amountCents: 2000,
        remainingThisMonthCents: 10_000,
        hasSavedMethod: false,
      },
    });
    await q(
      `UPDATE buyers SET auto_topup_enabled = true, vault_id = 'v_1', vault_kind = 'CARD' WHERE id = $1`,
      [w.buyerId],
    );
    await q(
      `INSERT INTO topups (buyer_id, amount_cents, method, trigger, status) VALUES ($1, 9000, 'VAULT_MIT', 'AUTO', 'COMPLETED')`,
      [w.buyerId],
    );
    const b = await balance({ db: pools.a }, w.buyerId);
    expect(b.autoTopup.remainingThisMonthCents).toBe(1000);
    // $20 auto top-up no longer fits the remaining $10 of the cap.
    expect(
      (await quote({ db: pools.a, buyerId: w.buyerId }, { ...read(w), limit: 5 })).wouldAutoTopUp,
    ).toBe(false);
    await q(`UPDATE buyers SET auto_topup_amount_cents = 1000 WHERE id = $1`, [w.buyerId]);
    const qt = await quote({ db: pools.a, buyerId: w.buyerId }, { ...read(w), limit: 5 });
    expect(qt).toMatchObject({
      records: 5,
      priceMicros: 7500,
      display: '$0.0075',
      wouldAutoTopUp: true,
    });
  });
});
