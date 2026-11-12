import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { isUniqueViolation } from '../auth/credentials.js';
import { transition, withAdvisoryXactLock, type Db, type Queryable } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { forPublisher } from '../tenancy.js';
import { startCrawl, type CrawlCounters, type CrawlTrigger, type RunStatus } from './crawlSite.js';
import type { CrawlDeps } from './deps.js';

/**
 * Crawl API service (SP-009b; api.md §`POST /api/sites/:id/crawl`, §`GET …/crawl-runs`,
 * §`POST /api/sites/:id/resume`; features/03 §Logic 3, 6; data-model §Site state machine).
 * `routes/crawl.ts` is the HTTP shell around these. Every lookup goes through `forPublisher`:
 * another publisher's site or run is a 404.
 */

/** Triggers a publisher may ask for. CONNECT comes from verify; SCHEDULE / PING / APPROVE elsewhere. */
export const crawlBody = z
  .object({ trigger: z.enum(['MANUAL', 'DEMO_MUTATE']).default('MANUAL') })
  .strict();
export type CrawlBody = z.infer<typeof crawlBody>;

export interface CrawlStarted {
  crawlRunId: string;
  workflowRunId: string | null;
  /** True when an earlier request with the same Idempotency-Key created this run. */
  replayed: boolean;
}

/** Site statuses a crawl may start from (PAUSED is resumed to READY first). */
const CRAWLABLE = ['VERIFIED', 'PROPOSING', 'READY'] as const;

const notVerified = () =>
  new ApiError('SITE_NOT_VERIFIED', 'Verify the site before crawling it.', {
    path: '/.well-known/spigot.txt',
  });

interface RunKeyRow {
  id: string;
  trigger: CrawlTrigger;
  workflow_run_id: string | null;
  idempotency_key: string | null;
}

async function runByKey(q: Queryable, siteId: string, key: string): Promise<RunKeyRow | null> {
  const { rows } = await q.query<RunKeyRow>(
    `SELECT id, trigger, workflow_run_id, idempotency_key FROM crawl_runs
      WHERE site_id = $1 AND idempotency_key = $2`,
    [siteId, key],
  );
  return rows[0] ?? null;
}

/** The same key replays its run; the same key with a different trigger is a 409. */
function replay(run: RunKeyRow, trigger: CrawlTrigger): CrawlStarted {
  if (run.trigger !== trigger) {
    throw new ApiError(
      'IDEMPOTENCY_MISMATCH',
      'This Idempotency-Key was already used for a different crawl request.',
    );
  }
  return { crawlRunId: run.id, workflowRunId: run.workflow_run_id, replayed: true };
}

/**
 * PAUSED → READY (data-model: "resume → READY"). Already READY is a no-op. Returns the status
 * the site ends in; any other status is a 409 (a PENDING_VERIFY site is a 403 instead).
 */
export async function resumeSite(db: Db, publisherId: string, siteId: string): Promise<string> {
  const scope = forPublisher(publisherId);
  const site = await scope.get<{ id: string; status: string }>(db.pool, 'sites', siteId, {
    columns: 't.id, t.status',
  });
  if (site.status === 'READY') return 'READY';
  if (site.status === 'PENDING_VERIFY') throw notVerified();
  if (site.status !== 'PAUSED') {
    throw new ApiError(
      'STATE_CONFLICT',
      `Only a paused site can be resumed (it is ${site.status}).`,
      {
        status: site.status,
      },
    );
  }
  const moved = await transition(db.pool, 'sites', site.id, 'PAUSED', 'READY', {
    updated_at: new Date(),
  });
  if (moved) return 'READY';
  // Someone else moved it first (a concurrent resume): report where it is now.
  const now = await scope.get<{ status: string }>(db.pool, 'sites', site.id, {
    columns: 't.status',
  });
  if (now.status !== 'READY') {
    throw new ApiError('STATE_CONFLICT', `The site is ${now.status}.`, { status: now.status });
  }
  return 'READY';
}

/**
 * "Crawl now". The partial unique index on `crawl_runs` is the lock: one live run per site, so
 * concurrent clicks get one 202 and 409 `CRAWL_IN_PROGRESS` (with the live run id) for the rest.
 * The Idempotency-Key is written by the same INSERT, so a retry with the key (racing or later)
 * replays the run it created.
 *
 * `onStarted` receives the run's `done` promise (the caller tracks it; it must not reject).
 */
