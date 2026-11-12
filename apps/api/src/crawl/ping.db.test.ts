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
import { createApp } from '../../../demo-site/src/app.js';
import { openStore, type Store } from '../../../demo-site/src/data/store.js';
import { pingSpigot, pingUrls } from '../../../demo-site/src/ping.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { createDb, createPool, type Db } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { readChanges } from '../records/changes.js';
import { loadServedDataset } from '../records/query.js';
import { cases } from '../security/tenancy/ping.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { crawlKeyHash, deriveCrawlKey } from './crawlKey.js';
import type { CrawlDeps } from './deps.js';
import { queuePings } from './ping.js';
import { requestPing } from './pingApi.js';
import { resetHostQueues } from './queue.js';

/**
 * SP-055 CMS ping, against the real demo site at DEMO_SEED_SCALE=0.05 and the real crawler:
 * the acceptance beat (`demo:mutate --prices 3 --ping` → 3 update changes within 30 s, no full
 * crawl), auth / validation / rate limit / tenancy, a ping joining a live run, a new page the
 * sitemap only just listed, and pings racing run ends (no ping is ever lost).
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-055 CMS ping (Postgres + demo site)', () => {
  let tdb: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let app: FastifyInstance;
  let apiBase: string;
  let dataDir: string;
  let store: Store;
  let origin: string;
  let originServer: Server;
  let verifyToken: string | undefined;
  let hold: { promise: Promise<void>; release: () => void } | null = null;
  const prevGap = process.env.CRAWL_MIN_GAP_MS;

  // The connected, approved demo site.
  let pub: { id: string; cookie: string };
  let siteId: string;
  let crawlKey: string;
  let gateKey: string;
  let datasetId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    pool = createPool(tdb.url, { max: 6, applicationName: 'ping-test' });
    db = createDb(pool);
    dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp055-'));
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
    // A real listener: the demo-site CLI's ping goes over HTTP, as it would in the demo.
    apiBase = await app.listen({ port: 0, host: '127.0.0.1' });

    pub = await newPublisher();
    ({ siteId, crawlKey, gateKey, datasetId } = await connectAndApprove(pub));
  }, 180_000);
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
  const ping = (id: string, auth: string | null, body: object) => {
    const r = agent().post(`/api/sites/${id}/ping`);
    return (auth === null ? r : r.set('Authorization', auth)).send(body);
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
    one<{
      status: string;
      trigger: string;
      ai_calls: number;
      pages_total: number;
      pages_fetched: number;
      pages_not_modified: number;
      pages_failed: number;
    }>('SELECT * FROM crawl_runs WHERE id = $1', [id]);
  async function waitForRun(runId: string, timeoutMs = 120_000) {
    const t0 = Date.now();
    for (;;) {
      const r = await runRow(runId);
      if (TERMINAL.includes(r.status)) return r;
      if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} did not end`);
      await sleep(25);
    }
  }
  async function waitForIdle(timeoutMs = 60_000) {
    const t0 = Date.now();
    for (;;) {
      const live = await pool.query(
        `SELECT 1 FROM crawl_runs WHERE site_id = $1 AND status IN ('QUEUED', 'RUNNING')`,
        [siteId],
      );
      if (!live.rowCount) return;
      if (Date.now() - t0 > timeoutMs) throw new Error('runs did not end');
      await sleep(25);
    }
  }
  async function waitForPublished(timeoutMs = 20_000) {
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
  const pendingPings = async (id = siteId) =>
    Number(
      (await one<{ n: string }>('SELECT count(*) AS n FROM crawl_pings WHERE site_id = $1', [id]))
        .n,
    );
  const runCount = async () =>
    Number(
      (
        await one<{ n: string }>('SELECT count(*) AS n FROM crawl_runs WHERE site_id = $1', [
          siteId,
        ])
      ).n,
    );
  const slugOfKey = (key: string) => key.split('/').filter(Boolean).pop()!;

  /** Another publisher's unverified site on `siteOrigin` (no origin probe), and its crawl key. */
  async function otherSite(siteOrigin: string) {
    const other = await newPublisher();
    const id = randomUUID();
    const key = deriveCrawlKey(id, REQUIRED_ENV.SESSION_SECRET!);
    await pool.query(
      `INSERT INTO sites (id, publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, 'v', $4, $5, 'PENDING_VERIFY')`,
      [id, other.id, siteOrigin, crawlKeyHash(key), `g-${id}`],
    );
    return { siteId: id, crawlKey: key };
  }

  async function connectAndApprove(p: { cookie: string }) {
    const created = await send('post', '/api/sites', p.cookie, { origin });
    expect(created.status).toBe(201);
    const id = created.body.siteId as string;
    verifyToken = created.body.verify.content;
    expect((await send('post', `/api/sites/${id}/verify`, p.cookie)).status).toBe(200);
    // Discovery crawl → schema agent (recorded) → Listing proposal → approve.
    const t0 = Date.now();
    let dsId: string | undefined;
    for (;;) {
      const ds = await pool.query<{ id: string }>(
        `SELECT id FROM datasets WHERE site_id = $1 AND slug = 'listings' AND status = 'PROPOSED'`,
        [id],
      );
      const site = await one<{ status: string }>('SELECT status FROM sites WHERE id = $1', [id]);
      if (ds.rows[0] && site.status === 'READY') {
        dsId = ds.rows[0].id;
        break;
      }
      if (Date.now() - t0 > 90_000) throw new Error('no Listing proposal');
      await sleep(50);
    }
    const sv = await one<{ id: string }>(
      'SELECT id FROM schema_versions WHERE dataset_id = $1 ORDER BY version DESC LIMIT 1',
      [dsId],
    );
    const approved = await send('post', `/api/datasets/${dsId}/approve`, p.cookie, {
      schemaVersionId: sv.id,
      rightsAttested: true,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await waitForRun(approved.body.crawlRunId)).status).toBe('SUCCEEDED');
    return {
      siteId: id,
      crawlKey: created.body.crawlKey as string,
      gateKey: created.body.gateKey as string,
      datasetId: dsId,
    };
  }

  // -------------------------------------------------------------------------------------------

  it('acceptance: demo:mutate --prices 3 --ping → 3 update changes within 30 s, no full crawl', async () => {
    await waitForPublished();
    let ds = (await loadServedDataset(pool, datasetId))!;
    const start = await readChanges(pool, ds, { limit: 1 });
    const runsBefore = await runCount();

    const entry = await store.mutate({ prices: 3, leased: 0, new: 0, seed: 5501, ping: true });
    const t0 = Date.now();
    // What `demo:mutate --target <site> --ping` does after the mutation.
    const accepted = await pingSpigot(
      { apiBase, siteId, crawlKey },
      pingUrls(origin, entry.touched),
    );
    expect(accepted).toMatchObject({ joined: false, urls: entry.touched.length });

    const priced = new Map(entry.prices.map((p) => [p.slug, p.to]));
    let updates: Awaited<ReturnType<typeof readChanges>>['changes'] = [];
    for (;;) {
      ds = (await loadServedDataset(pool, datasetId))!;
      const feed = await readChanges(pool, ds, { since: start.next, limit: 100 });
      updates = feed.changes.filter((c) => c.op === 'update');
      if (updates.length >= 3) break;
      if (Date.now() - t0 > 30_000) throw new Error(`only ${updates.length} updates after 30 s`);
      await sleep(50);
    }
    expect(Date.now() - t0).toBeLessThan(30_000);

    const run = await waitForRun(accepted.crawlRunId);
    ds = (await loadServedDataset(pool, datasetId))!;
    const feed = await readChanges(pool, ds, { since: start.next, limit: 100 });
    expect(feed.changes).toHaveLength(3);
    expect(new Set(feed.changes.map((c) => slugOfKey(c.key)))).toEqual(new Set(priced.keys()));
    for (const c of feed.changes) {
      expect(c.op).toBe('update');
      expect(c.patch).toContainEqual(
        expect.objectContaining({ path: '/price_usd', value: priced.get(slugOfKey(c.key)) }),
      );
    }

    // No full crawl: one new run, a PING run, that fetched exactly the pinged pages.
    expect(await runCount()).toBe(runsBefore + 1);
    expect(run).toMatchObject({
      status: 'SUCCEEDED',
      trigger: 'PING',
      ai_calls: 0,
      pages_total: entry.touched.length,
      pages_failed: 0,
    });
    expect(run.pages_fetched + run.pages_not_modified).toBe(entry.touched.length);
    const listingPages = Number(
      (
        await one<{ n: string }>(
          `SELECT count(*) AS n FROM pages WHERE site_id = $1 AND url LIKE '%/listings/%'`,
          [siteId],
        )
      ).n,
    );
    expect(run.pages_total).toBeLessThan(listingPages);
    expect(await pendingPings()).toBe(0);
  }, 60_000);

  it('auth: no key, a gate key, a wrong key or a cookie → 401; nothing is queued', async () => {
    const body = { urls: [`${origin}/listings/x`] };
    expect((await ping(siteId, null, body)).status).toBe(401);
    expect((await ping(siteId, `Bearer ${gateKey}`, body)).status).toBe(401);
    expect((await ping(siteId, 'Bearer ck_' + 'A'.repeat(43), body)).status).toBe(401);
    const cookie = await agent()
      .post(`/api/sites/${siteId}/ping`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', pub.cookie)
      .send(body);
    expect(cookie.status).toBe(401);
    expect(cookie.body.error.code).toBe('UNAUTHENTICATED');
    expect(await pendingPings()).toBe(0);
  });

  it(`tenancy (${cases.length} case): site A's crawl key on site B's id → 404 like a random id, nothing queued for B`, async () => {
    const b = await otherSite('http://127.0.0.1:9');
    const res = await ping(b.siteId, `Bearer ${crawlKey}`, { urls: ['http://127.0.0.1:9/a'] });
    expect(res.status).toBe(404);
    const random = await ping(randomUUID(), `Bearer ${crawlKey}`, { urls: ['/a'] });
    expect(random.status).toBe(404);
    expect(res.body.error.code).toBe(random.body.error.code);
    expect(await pendingPings(b.siteId)).toBe(0);
    // B's own key works on B only (B is not verified yet: 403).
    const own = await ping(b.siteId, `Bearer ${b.crawlKey}`, {
      urls: ['http://127.0.0.1:9/a'],
    });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SITE_NOT_VERIFIED');
  });

  it('validation: off-origin, over 500, none or extra fields → 400; nothing is queued', async () => {
    const auth = `Bearer ${crawlKey}`;
    const off = await ping(siteId, auth, {
      urls: [`${origin}/listings/a`, 'https://evil.example/x'],
    });
    expect(off.status).toBe(400);
    expect(off.body.error.details).toMatchObject({ invalid: ['https://evil.example/x'] });
    app.rateLimiter.reset();
    const many = Array.from({ length: 501 }, (_, i) => `${origin}/listings/${i}`);
    expect((await ping(siteId, auth, { urls: many })).status).toBe(400);
    app.rateLimiter.reset();
    expect((await ping(siteId, auth, { urls: [] })).status).toBe(400);
    app.rateLimiter.reset();
    expect((await ping(siteId, auth, { urls: ['/a'], trigger: 'MANUAL' })).status).toBe(400);
    expect(await pendingPings()).toBe(0);
  });

  it('1 ping / 10 s / site: the second → 429 with Retry-After', async () => {
    await waitForIdle();
    const auth = `Bearer ${crawlKey}`;
    const first = await ping(siteId, auth, { urls: ['/about'] });
    expect(first.status).toBe(202);
    const second = await ping(siteId, auth, { urls: ['/about'] });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(second.headers['retry-after'])).toBeLessThanOrEqual(10);
    await waitForRun(first.body.crawlRunId);
  });

  it('a URL the sitemap only just listed is fetched (sitemap re-read); one not in it is dropped', async () => {
    await waitForIdle();
    await waitForPublished();
    let ds = (await loadServedDataset(pool, datasetId))!;
    const start = await readChanges(pool, ds, { limit: 1 });
    const entry = await store.mutate({ prices: 0, leased: 0, new: 1, seed: 5502, ping: true });
    const fresh = `${origin}/listings/${entry.added[0]!.slug}`;
    // Not yet a known page: the PING run's sitemap read lists it.
    expect(
      (await pool.query('SELECT 1 FROM pages WHERE site_id = $1 AND url = $2', [siteId, fresh]))
        .rowCount,
    ).toBe(0);

    const res = await ping(siteId, `Bearer ${crawlKey}`, {
      urls: [fresh, `${origin}/listings/not-a-listing`],
    });
    expect(res.status).toBe(202);
    const run = await waitForRun(res.body.crawlRunId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', trigger: 'PING', pages_total: 1 });
    await waitForPublished();
    ds = (await loadServedDataset(pool, datasetId))!;
    const feed = await readChanges(pool, ds, { since: start.next, limit: 100 });
    expect(feed.changes.map((c) => [c.op, slugOfKey(c.key)])).toEqual([
      ['add', entry.added[0]!.slug],
    ]);
    expect(await pendingPings()).toBe(0);
  }, 60_000);

  it('joins the live run: same run id, no PING run, the pinged pages are fetched by it', async () => {
    await waitForIdle();
    await waitForPublished();
    let ds = (await loadServedDataset(pool, datasetId))!;
    const start = await readChanges(pool, ds, { limit: 1 });
    const runsBefore = await runCount();

    let release!: () => void;
    hold = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
    const manual = await send('post', `/api/sites/${siteId}/crawl`, pub.cookie, {
      trigger: 'MANUAL',
    });
    expect(manual.status).toBe(202);
    const entry = await store.mutate({ prices: 2, leased: 0, new: 0, seed: 5503, ping: true });
    const res = await ping(siteId, `Bearer ${crawlKey}`, { urls: pingUrls(origin, entry.touched) });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ crawlRunId: manual.body.crawlRunId, joined: true });
    hold.release();
    hold = null;

    expect(await waitForRun(manual.body.crawlRunId)).toMatchObject({
      status: 'SUCCEEDED',
      trigger: 'MANUAL',
    });
    expect(await runCount()).toBe(runsBefore + 1);
    expect(await pendingPings()).toBe(0);
    await waitForPublished();
    ds = (await loadServedDataset(pool, datasetId))!;
    const feed = await readChanges(pool, ds, { since: start.next, limit: 100 });
    expect(new Set(feed.changes.map((c) => slugOfKey(c.key)))).toEqual(
      new Set(entry.prices.map((p) => p.slug)),
    );
  }, 90_000);

  it('re-pinging a URL coalesces into one queued row', async () => {
    await waitForIdle();
    const b = { body: await otherSite('http://127.0.0.1:7') };
    await queuePings({ db }, b.body.siteId, ['http://127.0.0.1:7/a']);
    const first = await one<{ at: string }>(
      'SELECT requested_at::text AS at FROM crawl_pings WHERE site_id = $1',
      [b.body.siteId],
    );
    await queuePings({ db }, b.body.siteId, ['http://127.0.0.1:7/a', 'http://127.0.0.1:7/b']);
    expect(await pendingPings(b.body.siteId)).toBe(2);
    const moved = await one<{ later: boolean }>(
      `SELECT requested_at > $2::timestamptz AS later FROM crawl_pings WHERE site_id = $1 AND url = $3`,
      [b.body.siteId, first.at, 'http://127.0.0.1:7/a'],
    );
    expect(moved.later).toBe(true);
  });

  it('race: 24 pings racing run ends — every one is joined or starts a run, none is lost', async () => {
    await waitForIdle();
    const deps: CrawlDeps = {
      db,
      crawlSecret: REQUIRED_ENV.SESSION_SECRET!,
      allowLocal: true,
      appBaseUrl: APP_ORIGIN,
      minGapMs: 0,
    };
    const site = { id: siteId, origin, status: 'READY' };
    const { rows } = await pool.query<{ url: string }>(
      `SELECT url FROM pages WHERE site_id = $1 AND removed_at IS NULL AND url LIKE '%/listings/%'
        ORDER BY url LIMIT 24`,
      [siteId],
    );
    expect(rows).toHaveLength(24);
    const t0 = (await one<{ now: Date }>('SELECT now() AS now')).now;

    // The service directly (the 1 / 10 s limit is the route's): staggered so pings land before,
    // during and after each run's final check.
    const done: Promise<unknown>[] = [];
    const accepted = await Promise.all(
      rows.map(async ({ url }, i) => {
        await sleep((i % 8) * 15);
        return requestPing(deps, site, { urls: [url] }, (d) => done.push(d));
      }),
    );
    await waitForIdle();
    await Promise.allSettled(done);

    expect(await pendingPings()).toBe(0);
    // Every pinged page was fetched after its ping.
    const unfetched = await pool.query(
      `SELECT url FROM pages WHERE site_id = $1 AND url = ANY($2::text[])
          AND (fetched_at IS NULL OR fetched_at < $3)`,
      [siteId, rows.map((r) => r.url), t0],
    );
    expect(unfetched.rows).toEqual([]);
    // Each ping got a run that was live when it was accepted; all PING runs succeeded.
    const runIds = [...new Set(accepted.map((a) => a.crawlRunId))];
    for (const id of runIds) {
      expect(await runRow(id)).toMatchObject({ status: 'SUCCEEDED', trigger: 'PING' });
    }
    expect(accepted.filter((a) => !a.joined)).toHaveLength(runIds.length);
  }, 90_000);
});
