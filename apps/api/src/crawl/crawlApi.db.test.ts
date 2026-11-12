import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, get as httpGet, type IncomingMessage, type Server } from 'node:http';
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
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { createPool } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { cases } from '../security/tenancy/crawl.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { auditCrawlRunDone, requestCrawl } from './api.js';
import type { CrawlDeps } from './deps.js';
import { resetHostQueues } from './queue.js';

/**
 * SP-009b integration (ticket §Test plan): verify → discovery crawl → SSE events, and the
 * conflict / idempotency / resume / tenancy paths, through the real routes, the real crawler,
 * Postgres LISTEN/NOTIFY and the demo site (scale 0.05) as the origin.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface Frame {
  event: string;
  data: string;
}

/** A minimal EventSource over node:http: collects `event:` / `data:` frames. */
class SseClient {
  frames: Frame[] = [];
  body = '';
  ended = false;
  private buf = '';
  private constructor(
    readonly status: number,
    private readonly res: IncomingMessage,
  ) {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      this.body += chunk;
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n\n')) !== -1) {
        const block = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data.push(line.slice(6));
        }
        if (data.length) this.frames.push({ event, data: data.join('\n') });
      }
    });
    res.on('end', () => (this.ended = true));
    res.on('close', () => (this.ended = true));
  }

  static open(port: number, path: string, cookie?: string): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      const req = httpGet(
        { host: '127.0.0.1', port, path, headers: cookie ? { cookie } : {} },
        (res) => resolve(new SseClient(res.statusCode ?? 0, res)),
      );
      req.on('error', reject);
    });
  }

  data(i: number) {
    return JSON.parse(this.frames[i]!.data);
  }

  async until(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`SSE: timed out; frames so far: ${JSON.stringify(this.frames)}`);
      }
      await sleep(20);
    }
  }

  close() {
    this.res.destroy();
  }
}

