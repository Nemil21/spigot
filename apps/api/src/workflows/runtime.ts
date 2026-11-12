import type { FastifyBaseLogger } from 'fastify';
import { loadConfig, type Config } from '../config.js';
import { auditCrawlRunDone } from '../crawl/api.js';
import { crawlSite, type CrawlSiteArgs } from '../crawl/crawlSite.js';
import { defaultCrawlDeps, type CrawlDeps } from '../crawl/deps.js';
import {
  fetchBatch,
  planBatches,
  type FetchBatchArgs,
  type FetchBatchResult,
} from '../crawl/fetchBatch.js';
import { fetchPage, type FetchPageArgs } from '../crawl/fetchPage.js';
import { onPageChanged, onRunEnding, onRunFinished } from '../crawl/hooks.js';
import {
  extractChangedPage,
  publishRunDatasets,
  runApproveExtract,
  settleRunDatasets,
  type ApproveRunArgs,
} from '../datasets/extractRun.js';
import type { Db } from '../db/index.js';
import { extractPage } from '../extract/extractPage.js';
import { publishWatermark } from '../extract/publishWatermark.js';
import { payoutPayPal, type PayoutsPayPal } from '../payouts/deps.js';
import { payoutRun, type PayoutRunResult, type PayoutTrigger } from '../payouts/payoutRun.js';
import { notifyBatchPublishers } from '../payouts/reconcile.js';
import { startSchemaAgent } from '../schema-agent/runtime.js';

/**
 * The workflow service's side of SP-041a (apps/workflows registers these bodies with the Render
 * SDK). The API process wires the crawl hooks in its route plugins; a crawl that runs on Render
 * fires them in the workflow service instead, so the same handlers are registered here:
 *
 * - `onPageChanged` → extract the page into its sold datasets (SP-014a);
 * - `onRunEnding` → settle the run's drift probes, writing held pages (SP-052a);
 * - `onRunFinished` → publish the site's watermarks (SP-014a) and audit `CRAWL_RUN_DONE` (SP-009b);
 * - `onDiscoveryDone` → the schema agent (SP-012a; the API's resume job covers a miss).
 *
 * Every handler is idempotent, so a run that is retried (or later adopted in process) may fire
 * them again safely.
 */

type Log = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

/** One JSON line per entry on the workflow service's stdout (Render's task logs). */
const line =
  (level: 'info' | 'warn' | 'error') =>
  (obj: unknown, msg?: unknown): void => {
    const fields = typeof obj === 'object' && obj !== null ? safe(obj) : { msg: obj };
    const out = JSON.stringify({ level, ...(msg === undefined ? {} : { msg }), ...fields });
    (level === 'info' ? console.log : level === 'warn' ? console.warn : console.error)(out);
  };

const consoleLog = { info: line('info'), warn: line('warn'), error: line('error') } as Log;

/** Errors keep their message only (no stacks with connection strings in them). */
function safe(obj: object): object {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v instanceof Error ? v.message : v;
  return out;
}

export interface WorkflowsRuntime {
  db: Db;
  config: Config;
  crawlDeps: CrawlDeps;
  log: Log;
  /** SP-041b: the payouts client `payoutRun` uses (`PAYPAL_MODE=stub` → FakePayPal). */
  payouts: PayoutsPayPal;
  /** Unregister the hooks (tests). */
  stop(): void;
}

/** Register the crawl hooks the API registers in its plugins. Returns an unsubscribe function. */
export function wireWorkflowHooks(opts: { db: Db; config: Config; log: Log }): () => void {
  const offPage = onPageChanged(async (pageId, runId) => {
    await extractChangedPage(opts.db, pageId, runId);
  });
  const offEnding = onRunEnding(async (runId) => {
    await settleRunDatasets(opts.db, runId);
  });
  const offRun = onRunFinished(async (runId) => {
    await publishRunDatasets(opts.db, runId);
    await auditCrawlRunDone(opts.db, runId);
  });
  const offSchema = startSchemaAgent(opts);
  return () => {
    offPage();
    offEnding();
    offRun();
    offSchema();
  };
}

