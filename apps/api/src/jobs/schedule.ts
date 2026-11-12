import { isUniqueViolation } from '../auth/credentials.js';
import { startCrawl, type CrawlRunResult } from '../crawl/crawlSite.js';
import { CRAWL_DEFAULTS, defaultCrawlDeps, type CrawlDeps } from '../crawl/deps.js';
import type { LedgerCheckResult } from '../ledger/check.js';
import { recordLedgerCheck } from '../ops/ledgerStatus.js';
import { handOffToWorkflows } from '../workflows/dispatch.js';

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
 * - One SCHEDULE run per site per 15-min slot, enforced by the database: the run carries the
 *   idempotency key `schedule·<slot>` (`crawl_runs_site_idempotency_key` is unique per site).
 *   "No live run" alone is not enough: at 00:00 UTC `crawl.schedule` and `nightly.check` (two
 *   jobs, two advisory locks) both scan, and a small site's run can finish before the second scan
 *   reaches it, which then started a second run for the same tick.
 * - Nightly (00:00 UTC tick): the same sitemap re-check, then `ledgerCheck()` recorded through
 *   `recordLedgerCheck` (audit `LEDGER_CHECKED`; a mismatch adds an `ALERT` and flips
 *   `/admin/health` to degraded).
 */

export const RECRAWL_EVERY_MS = 15 * 60_000;
export const NIGHTLY_EVERY_MS = 24 * 60 * 60_000;

export type ScheduledOutcome =
  | 'STARTED'
  | 'RESUMED'
  | 'SKIPPED_LIVE'
  /** This slot's run for the site exists already (another process, or the other job). */
  | 'ALREADY_SCHEDULED'
  | 'FAILED';

/** The 15-min schedule slot containing `epochMs` (= `crawl.schedule`'s `runEvery` tick). */
export function scheduleSlot(epochMs: number = Date.now()): number {
  return Math.floor(epochMs / RECRAWL_EVERY_MS);
}

/** The schedule slot of `nightly.check`'s day tick: its 00:00 slot. */
export function nightlySlot(dayTick: number): number {
  return dayTick * (NIGHTLY_EVERY_MS / RECRAWL_EVERY_MS);
}

/**
 * The run's idempotency key for a slot. `·` is outside the printable ASCII a client may send as
 * an Idempotency-Key (`checkClientKey`), so "Crawl now" keys never collide with it.
 */
export function scheduleKey(slot: number): string {
  return `schedule·${slot}`;
}

export interface RecrawlOptions {
  /** The schedule slot this scan is for. Default: the one containing now. */
  slot?: number;
}

export interface ScheduledCrawl {
  siteId: string;
  outcome: ScheduledOutcome;
  /** The run started or adopted, or the live run / this slot's run that caused the skip. */
  runId?: string;
  error?: string;
  /** STARTED / RESUMED only: settles when the run ends (never rejects). */
  done?: Promise<CrawlRunResult | undefined>;
}

/** One SCHEDULE crawl per READY site and slot, without waiting for the runs to end. */
export async function recrawlReadySites(
  deps: CrawlDeps,
  opts: RecrawlOptions = {},
): Promise<ScheduledCrawl[]> {
  const { pool } = deps.db;
  const staleMs = deps.staleRunMs ?? CRAWL_DEFAULTS.staleRunMs;
  const key = scheduleKey(opts.slot ?? scheduleSlot());
  const slotRun = async (siteId: string) =>
    (
      await pool.query<{ id: string }>(
        `SELECT id FROM crawl_runs WHERE site_id = $1 AND idempotency_key = $2`,
        [siteId, key],
      )
    ).rows[0]?.id;
  const { rows: sites } = await pool.query<{ id: string }>(
    `SELECT id FROM sites WHERE status = 'READY' ORDER BY created_at, id`,
  );

  const out: ScheduledCrawl[] = [];
  for (const { id: siteId } of sites) {
    // This slot already has its run for the site (live or ended): never a second one.
    const prior = await slotRun(siteId);
    if (prior) {
      out.push({ siteId, outcome: 'ALREADY_SCHEDULED', runId: prior });
      continue;
    }
    // A live run that is still heartbeating: skip. Calling startCrawl for it would leave a poller
    // waiting on another process's run. A stale one falls through and startCrawl adopts it.
    const live = await pool.query<{ id: string }>(
      `SELECT id FROM crawl_runs
        WHERE site_id = $1 AND status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE' AND trigger <> 'CLAIM'
          AND updated_at > now() - make_interval(secs => $2::double precision / 1000)`,
      [siteId, staleMs],
    );
    if (live.rowCount) {
      out.push({ siteId, outcome: 'SKIPPED_LIVE', runId: live.rows[0]!.id });
      continue;
    }
    try {
      const started = await startCrawl({ siteId, trigger: 'SCHEDULE', idempotencyKey: key }, deps);
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
      // Another scan of this slot inserted the site's run between our check and our insert.
      const winner = isUniqueViolation(err)
        ? await slotRun(siteId).catch(() => undefined)
        : undefined;
      if (winner) {
        out.push({ siteId, outcome: 'ALREADY_SCHEDULED', runId: winner });
        continue;
      }
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
export async function nightlyCheck(
  deps: CrawlDeps,
  opts: RecrawlOptions = {},
): Promise<NightlyResult> {
  // The ledger check runs even if starting the crawls failed.
  const crawls = await recrawlReadySites(deps, opts).catch((err: unknown) => {
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
let cached: CrawlDeps | undefined;

/**
 * Deps for the two jobs, or `null` when jobs are off: under vitest they stay off until
 * `setScheduleDeps` (a test's `setJobDeps` for the money jobs doesn't switch them on, so no test
 * reaches `defaultCrawlDeps()` and the environment's `DATABASE_URL`). Outside tests:
 * `defaultCrawlDeps()`, the crawl pool and config the crawl tasks already use, plus SP-041a's
 * `handOff`, so with `WORKFLOWS_MODE=workflows` a scheduled run starts on Render Workflows like
 * "Crawl now" (falling back to in-process if Render can't be reached).
 */
export function scheduleJobDeps(
  env: Record<string, string | undefined> = process.env,
): CrawlDeps | null {
  if (override) return override;
  if (env.VITEST) return null;
  if (!cached) {
    const base = defaultCrawlDeps(env);
    cached = {
      ...base,
      handOff: (args) => handOffToWorkflows('crawlSite', args, { db: base.db, env }),
    };
  }
  return cached;
}

/** Tests: run the schedule jobs against `deps` (`undefined` turns them off again). */
export function setScheduleDeps(deps: CrawlDeps | undefined): void {
  override = deps;
}
