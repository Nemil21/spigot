import type { FastifyPluginAsync } from 'fastify';
import type { ServerResponse } from 'node:http';
import { requirePublisher } from '../auth/publisherAuth.js';
import {
  auditCrawlRunDone,
  crawlBody,
  getCrawlRun,
  listCrawlRuns,
  requestCrawl,
  resumeSite,
  runsQuery,
  startDiscoveryCrawl,
} from '../crawl/api.js';
import type { CrawlCounters, RunStatus } from '../crawl/crawlSite.js';
import type { CrawlDeps } from '../crawl/deps.js';
import { onRunFinished } from '../crawl/hooks.js';
import { CrawlProgressBus } from '../crawl/progressBus.js';
import { ApiError, parse } from '../http/errors.js';
import { checkClientKey } from '../meter/idempotency.js';
import { onSiteVerified } from '../sites/hooks.js';
import { handOffToWorkflows } from '../workflows/dispatch.js';

/**
 * Crawl API (SP-009b; api.md §Publisher endpoints). Publisher session only; another publisher's
 * site or run is a 404 (tenancy: `security/tenancy/crawl.cases.ts`).
 *
 * - `POST /api/sites/:id/crawl` (optional Idempotency-Key) `{ trigger?: 'MANUAL' | 'DEMO_MUTATE' }`
 *   → `202 { crawlRunId, workflowRunId }`; a live run → `409 CRAWL_IN_PROGRESS` with its id;
 *   PENDING_VERIFY → `403 SITE_NOT_VERIFIED`; a PAUSED site is resumed (→ READY) first.
 * - `POST /api/sites/:id/resume` → `{ status: 'READY' }` (PAUSED → READY, no crawl).
 * - `GET /api/sites/:id/crawl-runs?limit=20` → `{ runs: [...] }`, newest first.
 * - `GET /api/crawl-runs/:id/events` (SSE): `progress` (status + counters), then `done`.
 *
 * Also wired here: `site.verified` → `crawlSite(siteId, 'CONNECT')` (the discovery crawl), and
 * `onRunFinished` → audit `CRAWL_RUN_DONE` with the counters. Runs execute in this process
 * (`workflow_run_id = inproc:<id>`), or on Render Workflows when `WORKFLOWS_MODE=workflows`
 * (SP-041a; the workflow service registers the same hooks, `workflows/runtime.ts`).
 */

/** Client reconnect delay sent as `retry:`. */
const RETRY_MS = 3_000;
const HEARTBEAT_MS = 15_000;
/** While this process's LISTEN connection is down, streams re-read their run this often. */
const FALLBACK_POLL_MS = 2_000;
/** A client this far behind is dropped (it reconnects and gets a fresh snapshot). */
const MAX_BUFFERED_BYTES = 1 << 20;
/** How long `app.close()` waits for in-process runs to stop after aborting them. */
const CLOSE_WAIT_MS = 5_000;

const TERMINAL: readonly RunStatus[] = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];

interface RunState extends CrawlCounters {
  status: RunStatus;
}

