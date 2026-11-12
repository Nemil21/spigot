import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import { notify, transition, type Db } from '../db/index.js';
import { deriveCrawlKey } from './crawlKey.js';
import { CRAWL_DEFAULTS, crawlerUserAgent, defaultCrawlDeps, type CrawlDeps } from './deps.js';
import { fetchPage, type FetchPageResult } from './fetchPage.js';
import { emitDiscoveryDone, emitPageChanged, emitRunFinished } from './hooks.js';
import { upsertPages } from './pages.js';
import { readSitemap } from './sitemap.js';

/**
 * `crawlSite({ siteId, trigger })` (SP-009a2; features/03 §Logic 3, 5, 7; data-model rule 9).
 *
 * 1. Insert `crawl_runs` QUEUED. The partial unique index allows one live run per site: on
 *    conflict the live run is returned (`created: false`) instead of a second one. A live run
 *    nobody has touched for `staleRunMs` (its process died) is adopted and resumed.
 * 2. QUEUED → RUNNING; `readSitemap` + `upsertPages`; pick pages that are new, have
 *    `sitemap_lastmod > fetched_at`, last answered 404/410, or (MANUAL) weren't fetched since
 *    the run started; fan out `fetchPage` (≤ 2 in flight per host, min gap; queue.ts).
 * 3. Run end, in one place and in this order: the run → SUCCEEDED / PARTIAL / FAILED with its
 *    counters; on the site's discovery run (site still VERIFIED) that SUCCEEDED, or is PARTIAL
 *    with ≥ 90% of pages fetched, `VERIFIED → PROPOSING` in the same transaction; after commit
 *    `onRunFinished(runId)`, then `onDiscoveryDone(siteId, runId)`.
 *
 * `WORKFLOWS_MODE=inproc` only: `workflow_run_id = inproc:<id>`. SP-041a runs the same
 * functions on Render Workflows. `crawl_runs.ai_calls` is never touched here.
 */

export const CRAWL_TRIGGERS = ['CONNECT', 'MANUAL', 'SCHEDULE', 'PING', 'DEMO_MUTATE'] as const;
export type CrawlTrigger = (typeof CRAWL_TRIGGERS)[number];

export interface CrawlSiteArgs {
  siteId: string;
  trigger: CrawlTrigger;
}

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'PAUSED';

export interface CrawlCounters {
  pages_total: number;
  pages_fetched: number;
  pages_not_modified: number;
  pages_failed: number;
}

export interface CrawlRunResult {
  runId: string;
  status: RunStatus;
  counters: CrawlCounters;
  /** True when this run moved the site VERIFIED → PROPOSING. */
  discovery: boolean;
  /** True when `deps.signal` stopped the run before it finished (status stays RUNNING). */
  aborted: boolean;
}

export interface StartedCrawl {
  runId: string;
  /** False when another live run already existed (its id is returned). */
  created: boolean;
  /** True when this call adopted an orphaned live run and is finishing it. */
  resumed: boolean;
  /** Settles when the run ends (or, for a run owned by another process, when it is seen ending). */
  done: Promise<CrawlRunResult>;
}

export const DISCOVERY_MIN_FETCHED_RATIO = 0.9;

/** Runs this process is executing, by id. */
const active = new Map<string, Promise<CrawlRunResult>>();

const COUNTER_COLUMNS = 'pages_total, pages_fetched, pages_not_modified, pages_failed';

export class CrawlSiteError extends Error {
  constructor(
    readonly code: 'SITE_NOT_FOUND' | 'BAD_TRIGGER',
    message: string,
  ) {
    super(message);
    this.name = 'CrawlSiteError';
  }
}

