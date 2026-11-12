import { startCrawl, type CrawlRunResult } from '../crawl/crawlSite.js';
import { CRAWL_DEFAULTS, defaultCrawlDeps, type CrawlDeps } from '../crawl/deps.js';
import type { LedgerCheckResult } from '../ledger/check.js';
import { recordLedgerCheck } from '../ops/ledgerStatus.js';

/**
 * Scheduled re-crawl and nightly check (SP-061; features/03 §Logic 8, features/07 §Ledger check).
 * Both run in-process under SP-002's advisory-locked `runEvery` (`crawl-schedule.job.ts`,
 * `nightly-check.job.ts`), so with several API processes each tick runs once.
 *
 * - Every 15 min, each READY site gets a `trigger=SCHEDULE` crawl: `crawlSite` re-reads the
 *   sitemap and fetches only new pages, pages whose `lastmod` moved past their last fetch, and
 *   pages that last answered 404/410 (a SCHEDULE run never refetches everything; MANUAL does).
 *   A site with a live run (heartbeating) is skipped; a live run whose process died is adopted
 *   and finished, as "Crawl now" would.
 * - Nightly (00:00 UTC tick): the same sitemap re-check, then `ledgerCheck()` recorded through
 *   `recordLedgerCheck` (audit `LEDGER_CHECKED`; a mismatch adds an `ALERT` and flips
 *   `/admin/health` to degraded).
 */

export const RECRAWL_EVERY_MS = 15 * 60_000;
export const NIGHTLY_EVERY_MS = 24 * 60 * 60_000;

export type ScheduledOutcome = 'STARTED' | 'RESUMED' | 'SKIPPED_LIVE' | 'FAILED';

export interface ScheduledCrawl {
  siteId: string;
  outcome: ScheduledOutcome;
  /** The run started or adopted, or the live run that caused the skip. */
  runId?: string;
  error?: string;
  /** STARTED / RESUMED only: settles when the run ends (never rejects). */
  done?: Promise<CrawlRunResult | undefined>;
}

/** One SCHEDULE crawl per READY site, without waiting for the runs to end. */
export async function recrawlReadySites(deps: CrawlDeps): Promise<ScheduledCrawl[]> {
  const { pool } = deps.db;
  const staleMs = deps.staleRunMs ?? CRAWL_DEFAULTS.staleRunMs;
  const { rows: sites } = await pool.query<{ id: string }>(
    `SELECT id FROM sites WHERE status = 'READY' ORDER BY created_at, id`,
  );

  const out: ScheduledCrawl[] = [];
  for (const { id: siteId } of sites) {
    // A live run that is still heartbeating: skip. Calling startCrawl for it would leave a poller
    // waiting on another process's run. A stale one falls through and startCrawl adopts it.
    const live = await pool.query<{ id: string }>(
      `SELECT id FROM crawl_runs
        WHERE site_id = $1 AND status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE'
          AND updated_at > now() - make_interval(secs => $2::double precision / 1000)`,
      [siteId, staleMs],
    );
    if (live.rowCount) {
      out.push({ siteId, outcome: 'SKIPPED_LIVE', runId: live.rows[0]!.id });
      continue;
    }
    try {
      const started = await startCrawl({ siteId, trigger: 'SCHEDULE' }, deps);
      if (started.created || started.resumed) {
        out.push({
          siteId,
          outcome: started.created ? 'STARTED' : 'RESUMED',
          runId: started.runId,
          done: started.done.catch(() => undefined),
        });
      } else {
        // Another process started one between our check and our insert; its poller is not ours.
        started.done.catch(() => {});
        out.push({ siteId, outcome: 'SKIPPED_LIVE', runId: started.runId });
      }
    } catch (err) {
      // One bad site (deleted meanwhile, DB blip) must not starve the others.
      out.push({ siteId, outcome: 'FAILED', error: (err as Error).message });
    }
  }
  return out;
}

export interface NightlyResult {
  crawls: ScheduledCrawl[];
  ledger: LedgerCheckResult;
}

/** Nightly: sitemap re-check for READY sites, then the recorded ledger check. */
export async function nightlyCheck(deps: CrawlDeps): Promise<NightlyResult> {
  // The ledger check runs even if starting the crawls failed.
  const crawls = await recrawlReadySites(deps).catch((err: unknown) => {
    console.error(`[nightly] re-crawl failed: ${(err as Error).message}`);
    return [] as ScheduledCrawl[];
  });
  const ledger = await recordLedgerCheck(deps.db, { trigger: 'NIGHTLY', actorType: 'SYSTEM' });
  if (ledger.mismatches.length > 0) {
    console.error(
      `[nightly] ledger check: ${ledger.mismatches.length} mismatch(es); ALERT written`,
    );
  }
  return { crawls, ledger };
}

let override: CrawlDeps | undefined;

/**
 * Deps for the two jobs, or `null` when jobs are off: under vitest they stay off until
 * `setScheduleDeps` (a test's `setJobDeps` for the money jobs doesn't switch them on, so no test
 * reaches `defaultCrawlDeps()` and the environment's `DATABASE_URL`). Outside tests:
 * `defaultCrawlDeps()`, the crawl pool and config the crawl tasks already use.
 */
export function scheduleJobDeps(
  env: Record<string, string | undefined> = process.env,
): CrawlDeps | null {
  if (override) return override;
  if (env.VITEST) return null;
  return defaultCrawlDeps(env);
}

/** Tests: run the schedule jobs against `deps` (`undefined` turns them off again). */
export function setScheduleDeps(deps: CrawlDeps | undefined): void {
  override = deps;
}