export async function requestCrawl(
  deps: CrawlDeps,
  publisherId: string,
  siteId: string,
  input: CrawlBody & { idempotencyKey?: string },
  onStarted: (done: Promise<unknown>) => void = () => {},
): Promise<CrawlStarted> {
  const { db } = deps;
  const { trigger, idempotencyKey } = input;
  const scope = forPublisher(publisherId);
  const site = await scope.get<{ id: string; status: string }>(db.pool, 'sites', siteId, {
    columns: 't.id, t.status',
  });

  if (idempotencyKey) {
    const prior = await runByKey(db.pool, site.id, idempotencyKey);
    if (prior) return replay(prior, trigger);
  }

  if (site.status === 'PENDING_VERIFY') throw notVerified();
  if (site.status === 'PAUSED') await resumeSite(db, publisherId, site.id);
  else if (!(CRAWLABLE as readonly string[]).includes(site.status)) {
    throw new ApiError('STATE_CONFLICT', `The site is ${site.status}.`, { status: site.status });
  }

  let started;
  try {
    started = await startCrawl({ siteId: site.id, trigger, idempotencyKey }, deps);
  } catch (err) {
    // Our key's run was created and already ended between our lookup and our insert.
    if (idempotencyKey && isUniqueViolation(err)) {
      const prior = await runByKey(db.pool, site.id, idempotencyKey);
      if (prior) return replay(prior, trigger);
    }
    throw err;
  }
  started.done.catch(() => {});
  // Hand over `done` only when this process executes the run (created or adopted). A run owned
  // by another process comes back as a poller (`waitForEnd`) that nobody needs to track.
  if (started.created || started.resumed) onStarted(started.done);

  const { rows } = await db.pool.query<RunKeyRow>(
    'SELECT id, trigger, workflow_run_id, idempotency_key FROM crawl_runs WHERE id = $1',
    [started.runId],
  );
  const run = rows[0]!;
  if (started.created) {
    return { crawlRunId: run.id, workflowRunId: run.workflow_run_id, replayed: false };
  }
  // Two requests with the same key racing: the loser finds the winner's run live.
  if (idempotencyKey && run.idempotency_key === idempotencyKey) return replay(run, trigger);
  throw new ApiError('CRAWL_IN_PROGRESS', 'A crawl of this site is already running.', {
    crawlRunId: run.id,
    workflowRunId: run.workflow_run_id,
  });
}

/** `site.verified` → the discovery crawl (features/03 §Logic 3). Joins a live run if one exists. */
export async function startDiscoveryCrawl(
  deps: CrawlDeps,
  siteId: string,
): Promise<{ runId: string; created: boolean; resumed: boolean; done: Promise<unknown> }> {
  const started = await startCrawl({ siteId, trigger: 'CONNECT' }, deps);
  started.done.catch(() => {});
  return started;
}

// ---------------------------------------------------------------------------------------------
// Reads

