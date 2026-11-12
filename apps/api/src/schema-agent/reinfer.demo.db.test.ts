import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp, type DemoLayout } from '../../../demo-site/src/app.js';
import { openStore, type Store } from '../../../demo-site/src/data/store.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { resetHostQueues } from '../crawl/queue.js';
import { createDb, createPool } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { loadServedDataset, queryRecords } from '../records/query.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { versions } from '../test/extract-fixtures.js';
import { createRecordedModel } from './claude.js';
import { findReinferable, reinferDataset } from './reinfer.js';

/**
 * SP-052b acceptance (recorded-mode golden test for the v2 Listing), through the real API,
 * crawler and demo site (DEMO_SEED_SCALE=0.05, SCHEMA_AGENT_MODE=recorded):
 * v1 approved → DEMO_LAYOUT=v2 + crawl → LIVE_STALE (SP-052a) → the re-proposal runs on its own
 * and keeps every field name / type / the record key → W06 read shows the diff of sources →
 * approve v2 → LIVE, `stale_since = null`, every page re-extracted: values that changed while
 * stale are updated, no field is renamed, no record re-keyed. Plus idempotency and tenancy.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-052b re-inference (Postgres + demo site)', () => {
  let tdb: TestDatabase;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let dataDir: string;
  let store: Store;
  let origin: string;
  let originServer: Server;
  let verifyToken: string | undefined;
  let layout: DemoLayout = 'v1';
  const layoutSince = new Date();
  const prevGap = process.env.CRAWL_MIN_GAP_MS;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    pool = createPool(tdb.url, { max: 6, applicationName: 'reinfer-test' });
    dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp052b-'));
    store = await openStore({ dataDir, scale: 0.05 });
    const quiet = createAccessLog(() => {});
    originServer = createServer((req, res) =>
      createApp({ store, accessLog: quiet, verifyToken, layout, layoutSince })(req, res),
    );
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
    layout = 'v1';
  });

  const send = (url: string, cookie: string, body?: object) => {
    const r = request(app.server).post(url).set('Origin', APP_ORIGIN).set('Cookie', cookie);
    return body === undefined ? r : r.send(body);
  };
  const get = (url: string, cookie: string) =>
    request(app.server).get(url).set('Origin', APP_ORIGIN).set('Cookie', cookie);
  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows[0] as T;

  async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null>, ms = 60_000) {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }
  const waitForRun = (runId: string) =>
    waitFor(`run ${runId}`, async () => {
      const r = await one<{ status: string; ai_calls: number }>(
        'SELECT status, ai_calls FROM crawl_runs WHERE id = $1',
        [runId],
      );
      return TERMINAL.includes(r.status) ? r : null;
    });
  const schemaVersions = async (datasetId: string) =>
    (
      await pool.query<{
        id: string;
        version: number;
        status: string;
        proposed_by: string;
        fields: { name: string; type: string; visible: boolean; filterable: string[] }[];
        extractor: { fields: { name: string; source: unknown }[] };
        record_key: unknown;
        sample_stats: { fields: Record<string, { nullRate: number }>; dropped: unknown[] };
      }>(
        `SELECT id, version, status, proposed_by, fields, extractor, record_key, sample_stats
           FROM schema_versions WHERE dataset_id = $1 ORDER BY version`,
        [datasetId],
      )
    ).rows;

  async function signup() {
    const res = await send('/api/auth/signup', '', {
      name: 'Bluebonnet',
      email: `p-${randomUUID()}@example.com`,
      password: 'correct horse',
      payoutEmail: 'payouts@example.com',
    });
    expect(res.status).toBe(201);
    return cookiesOf(res);
  }

  /** Sign up, connect + verify the demo site, approve the Listing proposal, extract. */
  async function liveListingDataset() {
    const cookie = await signup();
    await pool.query(`UPDATE sites SET origin = origin || '/#' || id WHERE origin = $1`, [origin]);
    const created = await send('/api/sites', cookie, { origin });
    expect(created.status).toBe(201);
    const siteId = created.body.siteId as string;
    verifyToken = created.body.verify.content;
    expect((await send(`/api/sites/${siteId}/verify`, cookie)).status).toBe(200);
    const datasetId = await waitFor('Listing proposal', async () => {
      const ds = await one<{ id: string } | undefined>(
        `SELECT d.id FROM datasets d JOIN sites s ON s.id = d.site_id
          WHERE d.site_id = $1 AND d.slug = 'listings' AND d.status = 'PROPOSED' AND s.status = 'READY'`,
        [siteId],
      );
      return ds?.id;
    });
    const [sv] = await schemaVersions(datasetId);
    const approved = await send(`/api/datasets/${datasetId}/approve`, cookie, {
      schemaVersionId: sv!.id,
      rightsAttested: true,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await waitForRun(approved.body.crawlRunId)).status).toBe('SUCCEEDED');
    const crawl = async (trigger: string) => {
      const r = await send(`/api/sites/${siteId}/crawl`, cookie, { trigger });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      return r.body.crawlRunId as string;
    };
    return { cookie, siteId, datasetId, crawl };
  }

  it('v2 layout → re-proposal keeps every field name; approve → LIVE; records updated with no field renames', async () => {
    const { cookie, datasetId, crawl } = await liveListingDataset();
    const [v1] = await schemaVersions(datasetId);
    let ds = (await loadServedDataset(pool, datasetId))!;
    const before = await queryRecords(pool, ds, { limit: 1000 });
    const fieldsBefore = new Set(before.records.flatMap((r) => Object.keys(r.data)));
    expect(before.records.length).toBeGreaterThan(100);

    // The redesign ships, and prices change while the dataset is stale.
    layout = 'v2';
    const changed = await store.mutate({ prices: 6, leased: 0, new: 0, seed: 5301, ping: false });
    const run = await crawl('MANUAL');
    expect(await waitForRun(run)).toMatchObject({ status: 'SUCCEEDED', ai_calls: 0 });
    expect(await one('SELECT status FROM datasets WHERE id = $1', [datasetId])).toEqual({
      status: 'LIVE_STALE',
    });
    expect(await versions(pool, datasetId, run)).toEqual([]);

    // Auto-run: the crawl's onRunFinished hook re-infers in the background.
    const v2 = await waitFor('re-proposal', async () =>
      (await schemaVersions(datasetId)).find((v) => v.version === 2),
    );
    expect(await schemaVersions(datasetId)).toHaveLength(2);
    expect(v2).toMatchObject({ status: 'PROPOSED', proposed_by: 'AI', record_key: v1!.record_key });
    // Every field name and type, in order; owner's visibility / filters kept.
    expect(v2.fields.map((f) => [f.name, f.type, f.visible, f.filterable])).toEqual(
      v1!.fields.map((f) => [f.name, f.type, f.visible, f.filterable]),
    );
    expect(v2.sample_stats.dropped).toEqual([]);
    for (const [name, s] of Object.entries(v2.sample_stats.fields))
      expect(s.nullRate, name).toBe(0);
    const src = (v: typeof v2, n: string) => v.extractor.fields.find((f) => f.name === n)!.source;
    expect(src(v2, 'available_from')).toEqual({ css: 'time.move-in-date', attr: 'datetime' });
    expect(src(v2, 'price_usd')).toEqual(src(v1!, 'price_usd'));

    const audit = await one<{ data: Record<string, unknown> }>(
      `SELECT data FROM audit_events WHERE action = 'SCHEMA_PROPOSED' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [datasetId],
    );
    expect(audit.data).toMatchObject({
      reinfer: true,
      trigger: 'DRIFT',
      label: 'replayed proposal',
      schemaVersionId: v2.id,
      fromSchemaVersionId: v1!.id,
      modelCalls: 1,
    });
    // A routine crawl never carries AI calls, even the one that found the drift.
    expect((await waitForRun(run)).ai_calls).toBe(0);

    // W06 read: stale banner data and the diff of sources.
    const detail = await get(`/api/datasets/${datasetId}`, cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('LIVE_STALE');
    expect(new Date(detail.body.lastGoodExtractAt).getTime()).toBeLessThanOrEqual(
      new Date(detail.body.staleSince).getTime(),
    );
    expect(detail.body.reinference).toMatchObject({
      state: 'PROPOSED',
      schemaVersionId: v2.id,
      version: 2,
    });
    const diff = detail.body.reinference.sources as { name: string; changed: boolean }[];
    expect(diff.map((d) => d.name)).toEqual(v1!.fields.map((f) => f.name));
    expect(
      diff
        .filter((d) => d.changed)
        .map((d) => d.name)
        .sort(),
    ).toEqual(['agent_name', 'agent_phone', 'available_from', 'pets_allowed', 'status'].sort());
    expect(detail.body.latestSchemaVersion).toMatchObject({ id: v2.id, status: 'PROPOSED' });

    // The endpoint is idempotent: the pending re-proposal, no second model call.
    const again = await send(`/api/datasets/${datasetId}/reinfer`, cookie);
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ status: 'PROPOSED', schemaVersionId: v2.id, version: 2 });
    expect(await schemaVersions(datasetId)).toHaveLength(2);
    expect(await findReinferable(pool, 0)).not.toContain(datasetId);

    // Approve v2 → LIVE, stale_since cleared, every page re-extracted.
    const approved = await send(`/api/datasets/${datasetId}/approve`, cookie, {
      schemaVersionId: v2.id,
      rightsAttested: true,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await waitForRun(approved.body.crawlRunId)).toMatchObject({
      status: 'SUCCEEDED',
      ai_calls: 0,
    });
    expect(
      await one('SELECT status, stale_since, active_schema_id FROM datasets WHERE id = $1', [
        datasetId,
      ]),
    ).toEqual({ status: 'LIVE', stale_since: null, active_schema_id: v2.id });
    expect((await schemaVersions(datasetId)).map((v) => [v.version, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'APPROVED'],
    ]);

    ds = (await loadServedDataset(pool, datasetId))!;
    const after = await queryRecords(pool, ds, { limit: 1000 });
    // Same records (no re-keying), same field names (no renames), stale flag gone.
    expect(after.records.map((r) => r.key).sort()).toEqual(before.records.map((r) => r.key).sort());
    expect(new Set(after.records.flatMap((r) => Object.keys(r.data)))).toEqual(fieldsBefore);
    expect(after.records.every((r) => r.freshness.staleSince === null)).toBe(true);
    // The prices that changed while stale are now updated; the rest are unchanged.
    const byKey = new Map(after.records.map((r) => [r.key, r]));
    const updatedKeys = new Set(changed.prices.map((p) => `listings/${p.slug}`));
    for (const p of changed.prices) {
      expect(byKey.get(`listings/${p.slug}`)!.data.price_usd, p.slug).toBe(p.to);
    }
    const approveVersions = await versions(pool, datasetId, approved.body.crawlRunId);
    expect(approveVersions.every((v) => v.op === 'update')).toBe(true);
    expect(new Set(approveVersions.map((v) => `listings/${v.record_key}`))).toEqual(updatedKeys);
    for (const r of before.records) {
      if (!updatedKeys.has(r.key)) expect(byKey.get(r.key)!.data, r.key).toEqual(r.data);
    }

    // The next v2 crawl is healthy: no drift against the new baseline, versions written.
    const later = await store.mutate({ prices: 3, leased: 0, new: 0, seed: 5302, ping: false });
    const run2 = await crawl('DEMO_MUTATE');
    expect(await waitForRun(run2)).toMatchObject({ status: 'SUCCEEDED', ai_calls: 0 });
    expect(await versions(pool, datasetId, run2)).toHaveLength(later.prices.length);
    expect(await one('SELECT status FROM datasets WHERE id = $1', [datasetId])).toEqual({
      status: 'LIVE',
    });
  }, 240_000);

  it('concurrent re-inference makes one version; the endpoint is owner-only and LIVE_STALE-only', async () => {
    const { cookie, datasetId } = await liveListingDataset();
    // LIVE: nothing to re-infer.
    const live = await send(`/api/datasets/${datasetId}/reinfer`, cookie);
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe('STATE_CONFLICT');

    // Drift without a crawl hook in play: flip the dataset stale directly.
    await pool.query(
      `UPDATE datasets SET status = 'LIVE_STALE', stale_since = now() WHERE id = $1`,
      [datasetId],
    );
    layout = 'v2';
    // Re-fetch the pages in the new layout so the model sees v2 (a crawl would; the dataset is
    // already stale, so the crawl writes no versions and its hook starts a re-inference too).
    const db = createDb(pool);
    const deps = { db, model: createRecordedModel() };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => reinferDataset(deps, datasetId, { trigger: 'OWNER' })),
    );
    const statuses = results.map((r) => r.status).sort();
    // Exactly one runner proposes (it sees the v1 pages: the self-check keeps or drops fields,
    // never renames); the rest find the lock busy or the pending re-proposal.
    expect(statuses.filter((s) => s === 'proposed')).toHaveLength(1);
    expect(statuses.every((s) => ['proposed', 'busy', 'existing'].includes(s))).toBe(true);
    const all = await schemaVersions(datasetId);
    expect(all.map((v) => v.version)).toEqual([1, 2]);
    expect(all[1]!.fields.every((f) => all[0]!.fields.some((o) => o.name === f.name))).toBe(true);
    expect((await reinferDataset(deps, datasetId, { trigger: 'SWEEP' })).status).toBe('existing');

    // Another publisher: 404, nothing written.
    const other = await signup();
    const foreign = await send(`/api/datasets/${datasetId}/reinfer`, other);
    expect(foreign.status).toBe(404);
    expect(await schemaVersions(datasetId)).toHaveLength(2);
    // No session: 401.
    expect((await send(`/api/datasets/${datasetId}/reinfer`, '')).status).toBe(401);
  }, 180_000);
});
