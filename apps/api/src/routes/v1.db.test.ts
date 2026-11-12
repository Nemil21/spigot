import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DATASET_UNPUBLISHED_MESSAGE,
  insufficientBalanceMessage,
  priceAboveMaxMessage,
} from '@spigot/shared/copy';
import { createKey, revokeKey, type ApiKeyScope } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { cases } from '../security/tenancy/v1.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import {
  balanceResponse,
  catalogResponse,
  changesResponse,
  describeResponse,
  errorEnvelope,
  insufficientBalance402Body,
  payment402Body,
  priceAboveMax402Body,
  quoteResponse,
  recordResponse,
  recordsResponse,
} from './v1.schemas.js';

const BASE = REQUIRED_ENV.APP_BASE_URL!.replace(/\/+$/, '');

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

describe.skipIf(!testDatabaseUrl)('SP-017b /v1 routes (Postgres)', { timeout: 120_000 }, () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url }), {
      logger: false,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => app.rateLimiter.reset());

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await app.db.pool.query(sql, params)).rows as T[];

  interface World {
    site: string;
    datasetId: string;
    buyerId: string;
    apiKeyId: string;
    key: string;
    path: string;
  }

  /**
   * Site `s-<tag>` (publisher "Pub <tag>") with one LIVE `listings` dataset of `n` records (cities
   * cycle Austin / Dallas / Waco, bedrooms = i % 5) and `n` published changes, plus a buyer with
   * one API key and `balanceMicros`.
   */
  async function world(
    opts: {
      n?: number;
      balanceMicros?: number;
      perCallMax?: number;
      scopes?: ApiKeyScope[];
      rateLimitPerMin?: number;
    } = {},
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
      `INSERT INTO buyers (name, per_call_max_micros) VALUES ($1, $2) RETURNING id`,
      [`Buyer ${tag}`, opts.perCallMax ?? 1_000_000],
    );
    const created = await createKey(app.db.pool, buyer!.id, {
      scopes: opts.scopes ?? ['read', 'topup'],
      ...(opts.rateLimitPerMin !== undefined ? { rateLimitPerMin: opts.rateLimitPerMin } : {}),
    });
    if (opts.balanceMicros) await topUp(buyer!.id, opts.balanceMicros);
    return {
      site,
      datasetId: ds!.id,
      buyerId: buyer!.id,
      apiKeyId: created.id,
      key: created.key,
      path: `/v1/${site}/datasets/listings`,
    };
  }

  async function topUp(buyerId: string, micros: number) {
    await app.db.tx(async (tx) => {
      const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyerId);
      const { paypalCash } = await platformAccounts(tx);
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer, paypalCash }, micros),
      });
    });
  }

  /** A second buyer with its own key (no records of its own). */
  async function otherBuyer(balanceMicros = 0) {
    const [buyer] = await q<{ id: string }>(`INSERT INTO buyers (name) VALUES ($1) RETURNING id`, [
      `Other ${randomUUID().slice(0, 8)}`,
    ]);
    const created = await createKey(app.db.pool, buyer!.id, { scopes: ['read'] });
    if (balanceMicros) await topUp(buyer!.id, balanceMicros);
    return { buyerId: buyer!.id, key: created.key, apiKeyId: created.id };
  }

  const get = (path: string, key?: string, headers: Record<string, string> = {}) => {
    let r = request(app.server).get(path);
    if (key) r = r.set('Authorization', `Bearer ${key}`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r;
  };

  const bal = async (buyerId: string) =>
    (
      await q<{ b: number }>(
        `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
        [buyerId],
      )
    )[0]?.b ?? 0;
  const chargeCount = async (buyerId: string) =>
    Number(
      (
        await q<{ n: string }>(
          `SELECT count(*) AS n FROM api_calls WHERE buyer_id = $1 AND status = 'CHARGED'`,
          [buyerId],
        )
      )[0]!.n,
    );
  const callCount = async (buyerId: string) =>
    Number(
      (
        await q<{ n: string }>(`SELECT count(*) AS n FROM api_calls WHERE buyer_id = $1`, [buyerId])
      )[0]!.n,
    );

  /** The 402 headers the gate sends, for a site whose only dataset is `listings` at 1,500. */
  function expect402Headers(res: request.Response, site: string) {
    const link = ([] as string[]).concat(res.headers.link ?? []).join(', ');
    expect(link).toContain(
      `<${BASE}/v1/${site}/datasets/listings>; rel="alternate"; type="application/json"`,
    );
    expect(link).toContain(`<${BASE}/c/${site}>; rel="payment"`);
    expect(res.headers['spigot-price']).toBe('listings; per-record-micros=1500');
    expect(res.headers['cache-control']).toBe('no-store');
  }

  // ── The acceptance walkthrough ──────────────────────────────────────────────────────────────

  describe('walkthrough: catalog → describe → quote → records → replay', () => {
    it('charges once, sets the Spigot-* headers, and replays free with Spigot-Replay', async () => {
      const w = await world({ balanceMicros: 20_000_000 });

      const cat = await get('/v1/catalog');
      expect(cat.status).toBe(200);
      const catalog = catalogResponse.parse(cat.body);
      const entry = catalog.sites.find((s) => s.slug === w.site);
      expect(entry).toMatchObject({
        name: expect.stringMatching(/^Pub /),
        datasets: [{ slug: 'listings', type: 'Listing', records: 120, perRecordMicros: 1500 }],
      });

      const desc = await get(w.path);
      expect(desc.status).toBe(200);
      const schema = describeResponse.parse(desc.body);
      expect(schema.fields.map((f) => f.name)).toEqual([
        'title',
        'price_usd',
        'bedrooms',
        'city',
        'updated_at',
      ]);
      expect(JSON.stringify(desc.body)).not.toContain('agent_phone');

      const filter = '?bedrooms[gte]=3&city=Austin&limit=100';
      const qt = await get(`${w.path}/quote${filter}`, w.key);
      expect(qt.status).toBe(200);
      const quote = quoteResponse.parse(qt.body);
      expect(quote.records).toBeGreaterThan(0);
      expect(quote.balanceMicros).toBe(20_000_000);
      expect(await callCount(w.buyerId)).toBe(0); // a quote is free and stores nothing

      const idem = randomUUID();
      const first = await get(`${w.path}/records${filter}`, w.key, { 'Idempotency-Key': idem });
      expect(first.status).toBe(200);
      const body = recordsResponse.parse(first.body);
      expect(body.records).toHaveLength(quote.records);
      expect(body.charged).toEqual({ records: quote.records, priceMicros: quote.priceMicros });
      for (const r of body.records) {
        expect(r.data.city).toBe('Austin');
        expect(r.data.bedrooms as number).toBeGreaterThanOrEqual(3);
      }
      expect(JSON.stringify(first.body)).not.toContain(SECRET);
      expect(first.headers['spigot-charged-micros']).toBe(String(quote.priceMicros));
      expect(first.headers['spigot-balance-micros']).toBe(String(20_000_000 - quote.priceMicros));
      expect(first.headers['spigot-records']).toBe(String(quote.records));
      expect(first.headers['spigot-call-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.headers['spigot-replay']).toBeUndefined();
      expect(await bal(w.buyerId)).toBe(20_000_000 - quote.priceMicros);

      const again = await get(`${w.path}/records${filter}`, w.key, { 'Idempotency-Key': idem });
      expect(again.status).toBe(200);
      expect(again.headers['spigot-replay']).toBe('true');
      expect(again.headers['spigot-charged-micros']).toBe('0');
      expect(again.headers['spigot-call-id']).toBe(first.headers['spigot-call-id']);
      expect(again.headers['spigot-records']).toBe(String(quote.records));
      expect(again.body.records).toEqual(first.body.records);
      expect(await bal(w.buyerId)).toBe(20_000_000 - quote.priceMicros);
      expect(await chargeCount(w.buyerId)).toBe(1);

      const b = await get('/v1/balance', w.key);
      expect(b.status).toBe(200);
      expect(balanceResponse.parse(b.body).balanceMicros).toBe(20_000_000 - quote.priceMicros);
    });

    it('a reused Idempotency-Key with a different query → 409 IDEMPOTENCY_MISMATCH, no charge', async () => {
      const w = await world({ balanceMicros: 20_000_000 });
      const idem = randomUUID();
      expect(
        (await get(`${w.path}/records?limit=2`, w.key, { 'Idempotency-Key': idem })).status,
      ).toBe(200);
      const res = await get(`${w.path}/records?limit=3`, w.key, { 'Idempotency-Key': idem });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
      expect(await chargeCount(w.buyerId)).toBe(1);
    });

    it('10 concurrent requests with one Idempotency-Key charge exactly once', async () => {
      const w = await world({ balanceMicros: 20_000_000 });
      const idem = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          get(`${w.path}/records?limit=10`, w.key, { 'Idempotency-Key': idem }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(new Set(results.map((r) => r.headers['spigot-call-id'])).size).toBe(1);
      expect(results.filter((r) => r.headers['spigot-replay'] !== 'true')).toHaveLength(1);
      expect(await chargeCount(w.buyerId)).toBe(1);
      expect(await bal(w.buyerId)).toBe(20_000_000 - 10 * 1500);
    });

    it('zero results → 200, nothing charged', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const res = await get(`${w.path}/records?city=Nowhere`, w.key);
      expect(res.status).toBe(200);
      expect(res.body.records).toEqual([]);
      expect(res.headers['spigot-charged-micros']).toBe('0');
      expect(res.headers['spigot-records']).toBe('0');
      expect(await bal(w.buyerId)).toBe(1_000_000);
    });
  });

  // ── 402s ────────────────────────────────────────────────────────────────────────────────────

  describe('402 PAYMENT_REQUIRED without a key', () => {
    it.each(['records', 'records/listings%2Fl-1', 'changes?since=0'])(
      '/%s → 402 with the gate-shaped body and headers, not 401',
      async (suffix) => {
        const w = await world({ n: 5 });
        const res = await get(`${w.path}/${suffix}`);
        expect(res.status).toBe(402);
        const body = payment402Body.strict().parse(res.body);
        expect(body).toEqual({
          error: {
            code: 'PAYMENT_REQUIRED',
            message:
              'This site sells its data as an API. Clean, typed, live records: $1.50 per 1,000.',
          },
          site: body.site,
          datasets: [
            {
              slug: 'listings',
              type: 'Listing',
              records: 5,
              perRecordMicros: 1500,
              endpoint: `${BASE}/v1/${w.site}/datasets/listings/records`,
            },
          ],
          pay: {
            method: 'prepaid_balance',
            provider: 'PayPal',
            topUpUrl: `${new URL(BASE).origin}/buyers/topup`,
            mcp: `${new URL(BASE).origin}/mcp`,
          },
          terms: `${BASE}/c/${w.site}/terms`,
        });
        expect402Headers(res, w.site);
      },
    );

    it('an unknown dataset without a key is still a 404', async () => {
      const w = await world({ n: 1 });
      const res = await get(`/v1/${w.site}/datasets/nope/records`);
      expect(res.status).toBe(404);
      expect(errorEnvelope.parse(res.body).error.code).toBe('NOT_FOUND');
    });

    it('a malformed, unknown or revoked key → 401, not 402', async () => {
      const w = await world({ n: 1 });
      const bad = await get(`${w.path}/records`, 'sk_spg_nope');
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe('UNAUTHENTICATED');
      await revokeKey(app.db.pool, w.buyerId, w.apiKeyId);
      const revoked = await get(`${w.path}/records`, w.key);
      expect(revoked.status).toBe(401);
      expect(revoked.body.error.code).toBe('KEY_REVOKED');
    });

    it('a key without the read scope → 403 FORBIDDEN', async () => {
      const w = await world({ n: 1, scopes: ['topup'] });
      const res = await get(`${w.path}/records`, w.key);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('W15 copy in 402 / 410 bodies (from @spigot/shared/copy)', () => {
    it('INSUFFICIENT_BALANCE: the shared message, quote, balance, top-up link and 402 headers', async () => {
      const w = await world({ balanceMicros: 12_000 });
      const res = await get(`${w.path}/records?limit=37`, w.key);
      expect(res.status).toBe(402);
      const body = insufficientBalance402Body.parse(res.body);
      expect(body.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(body.error.message).toBe(
        insufficientBalanceMessage({
          priceMicros: 55_500,
          balanceMicros: 12_000,
          topUpUrl: `${new URL(BASE).origin}/buyers/topup`,
        }),
      );
      expect(body.quote).toEqual({ records: 37, priceMicros: 55_500 });
      expect(body.balanceMicros).toBe(12_000);
      expect(res.headers['spigot-charged-micros']).toBeUndefined();
      expect402Headers(res, w.site);
      expect(await bal(w.buyerId)).toBe(12_000);
    });

    it('PRICE_ABOVE_MAX via max_price_micros: the shared message, no charge, no row', async () => {
      const w = await world({ balanceMicros: 20_000_000 });
      const res = await get(`${w.path}/records?limit=100&max_price_micros=100000`, w.key);
      expect(res.status).toBe(402);
      const body = priceAboveMax402Body.parse(res.body);
      expect(body.error.code).toBe('PRICE_ABOVE_MAX');
      expect(body.error.message).toBe(
        priceAboveMaxMessage({ records: 100, priceMicros: 150_000, maxPriceMicros: 100_000 }),
      );
      expect(body.maxPriceMicros).toBe(100_000);
      expect402Headers(res, w.site);
      expect(await callCount(w.buyerId)).toBe(0);
      expect(await bal(w.buyerId)).toBe(20_000_000);
    });

    it('max_price_micros at or above the price is charged', async () => {
      const w = await world({ balanceMicros: 20_000_000 });
      const res = await get(`${w.path}/records?limit=10&max_price_micros=15000`, w.key);
      expect(res.status).toBe(200);
      expect(res.headers['spigot-charged-micros']).toBe('15000');
    });

    it('max_price_micros that is not an integer → 400 VALIDATION_ERROR', async () => {
      const w = await world({ balanceMicros: 1_000 });
      const res = await get(`${w.path}/records?max_price_micros=-1`, w.key);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('UNPUBLISHED → 410 DATASET_UNPUBLISHED with the shared message, keyed or not', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      await q(`UPDATE datasets SET status = 'UNPUBLISHED' WHERE id = $1`, [w.datasetId]);
      for (const res of [await get(`${w.path}/records`, w.key), await get(`${w.path}/records`)]) {
        expect(res.status).toBe(410);
        expect(res.body.error).toMatchObject({
          code: 'DATASET_UNPUBLISHED',
          message: DATASET_UNPUBLISHED_MESSAGE,
        });
      }
      expect(await bal(w.buyerId)).toBe(1_000_000);
    });
  });

  // ── Filters and validation ──────────────────────────────────────────────────────────────────

  describe('filters', () => {
    it.each([
      ['an unknown field', 'colour=red'],
      ['a hidden field', `agent_phone=${SECRET}0001`],
      ['an op the field does not allow', 'bedrooms[lt]=3'],
    ])('%s → 400 UNSUPPORTED_FILTER listing the valid fields, no charge', async (_what, qs) => {
      const w = await world({ balanceMicros: 1_000_000 });
      for (const path of [`${w.path}/records?${qs}`, `${w.path}/quote?${qs}`]) {
        const res = await get(path, w.key);
        expect(res.status).toBe(400);
        const env = errorEnvelope.parse(res.body);
        expect(env.error.code).toBe('UNSUPPORTED_FILTER');
        expect(env.error.details?.validFilters).toEqual([
          { field: 'price_usd', ops: ['eq', 'lt', 'lte', 'gt', 'gte'] },
          { field: 'bedrooms', ops: ['eq', 'gte', 'lte'] },
          { field: 'city', ops: ['eq', 'in'] },
          { field: 'updated_at', ops: ['gte'] },
        ]);
      }
      expect(await callCount(w.buyerId)).toBe(0);
    });

    it('a reserved param sent twice → 400 VALIDATION_ERROR', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const res = await get(`${w.path}/records?limit=1&limit=2`, w.key);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('an unknown query param on /changes → 400', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const res = await get(`${w.path}/changes?city=Austin`, w.key);
      expect(res.status).toBe(400);
    });
  });

  // ── Other routes ────────────────────────────────────────────────────────────────────────────

  describe('records/:key', () => {
    it.each(['listings%2Fl-7', 'l-7'])('/records/%s → one record, charged once', async (k) => {
      const w = await world({ balanceMicros: 1_000_000 });
      const res = await get(`${w.path}/records/${k}`, w.key);
      expect(res.status).toBe(200);
      const body = recordResponse.parse(res.body);
      expect(body.record.key).toBe('listings/l-7');
      expect(body.record.data).not.toHaveProperty('agent_phone');
      expect(res.headers['spigot-records']).toBe('1');
      expect(res.headers['spigot-charged-micros']).toBe('1500');
      expect(await bal(w.buyerId)).toBe(1_000_000 - 1500);
    });

    it('an unknown key → 404, nothing charged', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const res = await get(`${w.path}/records/l-9999`, w.key);
      expect(res.status).toBe(404);
      expect(await bal(w.buyerId)).toBe(1_000_000);
    });
  });

  describe('changes', () => {
    it('no since → a free starting cursor; since=0 → full history charged per change', async () => {
      const w = await world({ n: 12, balanceMicros: 1_000_000 });
      const start = await get(`${w.path}/changes`, w.key);
      expect(start.status).toBe(200);
      const s = changesResponse.parse(start.body);
      expect(s.changes).toEqual([]);
      expect(start.headers['spigot-charged-micros']).toBe('0');

      const all = await get(`${w.path}/changes?since=0&include=record`, w.key);
      expect(all.status).toBe(200);
      const body = changesResponse.parse(all.body);
      expect(body.changes).toHaveLength(12);
      expect(body.charged).toEqual({ changes: 12, priceMicros: 12 * 500 });
      expect(body.changes[0]!.record).toBeTruthy();
      expect(JSON.stringify(all.body)).not.toContain(SECRET);
      expect(all.headers['spigot-records']).toBe('12');
      expect(all.headers['spigot-charged-micros']).toBe('6000');
      expect(await bal(w.buyerId)).toBe(1_000_000 - 6000);
    });
  });

  describe('auth on free and keyed routes', () => {
    it('catalog and describe need no key', async () => {
      const w = await world({ n: 1 });
      expect((await get('/v1/catalog')).status).toBe(200);
      expect((await get(w.path)).status).toBe(200);
    });

    it('quote and balance need a key (401)', async () => {
      const w = await world({ n: 1 });
      for (const path of [`${w.path}/quote`, '/v1/balance']) {
        const res = await get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });
  });

  // ── Rate limit ──────────────────────────────────────────────────────────────────────────────

  describe('rate limit: 60 calls/min per key', () => {
    it('the 61st call in a minute → 429 RATE_LIMITED with Retry-After', async () => {
      const w = await world({ n: 1, balanceMicros: 1_000_000 });
      for (let i = 0; i < 60; i += 1) {
        const res = await get(i % 2 ? '/v1/balance' : `${w.path}/quote`, w.key);
        expect(res.status).toBe(200);
      }
      const res = await get(`${w.path}/records`, w.key);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await callCount(w.buyerId)).toBe(0);

      // Per key: another buyer's key is unaffected.
      const other = await otherBuyer();
      expect((await get('/v1/balance', other.key)).status).toBe(200);
    });

    it("honours the key's rate_limit_per_min", async () => {
      const w = await world({ n: 1, rateLimitPerMin: 3 });
      for (let i = 0; i < 3; i += 1) expect((await get('/v1/balance', w.key)).status).toBe(200);
      expect((await get('/v1/balance', w.key)).status).toBe(429);
    });

    it('keyless calls to paid routes are limited per IP', async () => {
      const w = await world({ n: 1 });
      for (let i = 0; i < 60; i += 1) expect((await get(`${w.path}/records`)).status).toBe(402);
      expect((await get(`${w.path}/records`)).status).toBe(429);
    });
  });

  // ── Tenancy (security/tenancy/v1.cases.ts) ──────────────────────────────────────────────────

  describe('tenancy', () => {
    it('every /v1 route has a tenancy case', () => {
      const routes = [
        'GET /v1/catalog',
        'GET /v1/:site/datasets/:dataset',
        'GET /v1/:site/datasets/:dataset/quote',
        'GET /v1/:site/datasets/:dataset/records',
        'GET /v1/:site/datasets/:dataset/records/:key',
        'GET /v1/:site/datasets/:dataset/changes',
        'GET /v1/balance',
      ];
      expect(cases.map((c) => `${c.method} ${c.url}`).sort()).toEqual([...routes].sort());
    });

    it("B's key never sees or spends A's balance; ?buyerId=<A> is ignored", async () => {
      const a = await world({ balanceMicros: 5_000_000 });
      const b = await otherBuyer(1_000_000);
      const res = await get(`/v1/balance?buyerId=${a.buyerId}`, b.key);
      expect(res.body.balanceMicros).toBe(1_000_000);
      const qt = await get(`${a.path}/quote?buyerId=${a.buyerId}`, b.key);
      expect(qt.status).toBe(400); // buyerId is not a filter
      const ok = await get(`${a.path}/quote`, b.key);
      expect(ok.body.balanceMicros).toBe(1_000_000);
    });

    it("B reusing A's Idempotency-Key gets its own call, charged to B, not A's replay", async () => {
      const a = await world({ balanceMicros: 5_000_000 });
      const b = await otherBuyer(5_000_000);
      const idem = randomUUID();
      const ra = await get(`${a.path}/records?limit=4`, a.key, { 'Idempotency-Key': idem });
      const rb = await get(`${a.path}/records?limit=4`, b.key, { 'Idempotency-Key': idem });
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      expect(rb.headers['spigot-replay']).toBeUndefined();
      expect(rb.headers['spigot-call-id']).not.toBe(ra.headers['spigot-call-id']);
      expect(await bal(a.buyerId)).toBe(5_000_000 - 6000);
      expect(await bal(b.buyerId)).toBe(5_000_000 - 6000);
    });
  });
});