export interface CrawlRunView {
  id: string;
  siteId: string;
  trigger: CrawlTrigger;
  status: RunStatus;
  workflowRunId: string | null;
  pagesTotal: number;
  pagesFetched: number;
  pagesNotModified: number;
  pagesFailed: number;
  recordsAdded: number;
  recordsUpdated: number;
  recordsRemoved: number;
  /** Claude calls made for this run: the discovery run's schema proposals; 0 after approval (W10). */
  aiCalls: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export const RUN_VIEW_COLUMNS = `t.id, t.site_id AS "siteId", t.trigger, t.status,
  t.workflow_run_id AS "workflowRunId", t.pages_total AS "pagesTotal",
  t.pages_fetched AS "pagesFetched", t.pages_not_modified AS "pagesNotModified",
  t.pages_failed AS "pagesFailed", t.records_added AS "recordsAdded",
  t.records_updated AS "recordsUpdated", t.records_removed AS "recordsRemoved", t.ai_calls AS "aiCalls", t.error,
  t.started_at AS "startedAt", t.finished_at AS "finishedAt", t.created_at AS "createdAt"`;

export const runsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** The site's runs, newest first. */
export async function listCrawlRuns(
  q: Queryable,
  publisherId: string,
  siteId: string,
  limit: number,
): Promise<CrawlRunView[]> {
  const scope = forPublisher(publisherId);
  const site = await scope.get<{ id: string }>(q, 'sites', siteId, { columns: 't.id' });
  const { rows } = await q.query<CrawlRunView>(
    `SELECT ${RUN_VIEW_COLUMNS} FROM crawl_runs t
      WHERE t.site_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT $2`,
    [site.id, limit],
  );
  return rows;
}

/**
 * Site-wide AI calls for W10's KPIs (SP-054), over every run, not just the listed page:
 * `discovery` sums the CONNECT runs (the schema agent's proposal calls; null before the first
 * one), `routine` every other run (must stay 0, features/04 §6).
 */
export interface CrawlAiCalls {
  discovery: number | null;
  routine: number;
}

export async function crawlAiCalls(
  q: Queryable,
  publisherId: string,
  siteId: string,
): Promise<CrawlAiCalls> {
  const scope = forPublisher(publisherId);
  const site = await scope.get<{ id: string }>(q, 'sites', siteId, { columns: 't.id' });
  const { rows } = await q.query<{ discovery: number | null; routine: number }>(
    `SELECT (SUM(ai_calls) FILTER (WHERE trigger = 'CONNECT'))::int AS discovery,
            COALESCE(SUM(ai_calls) FILTER (WHERE trigger <> 'CONNECT'), 0)::int AS routine
       FROM crawl_runs WHERE site_id = $1`,
    [site.id],
  );
  return rows[0]!;
}

/** One run of this publisher's, or 404. */
export function getCrawlRun(
  q: Queryable,
  publisherId: string,
  runId: string,
): Promise<CrawlRunView> {
  return forPublisher(publisherId).get<CrawlRunView>(q, 'crawl_runs', runId, {
    columns: RUN_VIEW_COLUMNS,
  });
}

// ---------------------------------------------------------------------------------------------
// Audit

/**
 * `onRunFinished` handler: one `CRAWL_RUN_DONE` audit row per run, with its counters. Idempotent
 * (hooks may fire again for a resumed run): the advisory lock + existence check make a second call
 * a no-op, even from another process.
 */
export async function auditCrawlRunDone(db: Db, runId: string): Promise<boolean> {
  return db.tx(async (tx) => {
    await withAdvisoryXactLock(tx, `crawl-run-done:${runId}`);
    const seen = await tx.query(
      `SELECT 1 FROM audit_events WHERE entity = 'crawl_runs' AND entity_id = $1 AND action = 'CRAWL_RUN_DONE'`,
      [runId],
    );
    if (seen.rowCount) return false;
    const { rows } = await tx.query<
      CrawlCounters & {
        publisher_id: string;
        site_id: string;
        status: RunStatus;
        trigger: CrawlTrigger;
        workflow_run_id: string | null;
        records_added: number;
        records_updated: number;
        records_removed: number;
        error: string | null;
      }
    >(
      `SELECT s.publisher_id, r.site_id, r.status, r.trigger, r.workflow_run_id, r.pages_total,
              r.pages_fetched, r.pages_not_modified, r.pages_failed, r.records_added,
              r.records_updated, r.records_removed, r.error
         FROM crawl_runs r JOIN sites s ON s.id = r.site_id WHERE r.id = $1`,
      [runId],
    );
    const r = rows[0];
    if (!r) return false;
    await audit(tx, {
      actorType: 'WORKFLOW',
      actorId: r.workflow_run_id,
      publisherId: r.publisher_id,
      entity: 'crawl_runs',
      entityId: runId,
      action: 'CRAWL_RUN_DONE',
      data: {
        siteId: r.site_id,
        status: r.status,
        trigger: r.trigger,
        pagesTotal: r.pages_total,
        pagesFetched: r.pages_fetched,
        pagesNotModified: r.pages_not_modified,
        pagesFailed: r.pages_failed,
        recordsAdded: r.records_added,
        recordsUpdated: r.records_updated,
        recordsRemoved: r.records_removed,
        ...(r.error ? { error: r.error } : {}),
      },
    });
    return true;
  });
}
