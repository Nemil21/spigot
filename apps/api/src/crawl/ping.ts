import PQueue from 'p-queue';
import { withAdvisoryXactLock, type Queryable } from '../db/index.js';
import { CRAWL_DEFAULTS, type CrawlDeps } from './deps.js';
import { fetchPage, type FetchPageResult } from './fetchPage.js';

/**
 * CMS ping queue (SP-055; features/05 §Logic 8, features/03 §Logic 8). `POST /api/sites/:id/ping`
 * (pingApi.ts) writes the URLs to `crawl_pings`; the site's live run fetches them before it ends.
 * A PING run reads the sitemap but selects no pages of its own; every run, PING or full, calls
 * `drainPings` from its run end (crawlSite.ts), so a ping that joins a live full crawl is fetched
 * too.
 *
 * Race: `queuePings` and the run-end check (`hasPendingPings`) take the same advisory lock, so a
 * ping either commits before the run's final check (the run fetches it) or after the run has
 * ended (the ping then starts a new run). A ping can't join a run that has already decided to end.
 */

export const MAX_PING_URLS = 500;

export const pingLockKey = (siteId: string) => `crawl-pings:${siteId}`;

/** Queue `urls` for the site (re-pinging a URL moves its `requested_at`). */
export async function queuePings(
  deps: Pick<CrawlDeps, 'db'>,
  siteId: string,
  urls: readonly string[],
): Promise<void> {
  await deps.db.tx(async (tx) => {
    await withAdvisoryXactLock(tx, pingLockKey(siteId));
    await tx.query(
      `INSERT INTO crawl_pings (site_id, url)
       SELECT $1, u FROM unnest($2::text[]) AS u
       ON CONFLICT (site_id, url) DO UPDATE SET requested_at = clock_timestamp()`,
      [siteId, urls],
    );
  });
}

/** Inside the run-end transaction, after `pingLockKey`: are pings waiting for this site? */
export async function hasPendingPings(tx: Queryable, siteId: string): Promise<boolean> {
  const { rowCount } = await tx.query('SELECT 1 FROM crawl_pings WHERE site_id = $1 LIMIT 1', [
    siteId,
  ]);
  return (rowCount ?? 0) > 0;
}

export type DrainOutcome = 'drained' | 'stopped';

/**
 * Fetch the site's pending pings in run `runId`, until none are left. Each pinged URL that is a
 * live page is fetched (counted into `pages_total`); when some aren't known pages, `resync`
 * re-reads the sitemap first (a ping for a page the sitemap only just listed). URLs still not in
 * the sitemap are dropped. A row is deleted only if nobody re-pinged it meanwhile.
 *
 * `stopped`: the run was paused or stopped mid-way (or `deps.signal` aborted); unfetched pings
 * stay queued for the next run.
 */
export async function drainPings(
  deps: CrawlDeps,
  runId: string,
  siteId: string,
  resync: () => Promise<void>,
): Promise<DrainOutcome> {
  const { db } = deps;
  for (;;) {
    if (deps.signal?.aborted) return 'stopped';
    const { rows: pings } = await db.pool.query<{ url: string; at: string }>(
      `SELECT url, requested_at::text AS at FROM crawl_pings
        WHERE site_id = $1 ORDER BY requested_at, url LIMIT $2`,
      [siteId, MAX_PING_URLS],
    );
    if (!pings.length) return 'drained';
    const urls = pings.map((p) => p.url);

    const livePages = () =>
      db.pool.query<{ id: string }>(
        `SELECT id FROM pages WHERE site_id = $1 AND url = ANY($2::text[]) AND removed_at IS NULL
          ORDER BY url`,
        [siteId, urls],
      );
    let pages = (await livePages()).rows;
    if (pages.length < pings.length) {
      // A sitemap we can't read now must not keep the run alive: the unknown URLs are dropped.
      await resync().catch(() => {});
      pages = (await livePages()).rows;
    }

    if (pages.length) {
      await db.pool.query('UPDATE crawl_runs SET pages_total = pages_total + $2 WHERE id = $1', [
        runId,
        pages.length,
      ]);
    }
    const workers = new PQueue({ concurrency: deps.pageWorkers ?? CRAWL_DEFAULTS.pageWorkers });
    let stopped = false;
    for (const { id } of pages) {
      void workers.add(async () => {
        if (stopped || deps.signal?.aborted) return;
        let res: FetchPageResult;
        try {
          res = await fetchPage({ pageId: id, runId }, deps);
        } catch {
          await db.pool
            .query('UPDATE crawl_runs SET pages_failed = pages_failed + 1 WHERE id = $1', [runId])
            .catch(() => {});
          return;
        }
        if (res.outcome === 'paused' || res.reason === 'run_not_running') {
          stopped = true;
          workers.clear();
        }
      });
    }
    await workers.onIdle();
    if (stopped || deps.signal?.aborted) return 'stopped';

    await db.pool.query(
      `DELETE FROM crawl_pings c
        USING unnest($2::text[], $3::text[]) AS u(url, at)
        WHERE c.site_id = $1 AND c.url = u.url AND c.requested_at = u.at::timestamptz`,
      [siteId, urls, pings.map((p) => p.at)],
    );
  }
}
