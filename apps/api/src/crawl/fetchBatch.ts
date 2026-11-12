import { notify } from '../db/index.js';
import { CRAWL_DEFAULTS, defaultCrawlDeps, type CrawlDeps } from './deps.js';
import { fetchPage, type FetchPageArgs, type FetchPageResult } from './fetchPage.js';
import { HOST_CONCURRENCY } from './queue.js';

/**
 * `fetchBatch({ runId, pageIds })` (SP-041a; features/03 §Logic 3.4, §Render Workflows layout).
 *
 * On Render Workflows every task runs on its own compute, so the in-process `HostQueue` can't
 * bound requests across tasks. The politeness rule is built into the fan-out instead:
 * `crawlSite` splits a run's pages into **at most 2 shares per host** (`planBatches`; a run is
 * one site, so one host) and starts one `fetchBatch` per share. Each batch walks its pages
 * **one at a time** through the same `fetchPage` body (`CRAWL_MIN_GAP_MS` between its starts),
 * so at most 2 requests are ever in flight to the origin. No semaphore table: the invariant
 * holds by construction.
 *
 * Idempotent like `fetchPage`: a retried batch skips pages this run already fetched (the same
 * rule a resumed run uses), and a page that throws counts as failed without sinking the batch.
 */

export interface FetchBatchArgs {
  runId: string;
  pageIds: string[];
}

export interface FetchBatchResult {
  /** Pages this call handed to `fetchPage`. */
  attempted: number;
  /** Pages skipped because this run already fetched them (a retried batch). */
  alreadyDone: number;
  /** True when the run paused or stopped being RUNNING, so the batch stopped early. */
  stopped: boolean;
}

/** Split `pageIds` into at most `perHost` (2) round-robin shares; never an empty share. */
export function planBatches(pageIds: readonly string[], perHost = HOST_CONCURRENCY): string[][] {
  const n = Math.min(Math.max(1, Math.min(perHost, HOST_CONCURRENCY)), pageIds.length);
  const shares: string[][] = Array.from({ length: n }, () => []);
  pageIds.forEach((id, i) => shares[i % n]!.push(id));
  return shares;
}

type RunPage = (args: FetchPageArgs, deps: CrawlDeps) => Promise<FetchPageResult>;

export async function fetchBatch(
  args: FetchBatchArgs,
  deps: CrawlDeps = defaultCrawlDeps(),
  runPage: RunPage = fetchPage,
): Promise<FetchBatchResult> {
  const { runId } = args;
  const { db } = deps;
  const every = deps.progressEvery ?? CRAWL_DEFAULTS.progressEvery;

  // A retried batch: drop pages this run already answered (200 / 304 move fetched_at).
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT p.id FROM pages p JOIN crawl_runs r ON r.id = $2
      WHERE p.id = ANY($1::uuid[])
        AND (r.started_at IS NULL OR p.fetched_at IS NULL OR p.fetched_at < r.started_at)`,
    [args.pageIds, runId],
  );
  const todo = new Set(rows.map((r) => r.id));
  const pageIds = args.pageIds.filter((id) => todo.has(id));

  let attempted = 0;
  for (const pageId of pageIds) {
    if (deps.signal?.aborted) break;
    attempted += 1;
    let res: FetchPageResult;
    try {
      res = await runPage({ pageId, runId }, deps);
    } catch {
      // A bug or DB blip on one page must not sink the batch: count it and move on.
      await db.pool
        .query('UPDATE crawl_runs SET pages_failed = pages_failed + 1 WHERE id = $1', [runId])
        .catch(() => {});
      res = { outcome: 'failed' };
    }
    if (res.outcome === 'paused' || res.reason === 'run_not_running') {
      return { attempted, alreadyDone: args.pageIds.length - pageIds.length, stopped: true };
    }
    if (attempted % every === 0) await progress(deps, runId);
  }
  return { attempted, alreadyDone: args.pageIds.length - pageIds.length, stopped: false };
}

async function progress(deps: CrawlDeps, runId: string): Promise<void> {
  const { rows } = await deps.db.pool.query(
    `SELECT status, pages_total, pages_fetched, pages_not_modified, pages_failed
       FROM crawl_runs WHERE id = $1`,
    [runId],
  );
  const r = rows[0];
  if (!r) return;
  const { status, ...counters } = r;
  await notify(deps.db.pool, 'crawl_progress', { runId, status, counters }).catch(() => {});
}