let cached: WorkflowsRuntime | undefined;

/** Built on the first task call in this process (config + one small pool + hooks). */
export function workflowsRuntime(env: Record<string, string | undefined> = process.env) {
  if (cached) return cached;
  const config = loadConfig(env);
  const crawlDeps = defaultCrawlDeps(env);
  const stop = wireWorkflowHooks({ db: crawlDeps.db, config, log: consoleLog });
  cached = {
    db: crawlDeps.db,
    config,
    crawlDeps,
    log: consoleLog,
    payouts: payoutPayPal(config),
    stop,
  };
  return cached;
}

/** What a task body needs from the Render task context. */
export interface TaskRunContext {
  /** This task run's id (`ctx.metadata.taskRunId`). */
  taskRunId?: string;
  /** Start one `fetchBatch` task run and wait for it (`ctx.run(fetchBatchTask, args)`). */
  runFetchBatch: (args: FetchBatchArgs) => Promise<FetchBatchResult>;
}

/**
 * `payoutRun`'s task input (SP-041b). Task arguments travel as JSON, so `periodEnd` is an ISO
 * 8601 string here and becomes the `Date` SP-020's `payoutRun` takes.
 */
export interface PayoutTaskArgs {
  trigger: PayoutTrigger;
  /** MANUAL_DEMO only (labelled demo control): threshold for this run, min $1. */
  thresholdCentsOverride?: number;
  /** SCHEDULE runs are unique per `period_end`. Default now. */
  periodEnd?: string;
}

/**
 * What a `payoutRun` task run returns. Render keeps task results in its dashboard, so this is
 * ids and counts only: no receiver emails (PII) and nothing a log line couldn't show.
 */
export interface PayoutTaskResult {
  outcome: PayoutRunResult['outcome'];
  batchId: string | null;
  resumed: boolean;
  /** Items in the batch, read back from the database (a resumed run returns none in memory). */
  itemCount: number;
  paypalBatchId?: string;
  errorCode?: string;
}

/**
 * The `payoutRun` task body: SP-020's `payoutRun` unchanged (advisory lock, resume first with the
 * same `sender_batch_id`, its own 3 tries on network / 5xx), then `payout.updated` for W09 (a
 * Postgres NOTIFY, so the API's SSE bus hears it from this process too).
 */
export async function runPayoutTask(
  rt: { db: Pick<Db, 'pool'>; payouts: PayoutsPayPal; log: Log },
  args: PayoutTaskArgs,
): Promise<PayoutTaskResult> {
  let periodEnd: Date | undefined;
  if (args.periodEnd !== undefined) {
    periodEnd = new Date(args.periodEnd);
    if (Number.isNaN(periodEnd.getTime())) {
      throw new TypeError(`payoutRun: periodEnd ${JSON.stringify(args.periodEnd)} is not a date`);
    }
  }
  const res = await payoutRun(
    {
      trigger: args.trigger,
      ...(args.thresholdCentsOverride !== undefined
        ? { thresholdCentsOverride: args.thresholdCentsOverride }
        : {}),
      ...(periodEnd ? { periodEnd } : {}),
    },
    { pool: rt.db.pool, pp: rt.payouts },
  );
  let itemCount = 0;
  if (res.batchId) {
    const { rows } = await rt.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM payout_items WHERE batch_id = $1',
      [res.batchId],
    );
    itemCount = rows[0]?.n ?? 0;
    await notifyBatchPublishers(rt.db.pool, res.batchId).catch((err) =>
      rt.log.warn({ err, batchId: res.batchId }, 'workflows: payout.updated notify failed'),
    );
  }
  const out: PayoutTaskResult = {
    outcome: res.outcome,
    batchId: res.batchId,
    resumed: res.resumed,
    itemCount,
    ...('paypalBatchId' in res ? { paypalBatchId: res.paypalBatchId } : {}),
    ...('errorCode' in res ? { errorCode: res.errorCode } : {}),
  };
  rt.log.info({ ...out, trigger: args.trigger }, 'workflows: payoutRun');
  return out;
}

