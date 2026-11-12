import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../demo-site/src/app.js';
import { openStore } from '../../../demo-site/src/data/store.js';
import { loadConfig } from '../config.js';
import { crawlSite } from '../crawl/crawlSite.js';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';
import type { CrawlDeps } from '../crawl/deps.js';
import { resetHostQueues } from '../crawl/queue.js';
import { createDb, createPool, runEvery } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import crawlScheduleJob from './crawl-schedule.job.js';
import { loadJobs } from './index.js';
import nightlyJob from './nightly-check.job.js';
import {
  NIGHTLY_EVERY_MS,
  nightlySlot,
  RECRAWL_EVERY_MS,
  recrawlReadySites,
  scheduleJobDeps,
  scheduleSlot,
  setScheduleDeps,
} from './schedule.js';

/**
 * SP-061: the 15-min scheduled re-crawl and the nightly ledger check, driven through SP-002's
 * real `runEvery` with fake timers (setTimeout / Date) against Postgres and the demo site.
 */

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const ADMIN = 'ops@spigot.test';
const SECRET = REQUIRED_ENV.SESSION_SECRET!;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe('schedule jobs are registered and off in tests unless enabled', () => {
  it('autoload with 15-min and daily intervals', async () => {
    const byName = Object.fromEntries((await loadJobs()).map((j) => [j.name, j.everyMs]));
    expect(byName).toMatchObject({
      'crawl.schedule': 15 * 60_000,
      'nightly.check': 24 * 60 * 60_000,
    });
  });

  it('scheduleJobDeps is null under vitest, so a tick touches nothing', async () => {
    expect(scheduleJobDeps()).toBeNull();
    await expect(crawlScheduleJob.run()).resolves.toBeUndefined();
    await expect(nightlyJob.run()).resolves.toBeUndefined();
  });
});

