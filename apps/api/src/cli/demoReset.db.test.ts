import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp as createDemoSite } from '../../../demo-site/src/app.js';
import { createStore, type Store } from '../../../demo-site/src/data/store.js';
import { authenticateKey } from '../auth/apiKeys.js';
import { loadConfig, type Config } from '../config.js';
import type { CrawlDeps } from '../crawl/deps.js';
import { approveDataset } from '../datasets/approve.js';
import { createDb, createPool, type Db } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { FakePayPal } from '../paypal/index.js';
import { payoutPayPal } from '../payouts/deps.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { demoPayout, formatPayout } from './demoPayout.js';
import {
  assertDemoMode,
  crawlDemoSite,
  demoReset,
  DemoResetRefused,
  DEMO_RESET_MEMO,
  demoSiteOf,
  resetDemoSite,
} from './demoReset.js';
import {
  DEMO_BUYER,
  DEMO_PUBLISHER,
  seedApiKey,
  seedDemo,
  type SeedDemoResult,
} from './seedDemo.js';

const TOKEN = 'demo-admin-token-for-tests';
const FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  { name: 'price_usd', type: 'integer', visible: true, filterable: ['lt', 'lte'] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq'] },
];
/** $0.10 a record (the column max), so one 100-record call gives the publisher $8 payable. */
const PRICE_MICROS = 100_000;
const RECORDS = 120;