/** Start (or join) a crawl and return at once; `done` settles when it ends. SP-009b's route uses this. */
export async function startCrawl(
  args: CrawlSiteArgs,
  deps: CrawlDeps = defaultCrawlDeps(),
): Promise<StartedCrawl> {
  const { siteId, trigger } = args;
  if (!(CRAWL_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new CrawlSiteError(
      'BAD_TRIGGER',
      `crawlSite: trigger ${String(trigger)} is not a crawl trigger`,
    );
  }
  const { db } = deps;
  const site = await db.pool.query('SELECT 1 FROM sites WHERE id = $1', [siteId]);
  if (!site.rowCount)
    throw new CrawlSiteError('SITE_NOT_FOUND', `crawlSite: site ${siteId} not found`);

  const staleMs = deps.staleRunMs ?? CRAWL_DEFAULTS.staleRunMs;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomUUID();
    const inserted = await db.pool.query<{ id: string }>(
      `INSERT INTO crawl_runs (id, site_id, trigger, status, workflow_run_id)
       VALUES ($1::uuid, $2, $3, 'QUEUED', 'inproc:' || $1::text)
       ON CONFLICT (site_id) WHERE status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE'
       DO NOTHING
       RETURNING id`,
      [id, siteId, trigger],
    );
    if (inserted.rowCount) {
      return {
        runId: id,
        created: true,
        resumed: false,
        done: track(id, () => execute(id, siteId, deps)),
      };
    }

    const live = await db.pool.query<{ id: string }>(
      `SELECT id FROM crawl_runs
        WHERE site_id = $1 AND status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE'`,
      [siteId],
    );
    const liveId = live.rows[0]?.id;
    if (!liveId) continue; // it ended between our insert and select: try again

    const mine = active.get(liveId);
    if (mine) return { runId: liveId, created: false, resumed: false, done: mine };

    // Orphaned (its process died: no heartbeat for staleMs)? Claim it; one claimer wins.
    const claimed = await db.pool.query(
      `UPDATE crawl_runs SET workflow_run_id = 'inproc:' || id
        WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')
          AND updated_at <= now() - make_interval(secs => $2::double precision / 1000)
        RETURNING id`,
      [liveId, staleMs],
    );
    if (claimed.rowCount) {
      return {
        runId: liveId,
        created: false,
        resumed: true,
        done: track(liveId, () => execute(liveId, siteId, deps)),
      };
    }
    return { runId: liveId, created: false, resumed: false, done: waitForEnd(db, liveId, deps) };
  }
  throw new Error(`crawlSite: could not start or find a live run for site ${siteId}`);
}

/** The Workflows / in-process task: start (or join) the crawl and wait for it to end. */
export async function crawlSite(
  args: CrawlSiteArgs,
  deps: CrawlDeps = defaultCrawlDeps(),
): Promise<CrawlRunResult & { created: boolean; resumed: boolean }> {
  const started = await startCrawl(args, deps);
  const result = await started.done;
  return { ...result, created: started.created, resumed: started.resumed };
}

function track(runId: string, fn: () => Promise<CrawlRunResult>): Promise<CrawlRunResult> {
  const p = fn().finally(() => active.delete(runId));
  active.set(runId, p);
  return p;
}

async function readRun(db: Db, runId: string) {
  const { rows } = await db.pool.query<
    CrawlCounters & {
      status: RunStatus;
      site_id: string;
      trigger: CrawlTrigger;
      started_at: Date | null;
    }
  >(
    `SELECT status, site_id, trigger, started_at, ${COUNTER_COLUMNS} FROM crawl_runs WHERE id = $1`,
    [runId],
  );
  return rows[0]!;
}

const countersOf = (r: CrawlCounters): CrawlCounters => ({
  pages_total: r.pages_total,
  pages_fetched: r.pages_fetched,
  pages_not_modified: r.pages_not_modified,
  pages_failed: r.pages_failed,
});

const TERMINAL: readonly RunStatus[] = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];

/** A run owned by another process: poll until it ends. */
async function waitForEnd(db: Db, runId: string, deps: CrawlDeps): Promise<CrawlRunResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const run = await readRun(db, runId);
    if (TERMINAL.includes(run.status)) {
      return {
        runId,
        status: run.status,
        counters: countersOf(run),
        discovery: false,
        aborted: false,
      };
    }
    await sleep(1_000);
  }
}