function frame(event: 'progress' | 'done', runId: string, r: RunState): string {
  const data = {
    crawlRunId: runId,
    status: r.status,
    pagesTotal: r.pages_total,
    pagesFetched: r.pages_fetched,
    pagesNotModified: r.pages_not_modified,
    pagesFailed: r.pages_failed,
  };
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const handled = (r: CrawlCounters) => r.pages_fetched + r.pages_not_modified + r.pages_failed;

const crawlRoutes: FastifyPluginAsync = async (app) => {
  const abort = new AbortController();
  const crawlDeps: CrawlDeps = {
    db: app.db,
    crawlSecret: app.config.SESSION_SECRET,
    allowLocal: app.config.ALLOW_LOCAL_ORIGINS,
    appBaseUrl: app.config.APP_BASE_URL,
    // Same rule as defaultCrawlDeps(): only an explicit CRAWL_MIN_GAP_MS overrides the adaptive gap.
    minGapMs: process.env.CRAWL_MIN_GAP_MS?.trim() ? app.config.CRAWL_MIN_GAP_MS : undefined,
    signal: abort.signal,
    // SP-041a: WORKFLOWS_MODE=workflows starts the run on Render Workflows (read per run).
    handOff: (args) => handOffToWorkflows('crawlSite', args, { db: app.db, log: app.log }),
  };
  const running = new Set<Promise<unknown>>();
  const track = (done: Promise<unknown>) => {
    const p = done.catch(() => {}).finally(() => running.delete(p));
    running.add(p);
  };

  const bus = new CrawlProgressBus({ connectionString: app.config.DATABASE_URL, log: app.log });
  const open = new Set<ServerResponse>();

  const unsubscribeVerified = onSiteVerified(async (siteId) => {
    const started = await startDiscoveryCrawl(crawlDeps, siteId);
    // Only runs this process executes; a run owned elsewhere would hand back a poller.
    if (started.created || started.resumed) track(started.done);
  });
  const unsubscribeFinished = onRunFinished(async (runId) => {
    await auditCrawlRunDone(app.db, runId);
  });

  // Streams never end on their own; end them so `app.close()` doesn't wait on them.
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });
  app.addHook('onClose', async () => {
    unsubscribeVerified();
    // Stop in-process runs where they are (like a killed process: a later start adopts them).
    abort.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...running]),
      new Promise((r) => {
        timer = setTimeout(r, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    unsubscribeFinished();
    await bus.close();
  });

  app.post<{ Params: { id: string } }>('/api/sites/:id/crawl', async (req, reply) => {
    const publisher = requirePublisher(req);
    const header = req.headers['idempotency-key'];
    let idempotencyKey: string | undefined;
    if (header !== undefined) {
      if (typeof header !== 'string' || header === '') {
        throw new ApiError('VALIDATION_ERROR', 'Idempotency-Key must be a single non-empty value.');
      }
      idempotencyKey = checkClientKey(header);
    }
    const body = parse(crawlBody, req.body ?? {}, 'crawl request');
    const result = await requestCrawl(
      crawlDeps,
      publisher.id,
      req.params.id,
      { ...body, idempotencyKey },
      track,
    );
    return reply
      .code(202)
      .send({ crawlRunId: result.crawlRunId, workflowRunId: result.workflowRunId });
  });

  app.post<{ Params: { id: string } }>('/api/sites/:id/resume', async (req) => {
    const publisher = requirePublisher(req);
    return { status: await resumeSite(app.db, publisher.id, req.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id/crawl-runs', async (req) => {
    const publisher = requirePublisher(req);
    const { limit } = parse(runsQuery, req.query, 'query');
    return { runs: await listCrawlRuns(app.db.pool, publisher.id, req.params.id, limit) };
  });

  app.get<{ Params: { id: string } }>('/api/crawl-runs/:id/events', async (req, reply) => {
    const publisherId = requirePublisher(req).id;
    const runId = (await getCrawlRun(app.db.pool, publisherId, req.params.id)).id;
    await bus.start();

    const res = reply.raw;
    reply.hijack();
    // The client may have gone while LISTEN was connecting; its 'close' has already fired.
    if (req.raw.destroyed || req.raw.socket?.destroyed || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    open.add(res);

    const write = (chunk: string) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        res.destroy();
        return;
      }
      res.write(chunk);
    };

    let finished = false;
    let last: RunState | null = null;
    /** Live progress; counters only move forward, so an older or repeated one is dropped. */
    const send = (r: RunState) => {
      if (finished) return;
      if (TERMINAL.includes(r.status)) {
        finished = true;
        write(frame('done', runId, r));
        res.end();
        return;
      }
      if (
        last &&
        (handled(r) < handled(last) ||
          (handled(r) === handled(last) &&
            r.status === last.status &&
            r.pages_total === last.pages_total))
      ) {
        return;
      }
      last = r;
      write(frame('progress', runId, r));
    };

    const readState = async (): Promise<RunState> => {
      const { rows } = await app.db.pool.query<RunState>(
        `SELECT status, pages_total, pages_fetched, pages_not_modified, pages_failed
           FROM crawl_runs WHERE id = $1`,
        [runId],
      );
      return rows[0]!;
    };

    // Subscribe before reading the snapshot, so nothing committed after the read is missed;
    // anything that arrives meanwhile is applied after the snapshot (and dropped if older).
    let snapshotted = false;
    const early: RunState[] = [];
    const resnapshot = () => {
      if (!snapshotted) return; // the first snapshot is still on its way
      readState()
        .then(send)
        .catch(() => {});
    };
    const unsubscribe = bus.subscribe(runId, {
      onProgress: (p) => {
        const r = { status: p.status, ...p.counters };
        if (snapshotted) send(r);
        else early.push(r);
      },
      onResync: resnapshot,
    });

    const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    const poll = setInterval(() => {
      if (!bus.connected) resnapshot();
    }, FALLBACK_POLL_MS);
    poll.unref();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      clearInterval(poll);
      unsubscribe();
      open.delete(res);
    };
    res.on('close', cleanup);
    if (res.destroyed || req.raw.socket?.destroyed) {
      cleanup();
      return;
    }

    write(`retry: ${RETRY_MS}\n: connected\n\n`);
    try {
      // Every (re)connect starts with the run's current counters: NOTIFY keeps no history.
      const snapshot = await readState();
      last = snapshot;
      write(frame('progress', runId, snapshot));
      if (TERMINAL.includes(snapshot.status)) {
        send(snapshot);
        return;
      }
    } catch {
      res.destroy();
      return;
    }
    snapshotted = true;
    for (const r of early.splice(0)) send(r);
  });
};

export default crawlRoutes;