// One database and API for the file: demo:reset is idempotent and every test starts from
// whatever the last one left (that is the point: take after take).
describe.skipIf(!testDatabaseUrl)(
  'SP-038 demo:reset + demo:payout (Postgres + FakePayPal)',
  {
    timeout: 120_000,
  },
  () => {
    let tdb: TestDatabase;
    let config: Config;
    let app: FastifyInstance;
    let db: Db;
    let seed: SeedDemoResult;
    let siteStore: Store;
    let siteServer: Server;
    let siteUrl: string;
    let datasetId: string;
    let acmeKey: string;
    const pools: { end(): Promise<void> }[] = [];

    beforeAll(async () => {
      // The demo site on its own port, as a remote service (like the Render one).
      siteStore = createStore(0.01);
      const site = createDemoSite({
        store: siteStore,
        adminToken: TOKEN,
        accessLog: createAccessLog(() => {}),
      });
      siteServer = await new Promise<Server>((resolve) => {
        const s = site.listen(0, '127.0.0.1', () => resolve(s));
      });
      siteUrl = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;

      tdb = await createTestDatabase();
      config = loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: tdb.url,
        PAYPAL_MODE: 'stub',
        DEMO_MODE: 'true',
        ALLOW_LOCAL_ORIGINS: 'true',
        DEMO_SITE_URL: siteUrl,
        DEMO_ADMIN_TOKEN: TOKEN,
        DEMO_PUBLISHER_PAYOUT_EMAIL: 'publisher-biz@example.com',
        SPIGOT_VERIFY_TOKEN: 'spigot-verify=preset-demo-token',
      });
      app = await buildServer(config, { logger: false });
      await app.ready();
      db = app.db;

      const fake = new FakePayPal({ latencyMs: 1 });
      seed = await seedDemo(
        { db, config, pp: fake.client({ timeoutMs: 1_000 }) },
        { simBuyers: 3 },
      );
      acmeKey = seed.acme.apiKey;
      // Acme's cap must allow a $10 call.
      await db.pool.query('UPDATE buyers SET per_call_max_micros = 50000000 WHERE id = $1', [
        seed.acme.id,
      ]);

      // What the live crawl + AI proposal would have produced: a template, a PROPOSED dataset with
      // records and a PROPOSED schema (the on-camera approve takes it).
      const [tpl] = await q<{ id: string }>(
        `INSERT INTO templates (site_id, url_pattern) VALUES ($1, '^/listings/[a-z0-9-]+$') RETURNING id`,
        [seed.site.id],
      );
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, template_id, slug, type_name, status, record_count, price_per_record_micros)
       VALUES ($1, $2, 'listings', 'Listing', 'PROPOSED', $3, $4) RETURNING id`,
        [seed.site.id, tpl!.id, RECORDS, PRICE_MICROS],
      );
      datasetId = ds!.id;
      await q(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'PROPOSED', $2, '{}', '{"from":"url"}', 'AI')`,
        [datasetId, JSON.stringify(FIELDS)],
      );
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
       SELECT $1, 'l-' || i, jsonb_build_object('title', 'Listing ' || i, 'price_usd', 1000 + i, 'city', 'Austin'),
              md5(i::text), 1, now(), now() - i * interval '1 second'
         FROM generate_series(1, $2) i`,
        [datasetId, RECORDS],
      );
    });
    afterAll(async () => {
      await Promise.all(pools.map((p) => p.end()));
      await app?.close();
      await tdb?.drop();
      await new Promise((r) => siteServer?.close(r));
    });
    beforeEach(() => app.rateLimiter.reset());

    async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return (await db.pool.query(sql, params)).rows as T[];
    }
    const read = (key: string, idem: string, limit = 100) =>
      request(app.server)
        .get(`/v1/${seed.site.slug}/datasets/listings/records?limit=${limit}`)
        .set('Authorization', `Bearer ${key}`)
        .set('Idempotency-Key', idem);
    const gatePolicy = () =>
      request(app.server)
        .get('/api/gate/policy')
        .set('Authorization', `Bearer ${seed.site.gateKey}`);

    async function acmeBalance(): Promise<number> {
      const [r] = await q<{ b: string }>(
        `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
        [seed.acme.id],
      );
      return Number(r?.b ?? 0);
    }
    async function counts() {
      const [r] = await q<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM ledger_entries) AS entries,
              (SELECT count(*)::int FROM ledger_txns) AS txns,
              (SELECT count(*)::int FROM api_calls) AS calls,
              (SELECT count(*)::int FROM records WHERE dataset_id = $1) AS records,
              (SELECT count(*)::int FROM topups) AS topups,
              (SELECT count(*)::int FROM claims) AS claims`,
        [datasetId],
      );
      return r!;
    }
    /** Every PayPal id we hold: top-ups, payouts, audit. */
    async function paypalIds(): Promise<string[]> {
      const rows = await q<{ id: string }>(
        `SELECT paypal_order_id AS id FROM topups WHERE paypal_order_id IS NOT NULL
       UNION ALL SELECT paypal_capture_id FROM topups WHERE paypal_capture_id IS NOT NULL
       UNION ALL SELECT paypal_batch_id FROM payout_batches WHERE paypal_batch_id IS NOT NULL
       UNION ALL SELECT paypal_id FROM audit_events WHERE paypal_id IS NOT NULL`,
      );
      return rows.map((r) => r.id).sort();
    }

    /** The video script, in short: approve on camera → Acme tops up → a paid call → payout. */
    async function take(tag: string) {
      const [sv] = await q<{ id: string }>(
        `SELECT id FROM schema_versions WHERE dataset_id = $1 AND status = 'PROPOSED'`,
        [datasetId],
      );
      expect(sv, 'a PROPOSED schema to approve').toBeDefined();
      const approved = await approveDataset(
        db,
        { appBaseUrl: config.APP_BASE_URL },
        seed.publisher.id,
        datasetId,
        { schemaVersionId: sv!.id, rightsAttested: true },
      );
      expect(approved.status).toBe('LIVE');
      // The APPROVE run's extraction isn't under test; close the run like it would.
      await q(`UPDATE crawl_runs SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`, [
        approved.crawlRunId,
      ]);
      expect((await gatePolicy().expect(200)).body.gatedPaths).toContain('^/listings/');

      await db.tx(async (tx) => {
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', seed.acme.id);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:test:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash }, 20_000_000),
        });
      });
      const res = await read(acmeKey, `take-${tag}`).expect(200);
      expect(res.body.records).toHaveLength(100);
      expect(await acmeBalance()).toBe(20_000_000 - 100 * PRICE_MICROS);

      const { summary } = await demoPayout({ pool: db.pool, pp: payoutPayPal(config) });
      return summary;
    }

    it('reset → take → reset → take works twice; nothing deleted; ledger check passes', async () => {
      for (const n of [1, 2]) {
        const payout = await take(String(n));
        // Take 1 pays the publisher; in take 2 the first item is still PENDING at FakePayPal
        // (nobody polls here), so that publisher is skipped: one item in flight per publisher.
        if (n === 1) {
          expect(payout.outcome).toBe('PENDING');
          expect(payout.paypalBatchId).toBeTruthy();
          expect(payout.items).toHaveLength(1);
          expect(formatPayout(payout).join('\n')).toContain(payout.paypalBatchId!);
        } else {
          expect(['PENDING', 'NO_ITEMS']).toContain(payout.outcome);
        }

        const before = await counts();
        const idsBefore = await paypalIds();
        const policyBefore = (await gatePolicy().expect(200)).body.policyVersion as number;
        const oldKey = acmeKey;
        const [prior] = await q<{ id: string }>(
          `SELECT id FROM api_calls WHERE buyer_id = $1 AND idempotency_key = $2`,
          [seed.acme.id, `take-${n}`],
        );

        const r = await demoReset(db);
        acmeKey = r.buyer.apiKey;

        // Datasets → PROPOSED, records kept, a PROPOSED copy of the schema, policy bumped.
        expect(r.datasets).toEqual([
          expect.objectContaining({
            id: datasetId,
            from: 'LIVE',
            proposedSchemaVersionId: expect.any(String),
          }),
        ]);
        const [ds] = await q<{ status: string }>('SELECT status FROM datasets WHERE id = $1', [
          datasetId,
        ]);
        expect(ds!.status).toBe('PROPOSED');
        const policy = (await gatePolicy().expect(200)).body;
        expect(policy.policyVersion).toBeGreaterThan(policyBefore);
        expect(policy.gatedPaths).not.toContain('^/listings/');

        // Acme → $0 through one DEMO_RESET txn into platform revenue.
        expect(r.buyer.zeroedMicros).toBe(10_000_000);
        expect(await acmeBalance()).toBe(0);
        const [txn] = await q<{ kind: string; memo: string; lines: number }>(
          `SELECT t.kind, t.memo, (SELECT count(*)::int FROM ledger_entries e WHERE e.txn_id = t.id) AS lines
           FROM ledger_txns t WHERE t.id = $1`,
          [r.buyer.ledgerTxnId],
        );
        expect(txn).toEqual({ kind: 'DEMO_RESET', memo: DEMO_RESET_MEMO, lines: 2 });

        // Nothing deleted: two new entries, one new txn, every call and record still there.
        const after = await counts();
        expect(after).toEqual({ ...before, entries: before.entries + 2, txns: before.txns + 1 });
        expect(await paypalIds()).toEqual(idsBefore);
        expect(idsBefore.length).toBeGreaterThan(0);
        const check = await ledgerCheck(db.pool);
        expect(check.mismatches).toEqual([]);

        // Acme's calls hidden, not deleted.
        const [calls] = await q<{ total: number; visible: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE hidden_at IS NULL)::int AS visible
           FROM api_calls WHERE buyer_id = $1`,
          [seed.acme.id],
        );
        expect(calls!.total).toBeGreaterThanOrEqual(n);
        expect(calls!.visible).toBe(0);

        // Replaying the pre-reset request with the old key: 401, no new row, no charge.
        const replay = await read(oldKey, `take-${n}`);
        expect(replay.status).toBe(401);
        expect(replay.body.error.code).toBe('KEY_REVOKED');
        await expect(authenticateKey(db.pool, oldKey)).rejects.toMatchObject({
          code: 'KEY_REVOKED',
        });
        expect(await counts()).toEqual(after);
        const [still] = await q<{ id: string; hidden: boolean }>(
          `SELECT id, hidden_at IS NOT NULL AS hidden FROM api_calls WHERE id = $1`,
          [prior!.id],
        );
        expect(still).toEqual({ id: prior!.id, hidden: true });

        // The new key works, and the dataset answers 410 until the re-approve.
        const gone = await read(acmeKey, `after-reset-${n}`);
        expect(gone.status).toBe(410);
        expect(gone.body.error.code).toBe('DATASET_UNPUBLISHED');
        expect(await acmeBalance()).toBe(0);
      }
    });

    it('a second reset right after is a no-op on money and datasets', async () => {
      const before = await counts();
      const r = await demoReset(db);
      acmeKey = r.buyer.apiKey;
      expect(r.datasets).toEqual([]);
      expect(r.policyVersions).toEqual({});
      expect(r.buyer).toMatchObject({ zeroedMicros: 0, ledgerTxnId: null, hiddenCalls: 0 });
      expect(r.buyer.revokedKeyIds).toHaveLength(1);
      expect(await counts()).toEqual(before);
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('SIM history is untouched: SIM keys, calls and balances survive a reset', async () => {
      await take('sim');
      const sim = seed.simTopups[0]!;
      const simKey = seedApiKey(config.SESSION_SECRET, sim.email);
      // SIM buyers keep the default $1 per-call cap: 5 records.
      await read(simKey, 'sim-call', 5).expect(200);
      const simState = async () =>
        q(
          `SELECT c.id, c.hidden_at, c.status, a.balance_micros
           FROM api_calls c JOIN ledger_accounts a ON a.owner_id = c.buyer_id AND a.kind = 'BUYER_BALANCE'
          WHERE c.buyer_id = $1 ORDER BY c.id`,
          [sim.buyerId],
        );
      const before = await simState();
      expect(before).toHaveLength(1);

      const r = await demoReset(db);
      acmeKey = r.buyer.apiKey;
      expect(await simState()).toEqual(before);
      await expect(authenticateKey(db.pool, simKey)).resolves.toMatchObject({
        buyerId: sim.buyerId,
      });
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('two resets at once: serialized, one DEMO_RESET txn, one live key, ledger check passes', async () => {
      await take('race');
      const other = createPool(tdb.url, { max: 4 });
      pools.push(other);
      const before = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_txns WHERE kind = 'DEMO_RESET'`,
      );
      const [a, b] = await Promise.all([demoReset(db), demoReset(createDb(other))]);
      const zeroed = [a, b].map((r) => r.buyer.zeroedMicros).sort((x, y) => x - y);
      expect(zeroed).toEqual([0, 10_000_000]);
      expect([a, b].flatMap((r) => r.datasets)).toHaveLength(1);
      const after = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM ledger_txns WHERE kind = 'DEMO_RESET'`,
      );
      expect(after[0]!.n).toBe(before[0]!.n + 1);
      const live = await q<{ id: string }>(
        `SELECT id FROM api_keys WHERE buyer_id = $1 AND revoked_at IS NULL`,
        [seed.acme.id],
      );
      expect(live).toHaveLength(1);
      acmeKey = [a, b].find((r) => r.buyer.apiKeyId === live[0]!.id)!.buyer.apiKey;
      expect(await acmeBalance()).toBe(0);
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('a charge racing a reset never leaves a negative balance or a broken ledger', async () => {
      await take('charge-race');
      const other = createPool(tdb.url, { max: 4 });
      pools.push(other);
      const key = acmeKey;
      const [res, r] = await Promise.all([read(key, 'racing-call'), demoReset(createDb(other))]);
      acmeKey = r.buyer.apiKey;
      // Before the reset: charged, then zeroed. After: 401 (key revoked) or 410 (dataset reset).
      expect([200, 401, 410]).toContain(res.status);
      expect(await acmeBalance()).toBe(0);
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('refuses a non-demo publisher, a SIM buyer and DEMO_MODE=false, changing nothing', async () => {
      await q(
        `INSERT INTO publishers (name, email, payout_email) VALUES ('Real Co', 'real@example.com', 'real@example.com')`,
      );
      const before = await counts();
      await expect(demoReset(db, { publisherEmail: 'real@example.com' })).rejects.toBeInstanceOf(
        DemoResetRefused,
      );
      await expect(demoReset(db, { publisherEmail: 'nobody@example.com' })).rejects.toThrow(
        /run seed:demo/,
      );
      await expect(demoReset(db, { buyerEmail: seed.simTopups[0]!.email })).rejects.toThrow(
        /SIM buyer/,
      );
      expect(await counts()).toEqual(before);
      // The live Acme key still works: a refused reset revoked nothing.
      await expect(authenticateKey(db.pool, acmeKey)).resolves.toMatchObject({
        buyerId: seed.acme.id,
      });

      expect(() => assertDemoMode({ DEMO_MODE: false }, 'demo:reset')).toThrow(/DEMO_MODE=true/);
      expect(() => assertDemoMode({ DEMO_MODE: true }, 'demo:reset')).not.toThrow();
      expect(DEMO_PUBLISHER.email).not.toBe(DEMO_BUYER.email);
    });

    it('resets the demo site over HTTP on another port, then a MANUAL crawl of it succeeds', async () => {
      // A demo mutation on the remote site, as `demo:mutate --target` would make.
      const mutate = await fetch(new URL('/admin/mutate', siteUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prices: 2, new: 1, seed: 7 }),
      });
      expect(mutate.status).toBe(200);
      const added = ((await mutate.json()) as { added: string[] }).added;
      expect(added).toHaveLength(1);

      await expect(resetDemoSite(siteUrl, 'wrong-token')).rejects.toThrow(/401/);
      const site = await resetDemoSite(siteUrl, TOKEN);
      expect(site.removed).toEqual(added);
      expect(siteStore.state().mutations).toBe(0);
      expect(siteStore.state().lastResetAt).toBe(site.at);

      const row = await demoSiteOf(db.pool, seed.publisher.id, seed.site.origin);
      expect(row?.id).toBe(seed.site.id);
      const crawlDeps: CrawlDeps = {
        db,
        crawlSecret: config.SESSION_SECRET,
        allowLocal: true,
        appBaseUrl: config.APP_BASE_URL,
        minGapMs: 0,
      };
      const crawl = await crawlDemoSite(crawlDeps, seed.publisher.id, seed.site.id);
      expect(crawl.status).toBe('SUCCEEDED');
      const [run] = await q<{ trigger: string; pages_fetched: number }>(
        'SELECT trigger, pages_fetched FROM crawl_runs WHERE id = $1',
        [crawl.crawlRunId],
      );
      expect(run!.trigger).toBe('MANUAL');
      expect(run!.pages_fetched).toBeGreaterThan(0);
    });
  },
);
