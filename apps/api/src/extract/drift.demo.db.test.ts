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
import { createPool } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { loadServedDataset, queryRecords } from '../records/query.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { versions } from '../test/extract-fixtures.js';

/**
 * SP-052a acceptance, through the real API, crawler and demo site (DEMO_SEED_SCALE=0.05, the
 * recorded Listing proposal, so `sample_stats` comes from the real self-check):
 * - a normal `demo:mutate` run doesn't trigger drift, and its versions are written before the
 *   run turns terminal (also with fewer than 20 changed pages);
 * - `DEMO_LAYOUT=v2` + crawl → LIVE_STALE, **0** versions for the Listing dataset, records still
 *   served with their last good values and `freshness.staleSince`.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)(
  'SP-052a drift through the crawler (Postgres + demo site)',
  () => {
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
      pool = createPool(tdb.url, { max: 4, applicationName: 'drift-test' });
      dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp052a-'));
      store = await openStore({ dataDir, scale: 0.05 });
      const quiet = createAccessLog(() => {});
      // The demo site, rebuilt per request so a test can flip DEMO_LAYOUT like a redeploy.
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
    const one = async <T>(sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows[0] as T;

    async function waitForRun(runId: string, timeoutMs = 120_000) {
      const t0 = Date.now();
      for (;;) {
        const r = await one<{ status: string; ai_calls: number }>(
          'SELECT status, ai_calls FROM crawl_runs WHERE id = $1',
          [runId],
        );
        if (TERMINAL.includes(r.status)) return r;
        if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} did not end`);
        await sleep(25);
      }
    }
    /** The run-end hooks are done: the drift backstop has written its result (or there was none). */
    async function waitForBackstop(datasetId: string, runId: string, timeoutMs = 20_000) {
      const t0 = Date.now();
      for (;;) {
        const r = await one<{ status: string; backstop: { drift: boolean } | null } | undefined>(
          'SELECT status, backstop FROM drift_checks WHERE dataset_id = $1 AND run_id = $2',
          [datasetId, runId],
        );
        if (r && (r.backstop || r.status === 'DRIFTED')) return r;
        if (Date.now() - t0 > timeoutMs) throw new Error('drift check did not finish');
        await sleep(25);
      }
    }
    const alerts = async (datasetId: string) =>
      (
        await pool.query<{ data: { kind: string; phase: string; runId: string } }>(
          `SELECT data FROM audit_events WHERE action = 'ALERT' AND entity_id = $1 ORDER BY id`,
          [datasetId],
        )
      ).rows.map((r) => r.data);

    /** Sign up, connect + verify the demo site, wait for the Listing proposal, approve it. */
    async function liveListingDataset() {
      const res = await send('/api/auth/signup', '', {
        name: 'Bluebonnet',
        email: `p-${randomUUID()}@example.com`,
        password: 'correct horse',
        payoutEmail: 'payouts@example.com',
      });
      expect(res.status).toBe(201);
      const cookie = cookiesOf(res);
      await pool.query(`UPDATE sites SET origin = origin || '/#' || id WHERE origin = $1`, [
        origin,
      ]);
      const created = await send('/api/sites', cookie, { origin });
      expect(created.status).toBe(201);
      const siteId = created.body.siteId as string;
      verifyToken = created.body.verify.content;
      expect((await send(`/api/sites/${siteId}/verify`, cookie)).status).toBe(200);
      let datasetId: string | undefined;
      const t0 = Date.now();
      while (!datasetId) {
        const ds = await one<{ id: string } | undefined>(
          `SELECT d.id FROM datasets d JOIN sites s ON s.id = d.site_id
          WHERE d.site_id = $1 AND d.slug = 'listings' AND d.status = 'PROPOSED' AND s.status = 'READY'`,
          [siteId],
        );
        datasetId = ds?.id;
        if (Date.now() - t0 > 60_000) throw new Error('no Listing proposal');
        if (!datasetId) await sleep(50);
      }
      const sv = await one<{ id: string; sample_stats: unknown }>(
        'SELECT id, sample_stats FROM schema_versions WHERE dataset_id = $1 ORDER BY version DESC LIMIT 1',
        [datasetId],
      );
      // The baseline the probe compares with: the self-check's null rates.
      expect(sv.sample_stats).toMatchObject({ fields: { available_from: { nullRate: 0 } } });
      const approved = await send(`/api/datasets/${datasetId}/approve`, cookie, {
        schemaVersionId: sv.id,
        rightsAttested: true,
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await waitForRun(approved.body.crawlRunId)).status).toBe('SUCCEEDED');
      const crawl = async (trigger: string) => {
        const r = await send(`/api/sites/${siteId}/crawl`, cookie, { trigger });
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        return r.body.crawlRunId as string;
      };
      return { siteId, datasetId, crawl };
    }

    it('a normal demo:mutate run does not trigger drift; held pages are written before the run ends', async () => {
      const { datasetId, crawl } = await liveListingDataset();

      // ≥ 20 changed pages: the probe passes mid-run.
      const big = await store.mutate({ prices: 30, leased: 5, new: 3, seed: 5201, ping: false });
      const run1 = await crawl('DEMO_MUTATE');
      expect(await waitForRun(run1)).toMatchObject({ status: 'SUCCEEDED', ai_calls: 0 });
      const c1 = await waitForBackstop(datasetId, run1);
      expect(c1).toMatchObject({ status: 'PASSED', backstop: { drift: false } });
      const v1 = await versions(pool, datasetId, run1);
      expect(v1.filter((v) => v.op === 'update')).toHaveLength(
        new Set([...big.prices.map((p) => p.slug), ...big.leased]).size,
      );
      expect(v1.filter((v) => v.op === 'add')).toHaveLength(3);

      // < 20 changed pages: held, then probed and written at run ending, before the run is terminal.
      await store.mutate({ prices: 4, leased: 0, new: 0, seed: 5202, ping: false });
      const run2 = await crawl('DEMO_MUTATE');
      expect((await waitForRun(run2)).status).toBe('SUCCEEDED');
      expect(await versions(pool, datasetId, run2)).toHaveLength(4);
      expect(await waitForBackstop(datasetId, run2)).toMatchObject({ status: 'PASSED' });

      expect(
        await one('SELECT status, stale_since FROM datasets WHERE id = $1', [datasetId]),
      ).toEqual({ status: 'LIVE', stale_since: null });
      expect(await alerts(datasetId)).toEqual([]);
    }, 180_000);

    it('DEMO_LAYOUT=v2 + crawl → LIVE_STALE, 0 versions; the API still serves the last good values with staleSince', async () => {
      const { datasetId, crawl } = await liveListingDataset();
      let ds = (await loadServedDataset(pool, datasetId))!;
      const before = await queryRecords(pool, ds, { limit: 1000 });
      expect(before.records.length).toBeGreaterThan(100);
      expect(before.records.every((r) => r.freshness.staleSince === null)).toBe(true);
      const seqBefore = (await versions(pool, datasetId)).length;

      layout = 'v2';
      const run = await crawl('MANUAL');
      expect(await waitForRun(run)).toMatchObject({ status: 'SUCCEEDED', ai_calls: 0 });
      const check = await waitForBackstop(datasetId, run);
      expect(check.status).toBe('DRIFTED');

      // Every listing page changed, yet the Listing dataset got no version at all.
      const runRow = await one<{ pages_fetched: number }>(
        'SELECT pages_fetched FROM crawl_runs WHERE id = $1',
        [run],
      );
      expect(runRow.pages_fetched).toBeGreaterThanOrEqual(before.records.length);
      expect(await versions(pool, datasetId, run)).toEqual([]);
      expect(await versions(pool, datasetId)).toHaveLength(seqBefore);

      const d = await one<{ status: string; stale_since: Date | null }>(
        'SELECT status, stale_since FROM datasets WHERE id = $1',
        [datasetId],
      );
      expect(d.status).toBe('LIVE_STALE');
      expect(d.stale_since).toBeInstanceOf(Date);
      const al = await alerts(datasetId);
      expect(al).toHaveLength(1);
      expect(al[0]).toMatchObject({ kind: 'DATASET_DRIFT', phase: 'probe', runId: run });

      // Served: same records and values, now with freshness.staleSince.
      ds = (await loadServedDataset(pool, datasetId))!;
      const after = await queryRecords(pool, ds, { limit: 1000 });
      const strip = (rs: typeof after.records) =>
        rs.map((r) => ({ key: r.key, data: r.data, version: r.version }));
      expect(strip(after.records)).toEqual(strip(before.records));
      expect(
        after.records.every((r) => r.freshness.staleSince === d.stale_since!.toISOString()),
      ).toBe(true);

      // A later crawl (still v2, a demo mutation on top) writes nothing either.
      await store.mutate({ prices: 5, leased: 0, new: 0, seed: 5203, ping: false });
      const run2 = await crawl('DEMO_MUTATE');
      expect((await waitForRun(run2)).status).toBe('SUCCEEDED');
      await sleep(200);
      expect(await versions(pool, datasetId, run2)).toEqual([]);
      expect(await alerts(datasetId)).toHaveLength(1);
    }, 180_000);
  },
);