/**
 * Each Workflows task's body over a runtime. `crawlSite` executes the run the API handed off
 * and fans its pages out as **exactly `planBatches` (≤ 2 per host) `fetchBatch` task runs**.
 * `payouts` is needed by `payoutRun` only (crawl tests leave it out).
 */
export function workflowTaskBodies(
  rt: Pick<WorkflowsRuntime, 'db' | 'crawlDeps' | 'log'> &
    Partial<Pick<WorkflowsRuntime, 'payouts'>>,
) {
  return {
    crawlSite: (args: CrawlSiteArgs & { runId: string }, ctx: TaskRunContext) =>
      crawlSite(
        { ...args, workflowRunId: ctx.taskRunId },
        {
          ...rt.crawlDeps,
          fanOut: (runId, pageIds) => fanOutBatches(rt, ctx, runId, pageIds),
        },
      ),
    fetchBatch: (args: FetchBatchArgs) => fetchBatch(args, rt.crawlDeps),
    fetchPage: (args: FetchPageArgs) => fetchPage(args, rt.crawlDeps),
    /** The APPROVE run (dispatched by the approve route): filter indexes + `extractTemplate`. */
    extractTemplate: (args: ApproveRunArgs) => runApproveExtract(rt.db, args, { log: rt.log }),
    extractPage: (args: { pageId: string; datasetId: string; runId: string }) =>
      extractPage(args, { db: rt.db }),
    publishWatermark: (args: { datasetId: string }) => publishWatermark(args, { db: rt.db }),
    /** SP-041b: one payout run (SP-020), JSON in and out. */
    payoutRun: (args: PayoutTaskArgs) => {
      const { payouts } = rt;
      if (!payouts) throw new Error('workflowTaskBodies: payoutRun needs rt.payouts');
      return runPayoutTask({ db: rt.db, payouts, log: rt.log }, args);
    },
  };
}

/**
 * Start one `fetchBatch` per `planBatches` share and wait for **every** one to end. A batch run
 * that fails for good (timeout, retries used up) doesn't end the crawl early: like a page error
 * in process, its unanswered pages count as failed (never past `pages_total`), and the run ends
 * from its counters (SUCCEEDED / PARTIAL / FAILED) once its sibling has finished too.
 */
export async function fanOutBatches(
  rt: Pick<WorkflowsRuntime, 'db' | 'log'>,
  ctx: TaskRunContext,
  runId: string,
  pageIds: string[],
): Promise<FetchBatchResult[]> {
  const shares = planBatches(pageIds);
  const settled = await Promise.allSettled(
    shares.map((share) => ctx.runFetchBatch({ runId, pageIds: share })),
  );
  const results: FetchBatchResult[] = [];
  for (const [i, s] of settled.entries()) {
    if (s.status === 'fulfilled') {
      results.push(s.value);
      continue;
    }
    rt.log.error({ err: s.reason, runId, share: i }, 'workflows: fetchBatch failed');
    await countUnanswered(rt.db, runId, shares[i]!).catch((err) =>
      rt.log.error({ err, runId }, 'workflows: could not count a failed batch'),
    );
    results.push({ attempted: 0, alreadyDone: 0, stopped: false });
  }
  return results;
}

/** Pages of a failed share this run never answered → `pages_failed`, capped at `pages_total`. */
async function countUnanswered(db: Db, runId: string, share: string[]): Promise<void> {
  await db.pool.query(
    `WITH missing AS (
       SELECT count(*)::int AS n FROM pages p JOIN crawl_runs r ON r.id = $1
        WHERE p.id = ANY($2::uuid[])
          AND (r.started_at IS NULL OR p.fetched_at IS NULL OR p.fetched_at < r.started_at))
     UPDATE crawl_runs r
        SET pages_failed = r.pages_failed + LEAST(m.n, GREATEST(0,
              r.pages_total - r.pages_fetched - r.pages_not_modified - r.pages_failed))
       FROM missing m
      WHERE r.id = $1`,
    [runId, share],
  );
}