describe.skipIf(!testDatabaseUrl)('SP-009b crawl API (Postgres + demo site)', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let port: number;
  let dataDir: string;
  let store: Store;
  let origin: string;
  let originServer: Server;
  let verifyToken: string | undefined;
  /** While set, the demo site holds every page request (not robots / sitemap / verify) until released. */
  let hold: { promise: Promise<void>; release: () => void } | null = null;
  const prevGap = process.env.CRAWL_MIN_GAP_MS;

  const holdPages = () => {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    hold = { promise, release };
  };
  const releasePages = () => {
    hold?.release();
    hold = null;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = createPool(db.url, { max: 3, applicationName: 'crawl-api-test' });
    dataDir = await mkdtemp(join(tmpdir(), 'spigot-crawl-api-'));
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
        DATABASE_URL: db.url,
        ALLOW_LOCAL_ORIGINS: 'true',
        CRAWL_MIN_GAP_MS: '0',
        // The discovery hand-off starts the schema agent: fixtures, never the live API.
        SCHEMA_AGENT_MODE: 'recorded',
      }),
      { logStream: new Writable({ write: (_c, _e, cb) => cb() }) },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    releasePages();
    await app?.close();
    if (prevGap === undefined) delete process.env.CRAWL_MIN_GAP_MS;
    else process.env.CRAWL_MIN_GAP_MS = prevGap;
    if (originServer) await new Promise<void>((r) => originServer.close(() => r()));
    await pool?.end();
    await db?.drop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    app.rateLimiter.reset();
    resetHostQueues();
  });

  const agent = () => request(app.server);
  const post = (url: string, cookie: string, body?: object, key?: string) => {
    let r = agent().post(url).set('Origin', APP_ORIGIN).set('Cookie', cookie);
    if (key) r = r.set('Idempotency-Key', key);
    return body === undefined ? r : r.send(body);
  };
  const getJson = (url: string, cookie: string) => agent().get(url).set('Cookie', cookie);

  async function newPublisher() {
    const res = await post('/api/auth/signup', '', {
      name: 'Bluebonnet',
      email: `p-${randomUUID()}@example.com`,
      password: 'correct horse',
      payoutEmail: 'payouts@example.com',
    });
    expect(res.status).toBe(201);
    return { id: res.body.publisherId as string, cookie: cookiesOf(res) };
  }

  /** Connect the demo origin. Each site needs a free origin row, so earlier sites are detached. */
  async function connect(pub: { cookie: string }) {
    await pool.query(`UPDATE sites SET origin = origin || '/#' || id WHERE origin = $1`, [origin]);
    const res = await post('/api/sites', pub.cookie, { origin });
    expect(res.status).toBe(201);
    return res.body as { siteId: string; verify: { content: string } };
  }

  async function verify(
    pub: { cookie: string },
    site: { siteId: string; verify: { content: string } },
  ) {
    verifyToken = site.verify.content;
    const res = await post(`/api/sites/${site.siteId}/verify`, pub.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'VERIFIED' });
  }

  const runsOf = async (siteId: string) =>
    (
      await pool.query<{ id: string; trigger: string; status: string; created_at: Date }>(
        'SELECT id, trigger, status, created_at FROM crawl_runs WHERE site_id = $1 ORDER BY created_at',
        [siteId],
      )
    ).rows;
  const siteStatus = async (id: string) =>
    (await pool.query<{ status: string }>('SELECT status FROM sites WHERE id = $1', [id])).rows[0]!
      .status;
  async function waitForEnd(runId: string) {
    for (let i = 0; i < 1000; i++) {
      const { rows } = await pool.query('SELECT * FROM crawl_runs WHERE id = $1', [runId]);
      if (TERMINAL.includes(rows[0].status)) return rows[0];
      await sleep(25);
    }
    throw new Error(`run ${runId} did not end`);
  }
  /** A verified site whose discovery crawl has finished (site PROPOSING). */
  async function crawledSite(pub: { cookie: string }) {
    const site = await connect(pub);
    await verify(pub, site);
    const [run] = await runsOf(site.siteId);
    await waitForEnd(run!.id);
    return site.siteId;
  }

  it('verify starts the discovery crawl at once; SSE shows progress then done; audit has the counters', async () => {
    const pub = await newPublisher();
    const site = await connect(pub);
    holdPages();
    await verify(pub, site);

    // No other call: the CONNECT run exists by the time verify answers (the hook is awaited).
    const runs = await runsOf(site.siteId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'CONNECT' });
    const runId = runs[0]!.id;
    expect(['QUEUED', 'RUNNING']).toContain(runs[0]!.status);

    const sse = await SseClient.open(port, `/api/crawl-runs/${runId}/events`, pub.cookie);
    expect(sse.status).toBe(200);
    // The first frame is the snapshot of the current counters.
    await sse.until(() => sse.frames.length >= 1);
    expect(sse.frames[0]!.event).toBe('progress');
    expect(sse.data(0)).toMatchObject({ crawlRunId: runId, pagesFailed: 0 });

    releasePages();
    await sse.until(() => sse.ended);
    const events = sse.frames.map((f) => f.event);
    expect(events.at(-1)).toBe('done');
    expect(events.filter((e) => e === 'done')).toHaveLength(1);
    expect(events.filter((e) => e === 'progress').length).toBeGreaterThanOrEqual(2);
    const done = sse.data(sse.frames.length - 1);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.pagesTotal).toBeGreaterThan(25);
    expect(done.pagesFetched).toBe(done.pagesTotal);
    // Progress counters never go backwards.
    const handled = sse.frames.map((_, i) => sse.data(i).pagesFetched as number);
    expect([...handled].sort((a, b) => a - b)).toEqual(handled);

    // The discovery run moved the site on (SP-009a2's run end).
    expect(await siteStatus(site.siteId)).toBe('PROPOSING');

    // CRAWL_RUN_DONE, once, with the counters (written by the onRunFinished hook after commit).
    let audits: { data: Record<string, unknown>; actor_type: string; publisher_id: string }[] = [];
    for (let i = 0; i < 100 && !audits.length; i++) {
      audits = (
        await pool.query(
          `SELECT * FROM audit_events WHERE entity = 'crawl_runs' AND entity_id = $1 AND action = 'CRAWL_RUN_DONE'`,
          [runId],
        )
      ).rows;
      if (!audits.length) await sleep(20);
    }
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_type: 'WORKFLOW', publisher_id: pub.id });
    expect(audits[0]!.data).toMatchObject({
      siteId: site.siteId,
      status: 'SUCCEEDED',
      trigger: 'CONNECT',
      pagesTotal: done.pagesTotal,
      pagesFetched: done.pagesFetched,
      pagesFailed: 0,
    });
    // The hook is idempotent: firing it again writes nothing.
    expect(await auditCrawlRunDone(app.db, runId)).toBe(false);

    // Reconnecting after the end: the snapshot first, then done, then the stream closes.
    const again = await SseClient.open(port, `/api/crawl-runs/${runId}/events`, pub.cookie);
    await again.until(() => again.ended);
    expect(again.frames.map((f) => f.event)).toEqual(['progress', 'done']);
    expect(again.data(0)).toMatchObject({ status: 'SUCCEEDED', pagesFetched: done.pagesFetched });

    // The runs list.
    const list = await getJson(`/api/sites/${site.siteId}/crawl-runs?limit=20`, pub.cookie);
    expect(list.status).toBe(200);
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0]).toMatchObject({
      id: runId,
      trigger: 'CONNECT',
      status: 'SUCCEEDED',
      workflowRunId: `inproc:${runId}`,
      pagesTotal: done.pagesTotal,
    });
  }, 60_000);

  it('a mid-run reconnect gets the current counters first, then live progress and done', async () => {
    const pub = await newPublisher();
    const siteId = await crawledSite(pub);
    holdPages();
    const res = await post(`/api/sites/${siteId}/crawl`, pub.cookie);
    expect(res.status).toBe(202);
    const runId = res.body.crawlRunId as string;
    expect(res.body.workflowRunId).toBe(`inproc:${runId}`);

    // Let the run get going (sitemap read, pages_total set) while page fetches are held.
    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query('SELECT pages_total FROM crawl_runs WHERE id = $1', [
        runId,
      ]);
      if (rows[0].pages_total > 0) break;
      await sleep(10);
    }
    const first = await SseClient.open(port, `/api/crawl-runs/${runId}/events`, pub.cookie);
    await first.until(() => first.frames.length >= 1);
    first.close();

    const { rows } = await pool.query('SELECT * FROM crawl_runs WHERE id = $1', [runId]);
    const second = await SseClient.open(port, `/api/crawl-runs/${runId}/events`, pub.cookie);
    await second.until(() => second.frames.length >= 1);
    expect(second.frames[0]!.event).toBe('progress');
    expect(second.data(0)).toEqual({
      crawlRunId: runId,
      status: 'RUNNING',
      pagesTotal: rows[0].pages_total,
      pagesFetched: rows[0].pages_fetched,
      pagesNotModified: rows[0].pages_not_modified,
      pagesFailed: rows[0].pages_failed,
    });
    expect(rows[0].pages_total).toBeGreaterThan(0);

    releasePages();
    await second.until(() => second.ended);
    expect(second.frames.at(-1)!.event).toBe('done');
    expect(JSON.parse(second.frames.at(-1)!.data).status).toBe('SUCCEEDED');
  }, 60_000);

  it('second "Crawl now" → 409 CRAWL_IN_PROGRESS with the live run id; racing clicks start one run', async () => {
    const pub = await newPublisher();
    const site = await connect(pub);
    holdPages();
    await verify(pub, site);
    const [discovery] = await runsOf(site.siteId);

    const busy = await post(`/api/sites/${site.siteId}/crawl`, pub.cookie);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatchObject({
      code: 'CRAWL_IN_PROGRESS',
      details: { crawlRunId: discovery!.id },
    });
    releasePages();
    await waitForEnd(discovery!.id);

    // Five concurrent clicks without a key: one 202, four 409s naming that run.
    holdPages();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(`/api/sites/${site.siteId}/crawl`, pub.cookie, {})),
    );
    const accepted = results.filter((r) => r.status === 202);
    expect(accepted).toHaveLength(1);
    const liveId = accepted[0]!.body.crawlRunId;
    for (const r of results.filter((x) => x.status !== 202)) {
      expect(r.status).toBe(409);
      expect(r.body.error.details.crawlRunId).toBe(liveId);
    }
    expect(await runsOf(site.siteId)).toHaveLength(2);
    expect((await runsOf(site.siteId))[1]).toMatchObject({ id: liveId, trigger: 'MANUAL' });
    releasePages();
    await waitForEnd(liveId);
  }, 60_000);

  it('a 409 against a run owned by another process hands nothing to track (no poller kept)', async () => {
    const pub = await newPublisher();
    const siteId = await crawledSite(pub);
    const deps: CrawlDeps = {
      db: app.db,
      crawlSecret: REQUIRED_ENV.SESSION_SECRET!,
      allowLocal: true,
      appBaseUrl: APP_ORIGIN,
      minGapMs: 0,
      sleep: (ms) => sleep(Math.min(ms, 10)),
    };
    // Another API / Workflows process's live run: not in this process, recently touched.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO crawl_runs (site_id, trigger, status, workflow_run_id)
       VALUES ($1, 'MANUAL', 'RUNNING', 'wf-other-process') RETURNING id`,
      [siteId],
    );
    const foreignId = rows[0]!.id;

    const tracked: Promise<unknown>[] = [];
    const onStarted = (done: Promise<unknown>) => void tracked.push(done);
    await expect(
      requestCrawl(deps, pub.id, siteId, { trigger: 'MANUAL' }, onStarted),
    ).rejects.toMatchObject({ code: 'CRAWL_IN_PROGRESS', details: { crawlRunId: foreignId } });
    // Same through HTTP.
    const res = await post(`/api/sites/${siteId}/crawl`, pub.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.details.crawlRunId).toBe(foreignId);
    expect(tracked).toHaveLength(0);

    // Once the foreign run ends, a run this process creates is handed over exactly once.
    await pool.query(`UPDATE crawl_runs SET status = 'FAILED' WHERE id = $1`, [foreignId]);
    const started = await requestCrawl(deps, pub.id, siteId, { trigger: 'MANUAL' }, onStarted);
    expect(started.replayed).toBe(false);
    expect(tracked).toHaveLength(1);
    await tracked[0];
    expect((await waitForEnd(started.crawlRunId)).status).toBe('SUCCEEDED');
  }, 60_000);

  it('Idempotency-Key: racing retries and later replays get the same run; another trigger → 409', async () => {
    const pub = await newPublisher();
    const siteId = await crawledSite(pub);
    const key = `crawl-${randomUUID()}`;

    holdPages();
    const racing = await Promise.all(
      Array.from({ length: 5 }, () => post(`/api/sites/${siteId}/crawl`, pub.cookie, {}, key)),
    );
    expect(racing.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
    const ids = new Set(racing.map((r) => r.body.crawlRunId));
    expect(ids.size).toBe(1);
    const [runId] = [...ids];
    releasePages();
    await waitForEnd(runId);

    // After the run ended: still a replay, not a new run.
    const later = await post(`/api/sites/${siteId}/crawl`, pub.cookie, { trigger: 'MANUAL' }, key);
    expect(later.status).toBe(202);
    expect(later.body).toEqual({ crawlRunId: runId, workflowRunId: `inproc:${runId}` });
    expect(await runsOf(siteId)).toHaveLength(2);

    const mismatch = await post(
      `/api/sites/${siteId}/crawl`,
      pub.cookie,
      { trigger: 'DEMO_MUTATE' },
      key,
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');

    // DEMO_MUTATE with a fresh key is a normal run.
    const demo = await post(`/api/sites/${siteId}/crawl`, pub.cookie, { trigger: 'DEMO_MUTATE' });
    expect(demo.status).toBe(202);
    const demoRun = await waitForEnd(demo.body.crawlRunId);
    expect(demoRun.trigger).toBe('DEMO_MUTATE');
    expect(demoRun.idempotency_key).toBeNull();
  }, 60_000);

  it('"Crawl now" on a PAUSED site resumes it (→ READY) and starts a run; resume alone starts none', async () => {
    const pub = await newPublisher();
    const siteId = await crawledSite(pub);
    await pool.query(`UPDATE sites SET status = 'PAUSED' WHERE id = $1`, [siteId]);

    const res = await post(`/api/sites/${siteId}/crawl`, pub.cookie);
    expect(res.status).toBe(202);
    expect(await siteStatus(siteId)).toBe('READY');
    const run = await waitForEnd(res.body.crawlRunId);
    expect(run).toMatchObject({ site_id: siteId, trigger: 'MANUAL', status: 'SUCCEEDED' });
    // A READY site stays READY after a crawl (PROPOSING → READY is SP-012a's move).
    expect(await siteStatus(siteId)).toBe('READY');

    await pool.query(`UPDATE sites SET status = 'PAUSED' WHERE id = $1`, [siteId]);
    const before = (await runsOf(siteId)).length;
    const resumed = await post(`/api/sites/${siteId}/resume`, pub.cookie);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toEqual({ status: 'READY' });
    expect(await siteStatus(siteId)).toBe('READY');
    expect(await runsOf(siteId)).toHaveLength(before);
    // Resuming a READY site is a no-op.
    expect((await post(`/api/sites/${siteId}/resume`, pub.cookie)).body).toEqual({
      status: 'READY',
    });
  }, 60_000);

  it('state and input errors: unverified site → 403, bad trigger → 400, resume of PROPOSING → 409', async () => {
    const pub = await newPublisher();
    const site = await connect(pub);
    const unverified = await post(`/api/sites/${site.siteId}/crawl`, pub.cookie);
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe('SITE_NOT_VERIFIED');
    expect(await runsOf(site.siteId)).toHaveLength(0);

    const siteId = await crawledSite(pub);
    for (const body of [{ trigger: 'CONNECT' }, { trigger: 'APPROVE' }, { extra: 1 }]) {
      const res = await post(`/api/sites/${siteId}/crawl`, pub.cookie, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const badLimit = await getJson(`/api/sites/${siteId}/crawl-runs?limit=0`, pub.cookie);
    expect(badLimit.status).toBe(400);

    const resume = await post(`/api/sites/${siteId}/resume`, pub.cookie);
    expect(resume.status).toBe(409);
    expect(resume.body.error.code).toBe('STATE_CONFLICT');
  }, 60_000);

  it("runs the tenancy cases: another publisher's site or run → 404; no session → 401", async () => {
    expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/sites/:id/crawl',
      'POST /api/sites/:id/resume',
      'GET /api/sites/:id/crawl-runs',
      'GET /api/crawl-runs/:id/events',
    ]);
    const a = await newPublisher();
    const b = await newPublisher();
    const bSite = await crawledSite(b);
    const [bRun] = await runsOf(bSite);
    await pool.query(`UPDATE sites SET status = 'PAUSED' WHERE id = $1`, [bSite]);

    const crawl = await post(`/api/sites/${bSite}/crawl`, a.cookie);
    expect(crawl.status).toBe(404);
    expect(crawl.body.error.code).toBe('NOT_FOUND');
    expect((await post(`/api/sites/${bSite}/resume`, a.cookie)).status).toBe(404);
    expect(await siteStatus(bSite)).toBe('PAUSED');
    expect(await runsOf(bSite)).toHaveLength(1);
    expect((await getJson(`/api/sites/${bSite}/crawl-runs`, a.cookie)).status).toBe(404);

    const stream = await SseClient.open(port, `/api/crawl-runs/${bRun!.id}/events`, a.cookie);
    expect(stream.status).toBe(404);
    await stream.until(() => stream.ended);
    expect(JSON.parse(stream.body).error.code).toBe('NOT_FOUND');
    // A non-uuid id is a 404 too, never a 500.
    expect((await getJson('/api/sites/not-a-uuid/crawl-runs', a.cookie)).status).toBe(404);

    const anon = await SseClient.open(port, `/api/crawl-runs/${bRun!.id}/events`);
    expect(anon.status).toBe(401);
    expect((await post(`/api/sites/${bSite}/crawl`, '')).status).toBe(401);
  }, 60_000);
});