/** Fraction of selected pages that got a definitive answer (200, 304, 404/410). */
export function fetchedRatio(c: CrawlCounters): number {
  if (c.pages_total <= 0) return 1;
  return Math.min(1, (c.pages_fetched + c.pages_not_modified) / c.pages_total);
}

export function finalStatus(c: CrawlCounters): 'SUCCEEDED' | 'PARTIAL' | 'FAILED' {
  if (c.pages_failed === 0) return 'SUCCEEDED';
  return c.pages_fetched + c.pages_not_modified > 0 ? 'PARTIAL' : 'FAILED';
}

async function execute(runId: string, siteId: string, deps: CrawlDeps): Promise<CrawlRunResult> {
  const { db } = deps;
  const heartbeat = setInterval(() => {
    // The touch trigger moves updated_at: proof of life for the orphan check.
    db.pool
      .query(`UPDATE crawl_runs SET error = error WHERE id = $1 AND status = 'RUNNING'`, [runId])
      .catch(() => {});
  }, deps.heartbeatMs ?? CRAWL_DEFAULTS.heartbeatMs);
  heartbeat.unref();

  try {
    return await runCrawl(runId, siteId, deps);
  } catch (err) {
    return finishRun(deps, runId, siteId, `Crawl failed: ${(err as Error).message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

async function runCrawl(runId: string, siteId: string, deps: CrawlDeps): Promise<CrawlRunResult> {
  const { db } = deps;

  // QUEUED → RUNNING (a resumed run is already RUNNING). started_at comes from the DB clock,
  // the same clock that writes pages.fetched_at.
  await db.tx(async (tx) => {
    const { rows } = await tx.query<{ now: Date }>('SELECT now() AS now');
    await transition(tx, 'crawl_runs', runId, 'QUEUED', 'RUNNING', { started_at: rows[0]!.now });
  });
  const run = await readRun(db, runId);
  if (run.status !== 'RUNNING') {
    return {
      runId,
      status: run.status,
      counters: countersOf(run),
      discovery: false,
      aborted: false,
    };
  }
  const startedAt = run.started_at!;

  const { rows: siteRows } = await db.pool.query<{ origin: string; sitemap_url: string | null }>(
    'SELECT origin, sitemap_url FROM sites WHERE id = $1',
    [siteId],
  );
  const site = siteRows[0]!;

  let sitemap;
  try {
    sitemap = await readSitemap(site, {
      allowLocal: deps.allowLocal,
      resolver: deps.resolver,
      fetch: deps.fetch,
      headers: {
        'x-spigot-key': deriveCrawlKey(siteId, deps.crawlSecret),
        'user-agent': crawlerUserAgent(deps.appBaseUrl),
      },
    });
  } catch (err) {
    return finishRun(deps, runId, siteId, `Could not read the sitemap: ${(err as Error).message}`);
  }
  await upsertPages(db, siteId, sitemap.entries);

  // Pages this run's sitemap read dropped: their records must go too.
  const dropped = await db.pool.query<{ id: string }>(
    'SELECT id FROM pages WHERE site_id = $1 AND removed_at >= $2 ORDER BY url',
    [siteId, startedAt],
  );
  for (const { id } of dropped.rows) await emitPageChanged(id, runId);

  const { rows: todo } = await db.pool.query<{ id: string }>(
    `SELECT id FROM pages
      WHERE site_id = $1 AND removed_at IS NULL
        AND (fetched_at IS NULL
             OR sitemap_lastmod > fetched_at
             OR last_status IN (404, 410)
             OR ($2 AND fetched_at < $3))
      ORDER BY url`,
    [siteId, run.trigger === 'MANUAL', startedAt],
  );
  // A resumed run keeps its original total; only the remainder is fetched.
  if (run.pages_total === 0) {
    await db.pool.query('UPDATE crawl_runs SET pages_total = $2 WHERE id = $1', [
      runId,
      todo.length,
    ]);
  }

  const workers = new PQueue({ concurrency: deps.pageWorkers ?? CRAWL_DEFAULTS.pageWorkers });
  const every = deps.progressEvery ?? CRAWL_DEFAULTS.progressEvery;
  let done = 0;
  let paused = false;
  const stop = () => workers.clear();
  deps.signal?.addEventListener('abort', stop, { once: true });

  try {
    for (const { id } of todo) {
      void workers.add(async () => {
        if (paused || deps.signal?.aborted) return;
        let res: FetchPageResult;
        try {
          res = await fetchPage({ pageId: id, runId }, deps);
        } catch {
          // A bug or DB blip on one page must not sink the run: count it and move on.
          await db.pool
            .query('UPDATE crawl_runs SET pages_failed = pages_failed + 1 WHERE id = $1', [runId])
            .catch(() => {});
          res = { outcome: 'failed' };
        }
        if (res.outcome === 'paused' || res.reason === 'run_not_running') {
          // Paused (here or by someone else) or no longer RUNNING: stop feeding the queue.
          paused = true;
          stop();
          return;
        }
        if (++done % every === 0) await progress(db, runId);
      });
    }
    await workers.onIdle();
  } finally {
    deps.signal?.removeEventListener('abort', stop);
  }

  if (deps.signal?.aborted) {
    const r = await readRun(db, runId);
    return { runId, status: r.status, counters: countersOf(r), discovery: false, aborted: true };
  }
  if (paused) {
    const r = await readRun(db, runId);
    if (r.status !== 'RUNNING') {
      await progress(db, runId, r.status);
      return { runId, status: r.status, counters: countersOf(r), discovery: false, aborted: false };
    }
  }
  return finishRun(deps, runId, siteId);
}

async function progress(db: Db, runId: string, status?: RunStatus): Promise<void> {
  const r = await readRun(db, runId);
  await notify(db.pool, 'crawl_progress', {
    runId,
    status: status ?? r.status,
    counters: countersOf(r),
  }).catch(() => {});
}

/** Run end and discovery hand-off: one transaction, then the hooks. */
async function finishRun(
  deps: CrawlDeps,
  runId: string,
  siteId: string,
  error?: string,
): Promise<CrawlRunResult> {
  const { db } = deps;
  const outcome = await db.tx(async (tx) => {
    const { rows } = await tx.query<CrawlCounters & { status: RunStatus }>(
      `SELECT status, ${COUNTER_COLUMNS} FROM crawl_runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    const run = rows[0]!;
    const counters = countersOf(run);
    if (run.status !== 'RUNNING' && run.status !== 'QUEUED') {
      return { status: run.status, counters, discovery: false, ended: false };
    }
    const status = error || run.status === 'QUEUED' ? 'FAILED' : finalStatus(counters);
    const ended = await transition(tx, 'crawl_runs', runId, run.status, status, {
      finished_at: new Date(),
      error: error ?? null,
    });
    if (!ended) return { status: run.status, counters, discovery: false, ended: false };

    const discoveryOk =
      status === 'SUCCEEDED' ||
      (status === 'PARTIAL' && fetchedRatio(counters) >= DISCOVERY_MIN_FETCHED_RATIO);
    const discovery =
      discoveryOk && (await transition(tx, 'sites', siteId, 'VERIFIED', 'PROPOSING')) !== null;
    await notify(tx, 'crawl_progress', { runId, status, counters });
    return { status, counters, discovery, ended: true };
  });

  if (outcome.ended) {
    await emitRunFinished(runId);
    if (outcome.discovery) await emitDiscoveryDone(siteId, runId);
  }
  return {
    runId,
    status: outcome.status,
    counters: outcome.counters,
    discovery: outcome.discovery,
    aborted: false,
  };
}
