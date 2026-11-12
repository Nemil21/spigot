import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp } from '../../../demo-site/src/app.js';
import { openStore, type Store } from '../../../demo-site/src/data/store.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { resetHostQueues } from '../crawl/queue.js';
import { createDb, createPool, type Db } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { readChanges } from '../records/changes.js';
import { filterSql, parseQueryFilters } from '../records/filters.js';
import { loadServedDataset } from '../records/query.js';
import { createRecordedModel } from '../schema-agent/claude.js';
import { proposeForSite } from '../schema-agent/propose.js';
import { cases } from '../security/tenancy/datasets.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { demoSite, type DemoPage } from '../test/schema-agent/demoPages.js';
import { NO_VISIBLE_FIELDS_MESSAGE } from './approve.js';
import { startFeedReader } from '../test/extract-fixtures.js';

/**
 * SP-014a integration (ticket §Test plan): patch → approve → records at full demo scale (2,341
 * listings, recorded proposal, no model call), the validation / conflict / tenancy paths, and at
 * DEMO_SEED_SCALE=0.05 through the real crawler: crawl → approve → demo mutation → crawl → the
 * changes feed has exactly the mutated records; approve overlapping a crawl.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-014a dataset approve API (Postgres + demo site)', () => {
  let tdb: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let app: FastifyInstance;
  let dataDir: string;
  let store: Store;
  let origin: string;
  let originServer: Server;
  let verifyToken: string | undefined;
  let hold: { promise: Promise<void>; release: () => void } | null = null;
  const prevGap = process.env.CRAWL_MIN_GAP_MS;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    pool = createPool(tdb.url, { max: 6, applicationName: 'datasets-test' });
    db = createDb(pool);
    dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp014a-'));
    store = await openStore({ dataDir, scale: 0.05 });
    const quiet = createAccessLog(() => {});
    originServer = createServer((req, res) => {
      const demo = createApp({ store, accessLog: quiet, verifyToken });
      const path = (req.url ?? '/').split('?')[0]!;
      const meta =
        path === '/robots.txt' || path.startsWith('/sitemap') || path.startsWith('/.well-known');
      if (hold && !meta) void hold.promise.then(() => demo(req, res));
      else demo(req, res);
    });
    origin = await new Promise((resolve) =>
      originServer.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(originServer.address() as AddressInfo).port}`),
      ),
    );
    process.env.CRAWL_MIN_GAP_MS = '0';
    app = await buildServer(
      loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: tdb.url,
        ALLOW_LOCAL_ORIGINS: 'true',
        CRAWL_MIN_GAP_MS: '0',
        SCHEMA_AGENT_MODE: 'recorded',
      }),
      { logStream: new Writable({ write: (_c, _e, cb) => cb() }) },
    );
    await app.ready();
  }, 60_000);
  afterAll(async () => {
    hold?.release();
    await app?.close();
    if (prevGap === undefined) delete process.env.CRAWL_MIN_GAP_MS;
    else process.env.CRAWL_MIN_GAP_MS = prevGap;
    if (originServer) await new Promise<void>((r) => originServer.close(() => r()));
    await pool?.end();
    await tdb?.drop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    app.rateLimiter.reset();
    resetHostQueues();
  });

  const agent = () => request(app.server);
  const send = (method: 'post' | 'patch', url: string, cookie: string, body?: object) => {
    const r = agent()[method](url).set('Origin', APP_ORIGIN).set('Cookie', cookie);
    return body === undefined ? r : r.send(body);
  };
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows[0] as T;

  async function newPublisher() {
    const res = await send('post', '/api/auth/signup', '', {
      name: 'Bluebonnet',
      email: `p-${randomUUID()}@example.com`,
      password: 'correct horse',
      payoutEmail: 'payouts@example.com',
    });
    expect(res.status).toBe(201);
    return { id: res.body.publisherId as string, cookie: cookiesOf(res) };
  }

  const runRow = (id: string) =>
    one<{ status: string; trigger: string; ai_calls: number; error: string | null }>(
      'SELECT * FROM crawl_runs WHERE id = $1',
      [id],
    );
  async function waitForRun(runId: string, timeoutMs = 120_000) {
    const t0 = Date.now();
    for (;;) {
      const r = await runRow(runId);
      if (TERMINAL.includes(r.status)) return r;
      if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} did not end`);
      await sleep(25);
    }
  }
  /** The watermark caught up with every written version (the run-end hook has published). */
  async function waitForPublished(datasetId: string, timeoutMs = 20_000) {
    const t0 = Date.now();
    for (;;) {
      const r = await one<{ published_seq: string; max: string | null }>(
        `SELECT d.published_seq, (SELECT max(seq) FROM record_versions WHERE dataset_id = d.id) AS max
           FROM datasets d WHERE d.id = $1`,
        [datasetId],
      );
      if (Number(r.published_seq) >= Number(r.max ?? 0)) return Number(r.published_seq);
      if (Date.now() - t0 > timeoutMs) throw new Error('watermark did not catch up');
      await sleep(25);
    }
  }
  const latestVersion = (datasetId: string) =>
    one<{ id: string; version: number; status: string; fields: { name: string }[] }>(
      'SELECT * FROM schema_versions WHERE dataset_id = $1 ORDER BY version DESC LIMIT 1',
      [datasetId],
    );
  const policyVersion = async (siteId: string) =>
    (
      await one<{ policy_version: number }>('SELECT policy_version FROM sites WHERE id = $1', [
        siteId,
      ])
    ).policy_version;

  // -------------------------------------------------------------------------------------------
  describe('full demo scale (recorded proposal)', () => {
    let full: DemoPage[];
    let pub: { id: string; cookie: string };
    let other: { id: string; cookie: string };
    let siteId: string;
    let listings: string;
    let agents: string;

    beforeAll(async () => {
      full = (await demoSite(1)).pages;
      pub = await newPublisher();
      other = await newPublisher();
      const site = await one<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
         VALUES ($1, 'https://bluebonnet-full.example', 'bluebonnet', 'v', 'c', 'g', 'PROPOSING') RETURNING id`,
        [pub.id],
      );
      siteId = site.id;
      const run = await one<{ id: string }>(
        `INSERT INTO crawl_runs (site_id, trigger, status, started_at, finished_at)
         VALUES ($1, 'CONNECT', 'SUCCEEDED', now(), now()) RETURNING id`,
        [siteId],
      );
      for (let i = 0; i < full.length; i += 500) {
        const batch = full.slice(i, i + 500);
        await pool.query(
          `WITH p AS (
             INSERT INTO pages (site_id, url, last_status, fetched_at)
             SELECT $1, u.url, 200, now() FROM unnest($2::text[]) AS u(url)
             RETURNING id, url)
           INSERT INTO snapshots (page_id, http_status, html_gz, bytes)
           SELECT p.id, 200, h.gz, length(h.gz) FROM p
             JOIN unnest($2::text[], $3::bytea[]) AS h(url, gz) ON h.url = p.url`,
          [
            siteId,
            batch.map((p) => 'https://bluebonnet-full.example' + p.path),
            batch.map((p) => gzipSync(p.html)),
          ],
        );
      }
      const res = await proposeForSite({ db, model: createRecordedModel() }, siteId, {
        trigger: 'DISCOVERY',
        runId: run.id,
      });
      expect(res.status).toBe('done');
      const ds = (
        await pool.query<{ id: string; slug: string }>(
          'SELECT id, slug FROM datasets WHERE site_id = $1',
          [siteId],
        )
      ).rows;
      listings = ds.find((d) => d.slug === 'listings')!.id;
      agents = ds.find((d) => d.slug === 'agents')!.id;
    }, 240_000);

    it('tenancy: every case — another publisher gets 404 and nothing changes', async () => {
      expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
        'PATCH /api/datasets/:id',
        'POST /api/datasets/:id/approve',
        'POST /api/datasets/:id/reject',
        'POST /api/datasets/:id/unpublish',
      ]);
      const v1 = await latestVersion(listings);
      const before = await policyVersion(siteId);
      const r1 = await send('patch', `/api/datasets/${listings}`, other.cookie, {
        perRecordMicros: 2000,
        fields: [{ name: 'agent_phone', visible: true }],
      });
      const r2 = await send('post', `/api/datasets/${listings}/approve`, other.cookie, {
        schemaVersionId: v1.id,
        rightsAttested: true,
      });
      const r3 = await send('post', `/api/datasets/${listings}/reject`, other.cookie);
      const r4 = await send('post', `/api/datasets/${listings}/unpublish`, other.cookie);
      for (const r of [r1, r2, r3, r4]) {
        expect(r.status).toBe(404);
        expect(r.body.error.code).toBe('NOT_FOUND');
      }
      const ds = await one<{ status: string; price_per_record_micros: string }>(
        'SELECT status, price_per_record_micros FROM datasets WHERE id = $1',
        [listings],
      );
      expect(ds.status).toBe('PROPOSED');
      expect(Number(ds.price_per_record_micros)).toBe(1500);
      expect((await latestVersion(listings)).id).toBe(v1.id);
      expect(await policyVersion(siteId)).toBe(before);
      const approveRuns = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM crawl_runs WHERE site_id = $1 AND trigger = 'APPROVE'`,
        [siteId],
      );
      expect(approveRuns.n).toBe(0);
      // No session at all → 401.
      const anon = await agent().post(`/api/datasets/${listings}/reject`).set('Origin', APP_ORIGIN);
      expect(anon.status).toBe(401);
    });

    it('patch validation: bounds, hidden-but-filterable, unknown fields, slug clash', async () => {
      const bad = async (body: object, code = 'VALIDATION_ERROR') => {
        const r = await send('patch', `/api/datasets/${listings}`, pub.cookie, body);
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body.error.code).toBe(code);
        return r.body.error;
      };
      await bad({ perRecordMicros: 99 });
      await bad({ perRecordMicros: 100_001 });
      await bad({ perChangeMicros: 50 });
      await bad({ fields: [{ name: 'agent_phone', filterable: true }] });
      await bad({ fields: [{ name: 'price_usd', visible: false, filterable: ['lt'] }] });
      await bad({ fields: [{ name: 'no_such_field', visible: true }] });
      await bad({ slug: 'Not A Slug' });
      await bad({ slug: 'agents' });
      // Nothing was written by the failed edits.
      expect((await latestVersion(listings)).version).toBe(1);
    });

    it('patch: field edits make an OWNER version; prices and slug apply to the dataset', async () => {
      const r = await send('patch', `/api/datasets/${listings}`, pub.cookie, {
        fields: [
          { name: 'description', visible: false },
          { name: 'city', filterable: true },
        ],
        perRecordMicros: 2000,
        perChangeMicros: 600,
        slug: 'rentals',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.dataset).toMatchObject({
        slug: 'rentals',
        status: 'PROPOSED',
        perRecordMicros: 2000,
        perChangeMicros: 600,
      });
      expect(r.body.schemaVersion).toMatchObject({
        version: 2,
        status: 'PROPOSED',
        proposedBy: 'OWNER',
      });
      const v2 = await one<{
        proposed_by: string;
        fields: Record<string, unknown>[];
        extractor: unknown;
      }>('SELECT * FROM schema_versions WHERE id = $1', [r.body.schemaVersion.id]);
      const v1 = await one<{ extractor: unknown }>(
        'SELECT extractor FROM schema_versions WHERE dataset_id = $1 AND version = 1',
        [listings],
      );
      expect(v2.proposed_by).toBe('OWNER');
      expect(v2.extractor).toEqual(v1.extractor);
      const byName = new Map(v2.fields.map((f) => [f.name, f]));
      expect(byName.get('description')).toMatchObject({ visible: false, filterable: [] });
      expect(byName.get('city')).toMatchObject({ visible: true, filterable: ['eq', 'in'] });
      expect(byName.get('agent_phone')).toMatchObject({ visible: false });

      // Same edit again: no new version. Slug back so the endpoint reads `listings`.
      const again = await send('patch', `/api/datasets/${listings}`, pub.cookie, {
        fields: [{ name: 'description', visible: false }],
        slug: 'listings',
      });
      expect(again.body.schemaVersion).toBeNull();
      expect(again.body.dataset.slug).toBe('listings');
    });

    it('approve: validation (rights, no visible fields), then LIVE with 2,341 records, no AI, indexes, policy bump; double approve 409', async () => {
      const v = await latestVersion(listings);
      // rightsAttested missing / false → 400.
      for (const body of [
        { schemaVersionId: v.id },
        { schemaVersionId: v.id, rightsAttested: false },
      ]) {
        const r = await send('post', `/api/datasets/${listings}/approve`, pub.cookie, body);
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('VALIDATION_ERROR');
      }
      // Every field hidden → a version that can't be approved.
      const hideAll = await send('patch', `/api/datasets/${listings}`, pub.cookie, {
        fields: v.fields.map((f) => ({ name: f.name, visible: false })),
      });
      expect(hideAll.status).toBe(200);
      const none = await send('post', `/api/datasets/${listings}/approve`, pub.cookie, {
        schemaVersionId: hideAll.body.schemaVersion.id,
        rightsAttested: true,
      });
      expect(none.status).toBe(400);
      expect(none.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: NO_VISIBLE_FIELDS_MESSAGE,
      });
      // Back to the owner's edit (agent_phone and description hidden). Hiding cleared the
      // filters, so the owner turns them back on.
      const filters = new Set(['price_usd', 'bedrooms', 'city']);
      const visibleAgain = await send('patch', `/api/datasets/${listings}`, pub.cookie, {
        fields: v.fields
          .filter((f) => !['agent_phone', 'description', 'agent_name'].includes(f.name))
          .map((f) => ({
            name: f.name,
            visible: true,
            ...(filters.has(f.name) ? { filterable: true } : {}),
          })),
      });
      expect(visibleAgain.status, JSON.stringify(visibleAgain.body)).toBe(200);
      const target = visibleAgain.body.schemaVersion.id as string;
      const fieldsNow = (await latestVersion(listings)).fields as {
        name: string;
        visible: boolean;
        filterable?: string[];
      }[];
      expect(fieldsNow.find((f) => f.name === 'agent_phone')).toMatchObject({ visible: false });
      expect(fieldsNow.find((f) => f.name === 'price_usd')!.filterable).toEqual([
        'eq',
        'lt',
        'lte',
        'gt',
        'gte',
      ]);

      const policyBefore = await policyVersion(siteId);
      const ok = await send('post', `/api/datasets/${listings}/approve`, pub.cookie, {
        schemaVersionId: target,
        rightsAttested: true,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({
        status: 'LIVE',
        endpoint: `${APP_ORIGIN}/v1/bluebonnet/datasets/listings/records`,
      });
      expect(await policyVersion(siteId)).toBe(policyBefore + 1);

      // Double approve (same version, or the superseded one) → 409.
      for (const id of [target, hideAll.body.schemaVersion.id]) {
        const dup = await send('post', `/api/datasets/${listings}/approve`, pub.cookie, {
          schemaVersionId: id,
          rightsAttested: true,
        });
        expect(dup.status).toBe(409);
        expect(dup.body.error.code).toBe('STATE_CONFLICT');
      }
      expect(await policyVersion(siteId)).toBe(policyBefore + 1);

      const run = await waitForRun(ok.body.crawlRunId);
      expect(run).toMatchObject({
        status: 'SUCCEEDED',
        trigger: 'APPROVE',
        ai_calls: 0,
        error: null,
      });

      const ds = await one<{
        status: string;
        record_count: number;
        active_schema_id: string;
        published_seq: string;
      }>('SELECT * FROM datasets WHERE id = $1', [listings]);
      expect(ds).toMatchObject({ status: 'LIVE', record_count: 2341, active_schema_id: target });
      const counts = await one<{ n: number; phone: number; versions: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE data ? 'agent_phone')::int AS phone,
                (SELECT count(*)::int FROM record_versions WHERE dataset_id = $1 AND crawl_run_id = $2) AS versions
           FROM records WHERE dataset_id = $1 AND removed_at IS NULL`,
        [listings, ok.body.crawlRunId],
      );
      expect(counts.n).toBe(2341);
      expect(counts.versions).toBe(2341);
      // The hidden field is extracted and stored, never served or filterable.
      expect(counts.phone).toBeGreaterThan(2000);
      expect(Number(ds.published_seq)).toBeGreaterThan(0);

      const versions = (
        await pool.query<{ version: number; status: string; approved_by: string | null }>(
          'SELECT version, status, approved_by FROM schema_versions WHERE dataset_id = $1 ORDER BY version',
          [listings],
        )
      ).rows;
      expect(versions.map((x) => x.status)).toEqual([
        'SUPERSEDED',
        'SUPERSEDED',
        'SUPERSEDED',
        'APPROVED',
      ]);
      expect(versions[3]!.approved_by).toBe(pub.id);
      const site = await one<{ rights_attested_at: Date | null }>(
        'SELECT rights_attested_at FROM sites WHERE id = $1',
        [siteId],
      );
      expect(site.rights_attested_at).not.toBeNull();
      const actions = (
        await pool.query<{ action: string }>(
          `SELECT action FROM audit_events WHERE publisher_id = $1 AND action IN ('SCHEMA_APPROVED', 'DATASET_PUBLISHED') ORDER BY id`,
          [pub.id],
        )
      ).rows.map((r) => r.action);
      expect(actions).toEqual(['SCHEMA_APPROVED', 'DATASET_PUBLISHED']);

      const served = (await loadServedDataset(pool, listings))!;
      expect(served.fields.map((f) => f.name)).not.toContain('agent_phone');
      expect(() => parseQueryFilters({ agent_phone: '(512) 555-0142' }, served.fields)).toThrow();
      const indexes = (
        await pool.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'records' AND indexname LIKE 'records_f_%'`,
        )
      ).rows;
      expect(indexes.some((i) => i.indexname.startsWith('records_f_price_usd_'))).toBe(true);
      expect(indexes.some((i) => i.indexname.startsWith('records_f_city_'))).toBe(true);
      expect(indexes.some((i) => i.indexdef.includes('agent_phone'))).toBe(false);

      // EXPLAIN: SP-015's filter SQL uses the approve-time index on price_usd.
      await pool.query('ANALYZE records');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const params: unknown[] = [listings];
        const where = filterSql(
          parseQueryFilters({ 'price_usd[lt]': '900' }, served.fields),
          served.fields,
          params,
        );
        const plan = (
          await client.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN SELECT id FROM records WHERE records.dataset_id = $1 AND records.removed_at IS NULL AND ${where.join(' AND ')}`,
            params,
          )
        ).rows
          .map((r) => r['QUERY PLAN'])
          .join('\n');
        expect(plan).toMatch(/Index.*Scan.*records_f_price_usd_/);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }, 180_000);

    it('reject a proposal → REJECTED; reject again → 409', async () => {
      const r = await send('post', `/api/datasets/${agents}/reject`, pub.cookie);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: 'REJECTED' });
      const sv = await latestVersion(agents);
      expect(sv.status).toBe('REJECTED');
      const again = await send('post', `/api/datasets/${agents}/reject`, pub.cookie);
      expect(again.status).toBe(409);
      // A rejected dataset can't be edited or approved either.
      expect(
        (await send('patch', `/api/datasets/${agents}`, pub.cookie, { perRecordMicros: 900 }))
          .status,
      ).toBe(409);
      // Rejecting a LIVE dataset → 409.
      expect((await send('post', `/api/datasets/${listings}/reject`, pub.cookie)).status).toBe(409);
    });

    it('LIVE dataset: price edit bumps the policy; field edits are refused (409)', async () => {
      const before = await policyVersion(siteId);
      const r = await send('patch', `/api/datasets/${listings}`, pub.cookie, {
        perRecordMicros: 1800,
      });
      expect(r.status).toBe(200);
      expect(await policyVersion(siteId)).toBe(before + 1);
      const f = await send('patch', `/api/datasets/${listings}`, pub.cookie, {
        fields: [{ name: 'agent_phone', visible: true }],
      });
      expect(f.status).toBe(409);
      expect(f.body.error.code).toBe('STATE_CONFLICT');
    });

    it('unpublish → UNPUBLISHED, policy bump, audit; again → 409', async () => {
      const before = await policyVersion(siteId);
      const r = await send('post', `/api/datasets/${listings}/unpublish`, pub.cookie);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: 'UNPUBLISHED' });
      const ds = await one<{ status: string; record_count: number }>(
        'SELECT status, record_count FROM datasets WHERE id = $1',
        [listings],
      );
      expect(ds).toEqual({ status: 'UNPUBLISHED', record_count: 2341 });
      expect(await policyVersion(siteId)).toBe(before + 1);
      const audits = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'DATASET_UNPUBLISHED'`,
        [listings],
      );
      expect(audits.n).toBe(1);
      expect((await send('post', `/api/datasets/${listings}/unpublish`, pub.cookie)).status).toBe(
        409,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('through the crawler at DEMO_SEED_SCALE=0.05', () => {
    async function connectAndPropose(pub: { cookie: string }) {
      // Each site needs a free origin row: detach earlier sites.
      await pool.query(`UPDATE sites SET origin = origin || '/#' || id WHERE origin = $1`, [
        origin,
      ]);
      const created = await send('post', '/api/sites', pub.cookie, { origin });
      expect(created.status).toBe(201);
      const siteId = created.body.siteId as string;
      verifyToken = created.body.verify.content;
      const v = await send('post', `/api/sites/${siteId}/verify`, pub.cookie);
      expect(v.status).toBe(200);
      // Discovery crawl → schema agent (recorded) → Listing proposal.
      const t0 = Date.now();
      for (;;) {
        const ds = await pool.query<{ id: string }>(
          `SELECT id FROM datasets WHERE site_id = $1 AND slug = 'listings' AND status = 'PROPOSED'`,
          [siteId],
        );
        const site = await one<{ status: string }>('SELECT status FROM sites WHERE id = $1', [
          siteId,
        ]);
        if (ds.rows[0] && site.status === 'READY') return { siteId, datasetId: ds.rows[0].id };
        if (Date.now() - t0 > 60_000) throw new Error('no Listing proposal');
        await sleep(50);
      }
    }
    async function approve(pub: { cookie: string }, datasetId: string) {
      const sv = await latestVersion(datasetId);
      const r = await send('post', `/api/datasets/${datasetId}/approve`, pub.cookie, {
        schemaVersionId: sv.id,
        rightsAttested: true,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.crawlRunId as string;
    }
    async function crawl(pub: { cookie: string }, siteId: string, trigger: string) {
      const r = await send('post', `/api/sites/${siteId}/crawl`, pub.cookie, { trigger });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      return r.body.crawlRunId as string;
    }
    const slugOfKey = (key: string) => key.split('/').filter(Boolean).pop()!;

    it('end to end: crawl → approve → demo:mutate --prices 30 --leased 5 --new 3 → crawl → the feed has exactly the mutated records', async () => {
      const pub = await newPublisher();
      const { siteId, datasetId } = await connectAndPropose(pub);
      const approveRun = await approve(pub, datasetId);
      expect(await waitForRun(approveRun)).toMatchObject({ status: 'SUCCEEDED', ai_calls: 0 });
      await waitForPublished(datasetId);
      const before = await one<{ record_count: number }>(
        'SELECT record_count FROM datasets WHERE id = $1',
        [datasetId],
      );
      expect(before.record_count).toBeGreaterThan(100);

      let ds = (await loadServedDataset(pool, datasetId))!;
      const start = await readChanges(pool, ds, { limit: 10 });

      const entry = await store.mutate({ prices: 30, leased: 5, new: 3, seed: 1401, ping: false });
      const runId = await crawl(pub, siteId, 'DEMO_MUTATE');
      expect((await waitForRun(runId)).status).toBe('SUCCEEDED');
      await waitForPublished(datasetId);

      ds = (await loadServedDataset(pool, datasetId))!;
      const feed = await readChanges(pool, ds, { since: start.next, limit: 1000 });
      expect(feed.hasMore).toBe(false);

      const priced = new Map(entry.prices.map((p) => [p.slug, p.to]));
      const leased = new Set(entry.leased);
      const added = new Set(entry.added.map((l) => l.slug));
      const updates = feed.changes.filter((c) => c.op === 'update');
      const adds = feed.changes.filter((c) => c.op === 'add');
      expect(feed.changes.filter((c) => c.op === 'remove')).toEqual([]);
      expect(new Set(updates.map((c) => slugOfKey(c.key)))).toEqual(
        new Set([...priced.keys(), ...leased]),
      );
      expect(updates).toHaveLength(new Set([...priced.keys(), ...leased]).size);
      expect(new Set(adds.map((c) => slugOfKey(c.key)))).toEqual(added);
      expect(adds).toHaveLength(3);
      for (const c of updates) {
        const slug = slugOfKey(c.key);
        const paths = c.patch.map((op) => op.path);
        if (priced.has(slug)) {
          expect(c.patch).toContainEqual(
            expect.objectContaining({ path: '/price_usd', value: priced.get(slug) }),
          );
        }
        if (leased.has(slug)) expect(paths).toContain('/status');
        // Hidden fields never appear in a served patch.
        expect(paths).not.toContain('/agent_phone');
      }
      // The crawl's versions are tagged with the crawl run; still no AI.
      expect((await runRow(runId)).ai_calls).toBe(0);
      const after = await one<{ record_count: number }>(
        'SELECT record_count FROM datasets WHERE id = $1',
        [datasetId],
      );
      expect(after.record_count).toBe(before.record_count + 3);
    }, 180_000);

    it('approve while a crawl of the same site is running: both finish, the feed has no gaps, APPROVE has its own run', async () => {
      const pub = await newPublisher();
      const { siteId, datasetId } = await connectAndPropose(pub);
      const entry = await store.mutate({ prices: 10, leased: 2, new: 0, seed: 1402, ping: false });

      // Hold page fetches so the crawl is mid-run when we approve.
      let release!: () => void;
      hold = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
      const crawlRun = await crawl(pub, siteId, 'MANUAL');
      const reader = startFeedReader(pool, datasetId);
      const approveRun = await approve(pub, datasetId);
      expect(approveRun).not.toBe(crawlRun);
      expect((await runRow(crawlRun)).status).toBe('RUNNING');
      // Let the crawl go while the APPROVE extraction runs.
      hold.release();
      hold = null;

      const [a, c] = await Promise.all([waitForRun(approveRun), waitForRun(crawlRun)]);
      expect(a).toMatchObject({ status: 'SUCCEEDED', trigger: 'APPROVE' });
      expect(c).toMatchObject({ status: 'SUCCEEDED', trigger: 'MANUAL' });
      const published = await waitForPublished(datasetId);
      const seen = await reader.stop();

      // No gaps: the reader saw every published seq exactly once, in order.
      const all = (
        await pool.query<{ seq: string }>(
          'SELECT seq FROM record_versions WHERE dataset_id = $1 AND seq <= $2 ORDER BY seq',
          [datasetId, published],
        )
      ).rows.map((r) => Number(r.seq));
      expect(seen.map(Number)).toEqual(all);

      // The records end on the newest page content.
      for (const p of entry.prices) {
        const rec = await one<{ price: number }>(
          `SELECT (r.data->>'price_usd')::int AS price FROM records r JOIN pages p ON p.id = r.page_id
            WHERE r.dataset_id = $1 AND p.url LIKE '%/listings/' || $2`,
          [datasetId, p.slug],
        );
        expect(rec.price).toBe(p.to);
      }
      const runs = (
        await pool.query<{ trigger: string }>(
          'SELECT trigger FROM crawl_runs WHERE site_id = $1 ORDER BY created_at',
          [siteId],
        )
      ).rows.map((r) => r.trigger);
      expect(runs).toEqual(['CONNECT', 'MANUAL', 'APPROVE']);
    }, 180_000);
  });
});
