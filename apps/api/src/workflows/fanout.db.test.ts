import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessLog, type AccessLog } from '../../../demo-site/src/accessLog.js';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';
import { crawlSite, startCrawl } from '../crawl/crawlSite.js';
import type { CrawlDeps } from '../crawl/deps.js';
import type { FetchBatchArgs } from '../crawl/fetchBatch.js';
import { clearCrawlHooks, onRunFinished } from '../crawl/hooks.js';
import { resetHostQueues } from '../crawl/queue.js';
import { createDb, type Db } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { handOffToWorkflows, type WorkflowsStartClient } from './dispatch.js';
import { workflowTaskBodies } from './runtime.js';

/**
 * SP-041a acceptance: in Workflows mode a 100-page site fans out as exactly 2 `fetchBatch` task
 * runs, the origin's concurrency gauge (the demo site's access log) never passes 2, and the
 * crawl ends with the same page and counter totals as the in-process path.
 *
 * "Render" here is a fake start client that runs the real Workflows task bodies
 * (`workflowTaskBodies`) the way the SDK would: `crawlSite` as its own run, each
 * `ctx.run(fetchBatch)` as a child run.
 */

const SECRET = 'workflows-test-secret-'.padEnd(40, 'x');
const PAGES = 100;
const silentLog = { info() {}, warn() {}, error() {} } as never;

