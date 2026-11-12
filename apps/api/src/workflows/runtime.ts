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
import { onPageChanged, onRunFinished } from '../crawl/hooks.js';
import {
  extractChangedPage,
  publishRunDatasets,
  runApproveExtract,
  type ApproveRunArgs,
} from '../datasets/extractRun.js';
import type { Db } from '../db/index.js';
import { extractPage } from '../extract/extractPage.js';
import { publishWatermark } from '../extract/publishWatermark.js';
import { startSchemaAgent } from '../schema-agent/runtime.js';

/**
 * The workflow service's side of SP-041a (apps/workflows registers these bodies with the Render
 * SDK). The API process wires the crawl hooks in its route plugins; a crawl that runs on Render
 * fires them in the workflow service instead, so the same handlers are registered here:
 *
 * - `onPageChanged` → extract the page into its sold datasets (SP-014a);
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
  /** Unregister the hooks (tests). */
  stop(): void;
}

/** Register the crawl hooks the API registers in its plugins. Returns an unsubscribe function. */
export function wireWorkflowHooks(opts: { db: Db; config: Config; log: Log }): () => void {
  const offPage = onPageChanged(async (pageId, runId) => {
    await extractChangedPage(opts.db, pageId, runId);
  });
  const offRun = onRunFinished(async (runId) => {
    await publishRunDatasets(opts.db, runId);
    await auditCrawlRunDone(opts.db, runId);
  });
  const offSchema = startSchemaAgent(opts);
  return () => {
    offPage();
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
  cached = { db: crawlDeps.db, config, crawlDeps, log: consoleLog, stop };
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
 * Each Workflows task's body over a runtime. `crawlSite` executes the run the API handed off
 * and fans its pages out as **exactly `planBatches` (≤ 2 per host) `fetchBatch` task runs**.
 */
export function workflowTaskBodies(rt: Pick<WorkflowsRuntime, 'db' | 'crawlDeps' | 'log'>) {
  return {
    crawlSite: (args: CrawlSiteArgs & { runId: string }, ctx: TaskRunContext) =>
      crawlSite(
        { ...args, workflowRunId: ctx.taskRunId },
        {
          ...rt.crawlDeps,
          fanOut: (runId, pageIds) =>
            Promise.all(
              planBatches(pageIds).map((share) => ctx.runFetchBatch({ runId, pageIds: share })),
            ),
        },
      ),
    fetchBatch: (args: FetchBatchArgs) => fetchBatch(args, rt.crawlDeps),
    fetchPage: (args: FetchPageArgs) => fetchPage(args, rt.crawlDeps),
    /** The APPROVE run (dispatched by the approve route): filter indexes + `extractTemplate`. */
    extractTemplate: (args: ApproveRunArgs) => runApproveExtract(rt.db, args, { log: rt.log }),
    extractPage: (args: { pageId: string; datasetId: string; runId: string }) =>
      extractPage(args, { db: rt.db }),
    publishWatermark: (args: { datasetId: string }) => publishWatermark(args, { db: rt.db }),
  };
}
