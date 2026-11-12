import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { SpigotClient, SpigotError } from '../../../../packages/sdk/typescript/src/index.js';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { claimResponse } from '../routes/v1-claims.js';
import {
  balanceResponse,
  changesResponse,
  describeResponse,
  quoteResponse,
  recordResponse,
  recordsResponse,
} from '../routes/v1.schemas.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-056 smoke against the real API: `buildServer` listening on a local port, Postgres behind it.
 * Runs the SDK README examples unchanged (TypeScript always; Python when `python3` exists), then
 * the client's paid paths: every response parses with the route's own Zod schema, an idempotent
 * retry (sequential and racing) charges once, an empty balance is a typed 402 with the top-up
 * link, and the call id feeds a claim.
 */

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SDK = `${ROOT}packages/sdk/`;
const hasPython = spawnSync('python3', ['--version']).status === 0;
const PRICE = 1500; // datasets.price_per_record_micros default

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
];

/** The API's 2xx body without the SDK's `callId` / `replay` additions. */
const wire = <T extends object>(r: T) => {
  const { callId: _c, replay: _r, ...body } = r as T & { callId?: unknown; replay?: unknown };
  return body;
};

describe.skipIf(!testDatabaseUrl)(
  'SP-056 SDK smoke against the API (Postgres)',
  { timeout: 120_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let baseUrl: string;

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url }), {
        logger: false,
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      await seedBluebonnet();
    });
    afterAll(async () => {
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => app.rateLimiter.reset());

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    /**
     * Site `bluebonnet` with a LIVE `listings` dataset of 120 records: bedrooms = i % 5, price
     * 1000 + i, so the README's `bedrooms[gte]=3 & price_usd[lt]=2000` matches 48.
     */
    async function seedBluebonnet() {
      const [pub] = await q<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email) VALUES ('Bluebonnet', 'bb@example.com', 'bb@example.com') RETURNING id`,
      );
      const [s] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, 'https://bluebonnet.example.com', 'bluebonnet', 'v', 'c', 'g', 'READY') RETURNING id`,
        [pub!.id],
      );
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count)
       VALUES ($1, 'listings', 'Listing', 'LIVE', 120) RETURNING id`,
        [s!.id],
      );
      const [sv] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
        [ds!.id, JSON.stringify(FIELDS)],
      );
      await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
       SELECT $1, 'l-' || i,
              jsonb_build_object('title', 'Listing ' || i, 'price_usd', 1000 + i, 'bedrooms', i % 5,
                'city', (ARRAY['Austin','Dallas','Waco'])[i % 3 + 1]),
              md5(i::text), 1, now(), timestamptz '2026-11-11T00:00:00Z' + i * interval '1 second'
         FROM generate_series(1, 120) i`,
        [ds!.id],
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

    /** A buyer with one `read`+`topup` key and `balanceMicros`. */
    async function buyer(balanceMicros: number) {
      const [b] = await q<{ id: string }>(
        `INSERT INTO buyers (name, per_call_max_micros) VALUES ($1, 1000000) RETURNING id`,
        [`Buyer ${randomUUID().slice(0, 8)}`],
      );
      const { key } = await createKey(app.db.pool, b!.id, { scopes: ['read', 'topup'] });
      if (balanceMicros > 0) {
        await app.db.tx(async (tx) => {
          const account = await getOrCreateAccount(tx, 'BUYER_BALANCE', b!.id);
          const { paypalCash } = await platformAccounts(tx);
          await post(tx, {
            kind: 'TOPUP',
            idempotencyKey: `topup:${randomUUID()}`,
            entries: topupEntries({ buyer: account, paypalCash }, balanceMicros),
          });
        });
      }
      return { key, client: new SpigotClient({ apiKey: key, baseUrl }) };
    }

    const balanceOf = async (c: SpigotClient) => (await c.balance.get()).balanceMicros;

    it('the TypeScript README example runs against the API and is charged once', async () => {
      const { key, client } = await buyer(20_000_000);
      const { stdout } = await run(
        `${ROOT}node_modules/.bin/tsx`,
        ['--tsconfig', `${SDK}typescript/tsconfig.json`, `${SDK}typescript/examples/readme.ts`],
        { env: { ...process.env, SPIGOT_KEY: key, SPIGOT_URL: baseUrl }, cwd: ROOT },
      );
      expect(stdout.trim()).toBe(`48 listings, charged $${((48 * PRICE) / 1e6).toFixed(4)}`);
      expect(await balanceOf(client)).toBe(20_000_000 - 48 * PRICE);
    });

    it.skipIf(!hasPython)('the Python README example runs against the API', async () => {
      const { key, client } = await buyer(20_000_000);
      const { stdout } = await run('python3', ['examples/readme.py'], {
        env: {
          ...process.env,
          SPIGOT_KEY: key,
          SPIGOT_URL: baseUrl,
          PYTHONPATH: `${SDK}python`,
          PYTHONDONTWRITEBYTECODE: '1',
        },
        cwd: `${SDK}python`,
      });
      expect(stdout.trim()).toBe(`48 listings, charged $${((48 * PRICE) / 1e6).toFixed(4)}`);
      expect(await balanceOf(client)).toBe(20_000_000 - 48 * PRICE);
    });

    it('every client call returns the shape the route serves', async () => {
      const { client } = await buyer(20_000_000);
      const free = new SpigotClient({ baseUrl });
      const catalog = await free.catalog.list();
      expect(catalog.sites.map((s) => s.slug)).toContain('bluebonnet');
      describeResponse.parse(await free.datasets.describe('bluebonnet', 'listings'));
      quoteResponse.parse(
        await client.records.quote('bluebonnet', 'listings', { 'bedrooms[gte]': 3 }),
      );

      const page = await client.records.search(
        'bluebonnet',
        'listings',
        { 'city[in]': ['Austin', 'Waco'] },
        {
          limit: 5,
          sort: 'updated_at',
        },
      );
      recordsResponse.parse(wire(page));
      expect(page.records).toHaveLength(5);
      expect(page.records.every((r) => ['Austin', 'Waco'].includes(r.data.city as string))).toBe(
        true,
      );
      const next = await client.records.search(
        'bluebonnet',
        'listings',
        { 'city[in]': ['Austin', 'Waco'] },
        {
          limit: 5,
          sort: 'updated_at',
          cursor: page.next,
        },
      );
      expect(next.records[0]!.key).not.toBe(page.records[0]!.key);

      recordResponse.parse(wire(await client.records.get('bluebonnet', 'listings', 'l-7')));
      const feed = await client.changes.list('bluebonnet', 'listings', {
        since: '0',
        limit: 3,
        includeRecord: true,
      });
      changesResponse.parse(wire(feed));
      expect(feed.changes[0]!.record?.key).toBeDefined();
      balanceResponse.parse(await client.balance.get());
    });

    it('a retry with the same idempotency key replays and is not charged twice', async () => {
      const { client } = await buyer(20_000_000);
      const opts = { limit: 10, idempotencyKey: `retry-${randomUUID()}` };
      const first = await client.records.search('bluebonnet', 'listings', {}, opts);
      const again = await client.records.search('bluebonnet', 'listings', {}, opts);
      expect(first.replay).toBe(false);
      expect(again.replay).toBe(true);
      expect(again.callId).toBe(first.callId);
      expect(again.records).toEqual(first.records);
      expect(await balanceOf(client)).toBe(20_000_000 - 10 * PRICE);
    });

    it('racing retries with the same idempotency key charge exactly once', async () => {
      const { client } = await buyer(20_000_000);
      const opts = { limit: 10, idempotencyKey: `race-${randomUUID()}` };
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => client.records.search('bluebonnet', 'listings', {}, opts)),
      );
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      // Losers either replay the winner's response or are refused; none is a second charge.
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(SpigotError);
      }
      expect(ok.filter((r) => !r.replay)).toHaveLength(1);
      expect(new Set(ok.map((r) => r.callId)).size).toBe(1);
      expect(await balanceOf(client)).toBe(20_000_000 - 10 * PRICE);
    });

    it('an empty balance throws a typed 402 with the top-up link and charges nothing', async () => {
      const { client } = await buyer(0);
      const err = await client.records.search('bluebonnet', 'listings').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpigotError);
      const e = err as SpigotError;
      expect(e.status).toBe(402);
      expect(e.code).toBe('INSUFFICIENT_BALANCE');
      expect(e.topUpUrl).toMatch(/^http/);
      expect(await balanceOf(client)).toBe(0);

      const keyless = await new SpigotClient({ baseUrl }).records
        .search('bluebonnet', 'listings')
        .catch((x: unknown) => x);
      expect(keyless).toMatchObject({ status: 402, code: 'PAYMENT_REQUIRED' });
      expect((keyless as SpigotError).topUpUrl).toMatch(/^http/);
    });

    it('an unsupported filter is a typed 400', async () => {
      const { client } = await buyer(20_000_000);
      await expect(
        client.records.search('bluebonnet', 'listings', { 'agent_phone[eq]': '1' }),
      ).rejects.toMatchObject({ status: 400, code: 'UNSUPPORTED_FILTER' });
    });

    it("a paid call's callId files a claim", async () => {
      const { client } = await buyer(20_000_000);
      const page = await client.records.search('bluebonnet', 'listings', {}, { limit: 3 });
      expect(page.callId).toMatch(/^[0-9a-f-]{36}$/);
      const claim = await client.claims.create({
        callId: page.callId!,
        recordKey: page.records[0]!.key,
        reason: 'MISSING_FIELD',
        note: 'SDK smoke',
      });
      claimResponse.parse(claim);
    });
  },
);
