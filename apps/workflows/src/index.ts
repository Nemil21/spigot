// Render Workflows entry (SP-041a). Importing this module registers each task with the Render
// SDK; on Render (RENDER_SDK_SOCKET_PATH set) the SDK then starts the task server. The task
// bodies stay in apps/api (`@spigot/api/tasks`); this file only names them and sets the retry
// policy of features/03 §Render Workflows layout. SP-041b adds `payoutRun`.
import { task, type Retry, type TaskContext } from '@renderinc/sdk/workflows';
import { workflowTaskBodies, workflowsRuntime } from '@spigot/api/tasks';

type Bodies = ReturnType<typeof workflowTaskBodies>;
type ArgsOf<K extends keyof Bodies> = Parameters<Bodies[K]>[0];

/** Built on the first task call, not at import (registration must stay synchronous). */
const bodies = (): Bodies => workflowTaskBodies(workflowsRuntime());

/** `n` retries, `firstMs` then ×4 each time (1 s, 4 s, 16 s for fetchPage). */
const retries = (maxRetries: number, firstMs = 1_000): Retry => ({
  maxRetries,
  waitDurationMs: firstMs,
  backoffScaling: 4,
});

/**
 * Task names, as the API starts them (`<workflow slug>/<name>`, workflows/dispatch.ts). The
 * retry count per task follows spec 03's table; every body is idempotent.
 */
export const TASKS = {
  crawlSite: 'crawlSite',
  fetchBatch: 'fetchBatch',
  fetchPage: 'fetchPage',
  extractTemplate: 'extractTemplate',
  extractPage: 'extractPage',
  publishWatermark: 'publishWatermark',
  payoutRun: 'payoutRun',
} as const;

/** One share of a run's pages, fetched one at a time (≤ 2 of these per host at once). */
const fetchBatchTask = task(
  { name: TASKS.fetchBatch, retry: retries(1), timeoutSeconds: 3_600, plan: 'starter' },
  (_ctx: TaskContext, args: ArgsOf<'fetchBatch'>) => bodies().fetchBatch(args),
);

/**
 * Executes the run the API handed off: sitemap, page selection, then exactly `planBatches`
 * (2 per host) `fetchBatch` runs, then the run end and discovery hand-off.
 */
const crawlSiteTask = task(
  { name: TASKS.crawlSite, retry: retries(1, 5_000), timeoutSeconds: 3_600, plan: 'starter' },
  (ctx: TaskContext, args: ArgsOf<'crawlSite'>) =>
    bodies().crawlSite(args, {
      taskRunId: ctx.metadata.taskRunId,
      runFetchBatch: (batch) => ctx.run(fetchBatchTask, batch),
    }),
);

/** A single page (P1 ping / re-fetch); its own body retries network / 5xx at 1 s, 4 s, 16 s. */
const fetchPageTask = task(
  { name: TASKS.fetchPage, retry: retries(3), timeoutSeconds: 900, plan: 'starter' },
  (_ctx: TaskContext, args: ArgsOf<'fetchPage'>) => bodies().fetchPage(args),
);

/** The APPROVE run: filter indexes, then every page of the template in batches of 200. */
const extractTemplateTask = task(
  { name: TASKS.extractTemplate, retry: retries(2), timeoutSeconds: 3_600 },
  (_ctx: TaskContext, args: ArgsOf<'extractTemplate'>) => bodies().extractTemplate(args),
);

const extractPageTask = task(
  { name: TASKS.extractPage, retry: retries(2), timeoutSeconds: 300, plan: 'starter' },
  (_ctx: TaskContext, args: ArgsOf<'extractPage'>) => bodies().extractPage(args),
);

const publishWatermarkTask = task(
  { name: TASKS.publishWatermark, retry: retries(3), timeoutSeconds: 300, plan: 'starter' },
  (_ctx: TaskContext, args: ArgsOf<'publishWatermark'>) => bodies().publishWatermark(args),
);

/**
 * SP-041b: one payout run (features/09 §Logic, SP-020). **Render-level retries are off**: this
 * is money, and SP-020's `payoutRun` is the only retry owner (3 tries with the same
 * `sender_batch_id` inside the run). Spec 03's "1 retry, idempotent by batch id" is that resume:
 * a run that dies mid-way leaves its batch BUILDING / SUBMITTED, and the next `payoutRun`
 * (this task, the weekly job or "Run payout now") resubmits it with the same batch id before it
 * builds anything new. The advisory lock makes a Workflows run and an in-process run safe at once.
 */
const payoutRunTask = task(
  { name: TASKS.payoutRun, retry: retries(0), timeoutSeconds: 600, plan: 'starter' },
  (_ctx: TaskContext, args: ArgsOf<'payoutRun'>) => bodies().payoutRun(args),
);

export const taskNames = Object.values(TASKS);

/** Registered definitions, by name (tests and `taskNames`). */
export const registered: readonly { name: string }[] = [
  crawlSiteTask,
  fetchBatchTask,
  fetchPageTask,
  extractTemplateTask,
  extractPageTask,
  publishWatermarkTask,
  payoutRunTask,
];