/** A 100-page origin behind the demo site's access-log gauge; each page takes a few ms. */
function origin100(log: AccessLog) {
  const app = express();
  app.use(log.middleware);
  app.get('/sitemap.xml', (_req, res) => {
    const base = `http://${_req.headers.host}`;
    const urls = Array.from(
      { length: PAGES },
      (_, i) => `<url><loc>${base}/listing/${i}</loc></url>`,
    ).join('');
    res.type('application/xml').send(`<?xml version="1.0"?><urlset>${urls}</urlset>`);
  });
  app.get('/listing/:n', (req, res) => {
    setTimeout(
      () => res.type('html').send(`<html><body><h1>Listing ${req.params.n}</h1></body></html>`),
      2 + Math.random() * 3,
    );
  });
  return app;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

describe.skipIf(!testDatabaseUrl)('Render Workflows fan-out (SP-041a)', () => {
  let pools: TwoPools;
  let db: Db;
  let deps: CrawlDeps;
  const servers: Server[] = [];

  const serve = async () => {
    const log = createAccessLog(() => {});
    const server = createServer(origin100(log));
    servers.push(server);
    return { origin: await listen(server), log };
  };

  const newSite = async (origin: string) => {
    const pub = await pools.a.query<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
      [`p-${origin}@x.test`],
    );
    const site = await pools.a.query<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, 'v', 'pending', 'g', 'VERIFIED') RETURNING id`,
      [pub.rows[0]!.id, origin],
    );
    const id = site.rows[0]!.id;
    await pools.a.query('UPDATE sites SET crawl_key_hash = $2 WHERE id = $1', [
      id,
      crawlKeyHash(deriveCrawlKey(id, SECRET)),
    ]);
    return id;
  };

  const runRow = async (id: string) =>
    (await pools.a.query('SELECT * FROM crawl_runs WHERE id = $1', [id])).rows[0]!;
  const pageCount = async (siteId: string) =>
    (
      await pools.a.query<{ pages: number; snaps: number }>(
        `SELECT count(DISTINCT p.id)::int AS pages, count(s.id)::int AS snaps
           FROM pages p LEFT JOIN snapshots s ON s.page_id = p.id WHERE p.site_id = $1`,
        [siteId],
      )
    ).rows[0]!;

  /** Fake Render: starting `crawlSite` runs the real task body as a separate "run". */
  function fakeRender(renderDeps: CrawlDeps) {
    const bodies = workflowTaskBodies({ db, crawlDeps: renderDeps, log: silentLog });
    const batches: FetchBatchArgs[] = [];
    const runs: Promise<unknown>[] = [];
    const client: WorkflowsStartClient = {
      startTask: async (slug, input) => {
        expect(slug).toBe('spigot-workflows/crawlSite');
        const taskRunId = `trn-${runs.length + 1}`;
        const args = input[0] as Parameters<typeof bodies.crawlSite>[0];
        // Like Render: the run starts after the start call has returned.
        runs.push(
          new Promise((r) => setTimeout(r, 5)).then(() =>
            bodies.crawlSite(args, {
              taskRunId,
              runFetchBatch: (batch) => {
                batches.push(batch);
                return bodies.fetchBatch(batch);
              },
            }),
          ),
        );
        return { taskRunId };
      },
    };
    return { client, batches, runs };
  }

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
  });
  afterAll(async () => {
    await Promise.all(servers.map(close));
    await pools?.close();
  });
  beforeEach(async () => {
    await pools.a.query('TRUNCATE snapshots, crawl_runs, pages, sites, publishers CASCADE');
    resetHostQueues();
    clearCrawlHooks();
    deps = {
      db,
      crawlSecret: SECRET,
      allowLocal: true,
      appBaseUrl: 'http://spigot.test',
      minGapMs: 2,
      // Short real waits: the API side polls a handed-off run until it ends.
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    };
  });
  afterEach(() => clearCrawlHooks());

  it('100 pages → exactly 2 fetchBatch runs, gauge ≤ 2, same counts as in-process', async () => {
    // Workflows mode: the API creates the run and hands it to "Render".
    const wf = await serve();
    const wfSite = await newSite(wf.origin);
    const render = fakeRender(deps);
    const env = { WORKFLOWS_MODE: 'workflows' };
    const started = await startCrawl(
      { siteId: wfSite, trigger: 'CONNECT' },
      {
        ...deps,
        handOff: (a) => handOffToWorkflows('crawlSite', a, { db, env, client: render.client }),
      },
    );
    expect(started.created).toBe(true);
    const [remote] = (await Promise.all(render.runs)) as Awaited<ReturnType<typeof crawlSite>>[];
    const seenByApi = await started.done;

    expect(render.runs).toHaveLength(1);
    expect(render.batches).toHaveLength(2);
    expect(render.batches.map((b) => b.pageIds.length)).toEqual([50, 50]);
    expect(new Set(render.batches.flatMap((b) => b.pageIds)).size).toBe(PAGES);
    expect(render.batches.every((b) => b.runId === started.runId)).toBe(true);
    expect(wf.log.stats().maxInFlight).toBeLessThanOrEqual(2);
    expect(wf.log.stats().maxInFlight).toBeGreaterThan(0);

    expect(remote).toMatchObject({ runId: started.runId, status: 'SUCCEEDED', discovery: true });
    expect(seenByApi).toMatchObject({ runId: started.runId, status: 'SUCCEEDED' });
    const run = await runRow(started.runId);
    expect(run.workflow_run_id).toBe('trn-1');
    expect(run.status).toBe('SUCCEEDED');

    // In-process mode on an identical origin: same pages, snapshots and counters.
    resetHostQueues();
    const local = await serve();
    const localSite = await newSite(local.origin);
    const inproc = await crawlSite(
      { siteId: localSite, trigger: 'CONNECT' },
      {
        ...deps,
        handOff: (a) =>
          handOffToWorkflows('crawlSite', a, { db, env: { WORKFLOWS_MODE: 'inproc' } }),
      },
    );
    expect(inproc.status).toBe('SUCCEEDED');
    expect((await runRow(inproc.runId)).workflow_run_id).toBe(`inproc:${inproc.runId}`);
    expect(inproc.counters).toEqual(remote!.counters);
    expect(inproc.counters).toEqual({
      pages_total: PAGES,
      pages_fetched: PAGES,
      pages_not_modified: 0,
      pages_failed: 0,
    });
    expect(await pageCount(localSite)).toEqual(await pageCount(wfSite));
    expect(await pageCount(wfSite)).toEqual({ pages: PAGES, snaps: PAGES });
    expect(local.log.stats().maxInFlight).toBeLessThanOrEqual(2);
  });

  it('one fetchBatch run fails for good: the run waits for the other, ends from its counters', async () => {
    const { origin } = await serve();
    const siteId = await newSite(origin);
    const bodies = workflowTaskBodies({ db, crawlDeps: deps, log: silentLog });
    const order: string[] = [];
    onRunFinished((runId) => void order.push(`finished:${runId}`));
    let n = 0;
    const res = await bodies.crawlSite(
      {
        siteId,
        trigger: 'CONNECT',
        runId: (
          await startCrawl(
            { siteId, trigger: 'CONNECT' },
            { ...deps, handOff: async () => 'trn-1' },
          )
        ).runId,
      },
      {
        taskRunId: 'trn-1',
        runFetchBatch: async (batch) => {
          if (++n === 1) {
            order.push('batch-1:rejected');
            throw new Error('task run timed out');
          }
          const r = await bodies.fetchBatch(batch);
          order.push('batch-2:done');
          return r;
        },
      },
    );
    // Not FAILED by the rejection: PARTIAL from the counters, with the lost share counted failed.
    expect(res.status).toBe('PARTIAL');
    expect(res.counters).toEqual({
      pages_total: PAGES,
      pages_fetched: PAGES / 2,
      pages_not_modified: 0,
      pages_failed: PAGES / 2,
    });
    expect((await runRow(res.runId)).error).toBeNull();
    // 50% fetched is below the discovery bar; the site stays VERIFIED.
    expect(res.discovery).toBe(false);
    // The run ended (and its hooks fired) only after the surviving batch finished.
    expect(order).toEqual(['batch-1:rejected', 'batch-2:done', `finished:${res.runId}`]);
  });

  it('Render down: the run falls back to this process and keeps inproc:<id>', async () => {
    const { origin } = await serve();
    const siteId = await newSite(origin);
    const client: WorkflowsStartClient = {
      startTask: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const res = await crawlSite(
      { siteId, trigger: 'CONNECT' },
      {
        ...deps,
        handOff: (a) =>
          handOffToWorkflows('crawlSite', a, {
            db,
            env: { WORKFLOWS_MODE: 'workflows' },
            client,
            log: silentLog,
          }),
      },
    );
    expect(res).toMatchObject({ status: 'SUCCEEDED', created: true });
    expect((await runRow(res.runId)).workflow_run_id).toBe(`inproc:${res.runId}`);
  });

  it('Render started the run although the start call failed: the run still executes once', async () => {
    const { origin, log } = await serve();
    const siteId = await newSite(origin);
    const render = fakeRender(deps);
    // The start reached Render, but the API saw an error (timeout) and falls back to running it.
    const flaky: WorkflowsStartClient = {
      startTask: async (...a) => {
        await render.client.startTask(...a);
        throw new Error('timeout');
      },
    };
    log.reset();
    const local = await crawlSite(
      { siteId, trigger: 'CONNECT' },
      {
        ...deps,
        handOff: (a) =>
          handOffToWorkflows('crawlSite', a, {
            db,
            env: { WORKFLOWS_MODE: 'workflows' },
            client: flaky,
            log: silentLog,
          }),
      },
    );
    const [remote] = (await Promise.all(render.runs)) as Awaited<ReturnType<typeof crawlSite>>[];
    expect(local.status).toBe('SUCCEEDED');
    expect(remote!.status).toBe('SUCCEEDED');
    expect(local.counters).toEqual(remote!.counters);
    expect(local.counters.pages_fetched).toBe(PAGES);
    // One sitemap read and one GET per page: nobody ran it twice.
    expect(log.stats().total).toBe(PAGES + 1);
    expect(log.stats().maxInFlight).toBeLessThanOrEqual(2);
  });

  it('a retried crawlSite task resumes its own RUNNING run; it never steals a live one', async () => {
    const { origin } = await serve();
    const siteId = await newSite(origin);
    // The API created and handed off the run; the first attempt got as far as RUNNING, then died.
    const started = await startCrawl(
      { siteId, trigger: 'CONNECT' },
      { ...deps, handOff: async () => 'trn-7' },
    );
    await pools.a.query(
      `UPDATE crawl_runs SET status = 'RUNNING', started_at = now(), workflow_run_id = 'trn-7'
        WHERE id = $1`,
      [started.runId],
    );

    // Another task run (not ours) finds it live and fresh: it waits, it doesn't execute.
    const abort = new AbortController();
    const other = crawlSite(
      { siteId, trigger: 'CONNECT', runId: started.runId, workflowRunId: 'trn-8' },
      { ...deps, signal: abort.signal },
    );
    await new Promise((r) => setTimeout(r, 60));
    abort.abort();
    expect(await other).toMatchObject({ aborted: true, status: 'RUNNING', resumed: false });

    // Render's retry of trn-7 resumes it at once.
    const bodies = workflowTaskBodies({ db, crawlDeps: deps, log: silentLog });
    let fanned = 0;
    const res = await bodies.crawlSite(
      { siteId, trigger: 'CONNECT', runId: started.runId },
      {
        taskRunId: 'trn-7',
        runFetchBatch: (b) => {
          fanned += 1;
          return bodies.fetchBatch(b);
        },
      },
    );
    expect(res).toMatchObject({ status: 'SUCCEEDED', resumed: true });
    expect(res.counters.pages_fetched).toBe(PAGES);
    expect(fanned).toBe(2);
    await expect(started.done).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });
});