describe.skipIf(!testDatabaseUrl)(
  'SP-061 scheduled re-crawl + nightly check',
  { timeout: 60_000 },
  () => {
    let app: FastifyInstance;
    let dbUrl: string;
    let dropDb: () => Promise<void>;
    let poolB: pg.Pool;
    let deps: CrawlDeps;
    let adminCookie: string;

    const servers: Server[] = [];
    let dataDir: string;
    let store: Awaited<ReturnType<typeof openStore>>;

    beforeAll(async () => {
      const { createTestDatabase } = await import('@spigot/db/testing.mjs');
      const db = await createTestDatabase();
      dbUrl = db.url;
      dropDb = () => db.drop();
      app = await buildServer(
        loadConfig({
          ...REQUIRED_ENV,
          DATABASE_URL: db.url,
          PAYPAL_MODE: 'stub',
          ADMIN_EMAILS: ADMIN,
        }),
        { logger: false },
      );
      await app.ready();
      poolB = createPool(dbUrl, { max: 4, applicationName: 'test-b' });

      const res = await request(app.server).post('/api/auth/signup').set('Origin', ORIGIN).send({
        name: 'Ops',
        email: ADMIN,
        password: 'correct horse',
        payoutEmail: 'ops@example.com',
      });
      expect(res.status).toBe(201);
      adminCookie = cookiesOf(res);

      dataDir = await mkdtemp(join(tmpdir(), 'spigot-schedule-'));
      store = await openStore({ dataDir, scale: 0.05 });
    });
    afterAll(async () => {
      setScheduleDeps(undefined);
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await app?.close();
      await poolB?.end();
      await dropDb?.();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      resetHostQueues();
      deps = {
        db: app.db,
        crawlSecret: SECRET,
        allowLocal: true,
        appBaseUrl: 'http://spigot.test',
        minGapMs: 0,
        sleep: async () => {},
      };
    });
    afterEach(() => {
      vi.useRealTimers();
      setScheduleDeps(undefined);
    });

    /** The demo site on a fresh port: `sites.origin` is unique, so each test site gets its own. */
    async function demoOrigin(): Promise<string> {
      const server = createServer(createApp({ store }));
      servers.push(server);
      return listen(server);
    }

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    async function newSite(siteOrigin: string, status: string): Promise<string> {
      const [pub] = await q<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
        [`p-${randomUUID()}@x.test`],
      );
      const [site] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, 'v', 'pending', 'g', $3) RETURNING id`,
        [pub!.id, siteOrigin, status],
      );
      await q('UPDATE sites SET crawl_key_hash = $2 WHERE id = $1', [
        site!.id,
        crawlKeyHash(deriveCrawlKey(site!.id, SECRET)),
      ]);
      return site!.id;
    }

    /** Park every other site so each test sees only its own READY sites. */
    const parkOtherSites = () => q(`UPDATE sites SET status = 'PAUSED' WHERE status = 'READY'`);

    const runsOf = (siteId: string) =>
      q<{ id: string; trigger: string; status: string; pages_total: number; started_at: Date }>(
        `SELECT id, trigger, status, pages_total, started_at FROM crawl_runs
        WHERE site_id = $1 ORDER BY created_at`,
        [siteId],
      );

    /**
     * Start `job` under `runEvery` on a fake clock set mid-tick, advance by `advanceMs` (one tick
     * boundary), then return to real time and wait for the tick's work.
     */
    let ticksUsed = 0;
    async function tickOnce(job: {
      name: string;
      everyMs: number;
      run: () => Promise<void> | void;
    }) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      // A fresh tick each call (the previous call claimed tick + 1): `job_ticks` rightly never
      // reruns a claimed tick.
      ticksUsed += 2;
      const tick = Math.floor(Date.now() / job.everyMs) + ticksUsed;
      vi.setSystemTime(tick * job.everyMs + job.everyMs / 2);
      const ran: number[] = [];
      const errors: unknown[] = [];
      let settled!: () => void;
      const tickSettled = new Promise<void>((r) => (settled = r));
      const handle = runEvery(app.db.pool, job.name, job.everyMs, async () => job.run(), {
        onRun: (t) => ran.push(t),
        onError: (err) => errors.push(err),
        onSettled: () => settled(),
      });
      await vi.advanceTimersByTimeAsync(job.everyMs);
      vi.useRealTimers();
      await tickSettled;
      await handle.stop();
      expect(errors).toEqual([]);
      return ran;
    }

    it('a demo mutate is picked up by the next 15-min tick with no manual crawl (changed URLs only)', async () => {
      await parkOtherSites();
      const siteId = await newSite(await demoOrigin(), 'READY');
      // The site's first crawl: every page fetched once.
      const first = await crawlSite({ siteId, trigger: 'MANUAL' }, deps);
      expect(first.status).toBe('SUCCEEDED');
      const hashes = new Map(
        (
          await q<{ url: string; content_hash: string }>(
            'SELECT url, content_hash FROM pages WHERE site_id = $1',
            [siteId],
          )
        ).map((r) => [new URL(r.url).pathname, r.content_hash]),
      );

      const entry = await store.mutate({ prices: 2, leased: 1, new: 0, seed: 61, ping: false });
      expect(entry.touched.length).toBeGreaterThan(0);

      setScheduleDeps(deps);
      const ran = await tickOnce(crawlScheduleJob);
      expect(ran).toHaveLength(1);

      let scheduled!: Awaited<ReturnType<typeof runsOf>>[number];
      await vi.waitFor(
        async () => {
          const runs = (await runsOf(siteId)).filter((r) => r.trigger === 'SCHEDULE');
          expect(runs).toHaveLength(1);
          expect(runs[0]!.status).toBe('SUCCEEDED');
          scheduled = runs[0]!;
        },
        { timeout: 20_000, interval: 50 },
      );

      // Changed URLs only: every page the mutate touched was refetched with new content; anything
      // else selected is a spare conditional GET (lastmod in the first crawl's second, a 304) whose
      // content is unchanged. Nowhere near a full re-crawl.
      const fetched = await q<{ url: string; content_hash: string }>(
        'SELECT url, content_hash FROM pages WHERE site_id = $1 AND fetched_at >= $2',
        [siteId, scheduled.started_at],
      );
      const byPath = new Map(fetched.map((r) => [new URL(r.url).pathname, r.content_hash]));
      for (const path of entry.touched) {
        expect(byPath.has(path), path).toBe(true);
        expect(byPath.get(path), path).not.toBe(hashes.get(path));
      }
      for (const [path, hash] of byPath) {
        if (!entry.touched.includes(path)) expect(hash, path).toBe(hashes.get(path));
      }
      expect(scheduled.pages_total).toBe(fetched.length);
      expect(scheduled.pages_total).toBeLessThan(hashes.size / 4);
    });

    it('only READY sites are crawled, and a site with a live run is skipped', async () => {
      await parkOtherSites();
      const ready = await newSite(await demoOrigin(), 'READY');
      const busy = await newSite('http://127.0.0.1:9', 'READY');
      for (const status of ['PENDING_VERIFY', 'VERIFIED', 'PROPOSING', 'PAUSED']) {
        await newSite(`http://127.0.0.1:9/${status}`, status);
      }
      const [live] = await q<{ id: string }>(
        `INSERT INTO crawl_runs (site_id, trigger, status) VALUES ($1, 'MANUAL', 'RUNNING') RETURNING id`,
        [busy],
      );

      const out = await recrawlReadySites(deps);
      expect(out.map(({ siteId, outcome }) => ({ siteId, outcome }))).toEqual([
        { siteId: ready, outcome: 'STARTED' },
        { siteId: busy, outcome: 'SKIPPED_LIVE' },
      ]);
      expect(out[1]!.runId).toBe(live!.id);
      await Promise.all(out.map((o) => o.done));
      expect((await runsOf(busy)).map((r) => r.id)).toEqual([live!.id]);
      const [run] = (await runsOf(ready)).filter((r) => r.trigger === 'SCHEDULE');
      expect(run!.status).toBe('SUCCEEDED');
    });

    it('two processes ticking at once start one SCHEDULE run per site', async () => {
      await parkOtherSites();
      const a = await newSite(await demoOrigin(), 'READY');
      const b = await newSite(await demoOrigin(), 'READY');
      const depsB: CrawlDeps = { ...deps, db: createDb(poolB) };

      // Each round is its own tick; both processes scan the same one.
      const first = scheduleSlot();
      for (let round = 0; round < 3; round++) {
        const slot = { slot: first + round };
        const results = await Promise.all([
          recrawlReadySites(deps, slot),
          recrawlReadySites(depsB, slot),
        ]);
        for (const siteId of [a, b]) {
          const started = results
            .flat()
            .filter((o) => o.siteId === siteId && o.outcome === 'STARTED');
          expect(started).toHaveLength(1);
        }
        await Promise.all(results.flat().map((o) => o.done));
      }
      for (const siteId of [a, b]) {
        const runs = (await runsOf(siteId)).filter((r) => r.trigger === 'SCHEDULE');
        expect(runs).toHaveLength(3);
        expect(runs.every((r) => r.status === 'SUCCEEDED')).toBe(true);
      }
    });

    it('crawl.schedule and nightly.check at 00:00 start one SCHEDULE run per site, even after the first ended', async () => {
      await parkOtherSites();
      const siteId = await newSite(await demoOrigin(), 'READY');
      const day = Math.floor(Date.now() / NIGHTLY_EVERY_MS) + 1;
      // The 15-min tick at the same 00:00 is the nightly tick's slot.
      const quarter = day * (NIGHTLY_EVERY_MS / RECRAWL_EVERY_MS);
      expect(nightlySlot(day)).toBe(quarter);

      setScheduleDeps(deps);
      await crawlScheduleJob.run(quarter);
      // Let that run end: no live run guards the site any more, only the slot's claim does.
      await vi.waitFor(
        async () => expect((await runsOf(siteId)).map((r) => r.status)).toEqual(['SUCCEEDED']),
        { timeout: 20_000, interval: 50 },
      );
      // nightlyCheck's re-crawl for the same tick, on the other process.
      const out = await recrawlReadySites(
        { ...deps, db: createDb(poolB) },
        { slot: nightlySlot(day) },
      );
      expect(out).toMatchObject([{ siteId, outcome: 'ALREADY_SCHEDULED' }]);
      expect((await runsOf(siteId)).filter((r) => r.trigger === 'SCHEDULE')).toHaveLength(1);

      // The next 15-min tick crawls again.
      const next = await recrawlReadySites(deps, { slot: quarter + 1 });
      expect(next).toMatchObject([{ siteId, outcome: 'STARTED' }]);
      await next[0]!.done;
      expect((await runsOf(siteId)).filter((r) => r.trigger === 'SCHEDULE')).toHaveLength(2);
    });

    it('a live run whose process died is adopted and finished instead of skipped', async () => {
      await parkOtherSites();
      const siteId = await newSite(await demoOrigin(), 'READY');
      const [orphan] = await q<{ id: string }>(
        `INSERT INTO crawl_runs (site_id, trigger, status) VALUES ($1, 'SCHEDULE', 'QUEUED') RETURNING id`,
        [siteId],
      );
      // staleRunMs 0: no heartbeat is fresh enough, as if the owner died long ago.
      const out = await recrawlReadySites({ ...deps, staleRunMs: 0 });
      expect(out).toMatchObject([{ siteId, outcome: 'RESUMED', runId: orphan!.id }]);
      expect((await out[0]!.done)?.status).toBe('SUCCEEDED');
      expect(await runsOf(siteId)).toHaveLength(1);
    });

    describe('nightly ledger check', () => {
      const health = () => request(app.server).get('/admin/health').set('Cookie', adminCookie);
      const alerts = () =>
        q<{ data: { kind: string; trigger: string; mismatches: number; detail: unknown[] } }>(
          `SELECT data FROM audit_events WHERE action = 'ALERT' AND entity = 'ledger_check' ORDER BY id`,
        );

      it('an injected ledger mismatch flips /admin/health to degraded; a clean check clears it', async () => {
        await parkOtherSites();
        // Before any recorded check: no ledger flag.
        const before = await health();
        expect(before.status).toBe(200);
        expect(before.body.status).toBe('ok');
        expect(before.body.checks.ledger).toMatchObject({ ok: true, lastCheckedAt: null });

        const platform = await app.db.tx((tx) => platformAccounts(tx));
        const buyer = await app.db.tx(async (tx) => {
          const id = await getOrCreateAccount(tx, 'BUYER_BALANCE', randomUUID());
          await post(tx, {
            kind: 'TOPUP',
            idempotencyKey: `topup:${randomUUID()}`,
            entries: topupEntries({ buyer: id, paypalCash: platform.paypalCash }, 5_000_000),
          });
          return id;
        });
        // Tampering on purpose to prove the nightly check catches it; app code never does this.
        await q('UPDATE ledger_accounts SET balance_micros = balance_micros + 7 WHERE id = $1', [
          buyer,
        ]);

        setScheduleDeps(deps);
        expect(await tickOnce(nightlyJob)).toHaveLength(1);

        const degraded = await health();
        expect(degraded.body.status).toBe('degraded');
        expect(degraded.body.checks.ledger).toMatchObject({
          ok: false,
          error: 'LEDGER_MISMATCH',
          trigger: 'NIGHTLY',
          mismatches: 2,
        });
        // The other dependencies are fine: the ledger alone degraded it.
        expect(degraded.body.checks.paypal.ok).toBe(true);
        expect(degraded.body.checks.db.ok).toBe(true);

        const rows = await alerts();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.data).toMatchObject({
          kind: 'LEDGER_MISMATCH',
          trigger: 'NIGHTLY',
          mismatches: 2,
        });
        expect(rows[0]!.data.detail).toEqual([
          { check: 'GLOBAL_SUM', expectedMicros: 0, actualMicros: 7 },
          expect.objectContaining({ check: 'ACCOUNT_BALANCE', accountId: buyer }),
        ]);
        const [checked] = await q<{ actor_type: string; data: Record<string, unknown> }>(
          `SELECT actor_type, data FROM audit_events WHERE action = 'LEDGER_CHECKED' ORDER BY id DESC LIMIT 1`,
        );
        expect(checked).toMatchObject({
          actor_type: 'SYSTEM',
          data: { trigger: 'NIGHTLY', ok: false, mismatches: 2 },
        });

        // Fixed, then re-checked by an admin: health clears, no new alert.
        await q('UPDATE ledger_accounts SET balance_micros = balance_micros - 7 WHERE id = $1', [
          buyer,
        ]);
        const recheck = await request(app.server)
          .post('/admin/ledger/check')
          .set('Origin', ORIGIN)
          .set('Cookie', adminCookie);
        expect(recheck.status).toBe(200);
        expect(recheck.body).toMatchObject({ sumMicros: 0, mismatches: [] });
        const ok = await health();
        expect(ok.body.status).toBe('ok');
        expect(ok.body.checks.ledger).toMatchObject({ ok: true, trigger: 'MANUAL', mismatches: 0 });
        expect(await alerts()).toHaveLength(1);
      });

      it('the nightly tick also re-reads READY sites’ sitemaps (trigger=SCHEDULE)', async () => {
        await parkOtherSites();
        const siteId = await newSite(await demoOrigin(), 'READY');
        setScheduleDeps(deps);
        expect(await tickOnce(nightlyJob)).toHaveLength(1);
        await vi.waitFor(
          async () => {
            const runs = await runsOf(siteId);
            expect(runs.map((r) => [r.trigger, r.status])).toEqual([['SCHEDULE', 'SUCCEEDED']]);
          },
          { timeout: 20_000, interval: 50 },
        );
      });
    });
  },
);
