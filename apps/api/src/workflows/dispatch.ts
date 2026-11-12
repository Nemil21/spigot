import { randomUUID } from 'node:crypto';
import { createWorkflowsClient } from '@renderinc/sdk/workflows';
import type { Queryable } from '../db/index.js';

/**
 * `dispatch(task, args)` (SP-041a; features/03 §Logic 7, §Render Workflows layout).
 *
 * - `WORKFLOWS_MODE=inproc` (default): run the task function in this process; the run id is
 *   `inproc:<id>`.
 * - `WORKFLOWS_MODE=workflows`: start a Render Workflows task run (`<workflow slug>/<task>`) with
 *   `RENDER_API_KEY`, keyed by an idempotency key so a retried start returns the same run, and
 *   store its id on `crawl_runs.workflow_run_id` when the task belongs to a run.
 *
 * The mode is read from the environment on **every call**, so switching back to `inproc` needs
 * no change to (or redeploy of) the workflow service: the API simply stops starting runs there.
 * Task bodies are the same functions either way (`@spigot/api/tasks`).
 */

export const WORKFLOW_TASKS = [
  'crawlSite',
  'fetchBatch',
  'fetchPage',
  'extractTemplate',
  'extractPage',
  'publishWatermark',
  'payoutRun',
] as const;
export type WorkflowTask = (typeof WORKFLOW_TASKS)[number];

export type WorkflowsMode = 'inproc' | 'workflows';

/** The workflow service's name in render.yaml, used when `RENDER_WORKFLOWS_SERVICE_ID` is unset. */
export const DEFAULT_WORKFLOW_SLUG = 'spigot-workflows';

type Env = Record<string, string | undefined>;

/** `WORKFLOWS_MODE`, read now. Anything but `workflows` is in-process (the safe default). */
export function workflowsMode(env: Env = process.env): WorkflowsMode {
  return env.WORKFLOWS_MODE?.trim().toLowerCase() === 'workflows' ? 'workflows' : 'inproc';
}

/** `<workflow slug>/<task>`, the SDK's task slug. */
export function taskSlug(task: WorkflowTask, env: Env = process.env): string {
  const slug = env.RENDER_WORKFLOWS_SERVICE_ID?.trim() || DEFAULT_WORKFLOW_SLUG;
  return `${slug}/${task}`;
}

/** The slice of the SDK's `WorkflowsClient` dispatch uses, so tests pass a fake. */
export interface WorkflowsStartClient {
  startTask(
    slug: string,
    input: unknown[],
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<{ taskRunId: string }>;
}

export class WorkflowsDispatchError extends Error {
  constructor(
    readonly task: WorkflowTask,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkflowsDispatchError';
  }
}

export interface DispatchDeps {
  /** Where `workflow_run_id` is written (Workflows mode, tasks with a `runId`). */
  db?: { pool: Queryable };
  /** Default `process.env`, read per call. */
  env?: Env;
  /** Default: the SDK client with `RENDER_API_KEY`, built on first Workflows dispatch. */
  client?: WorkflowsStartClient;
  /** In-process bodies, by task. Required for the tasks dispatched in `inproc` mode. */
  inproc?: Partial<Record<WorkflowTask, (args: never) => Promise<unknown>>>;
  /** Per Render API call. Default 15 s. */
  timeoutMs?: number;
}

export interface Dispatched {
  mode: WorkflowsMode;
  /** The Render task run id, or `inproc:<id>`. */
  workflowRunId: string;
  /** In-process only: settles with the task's result. */
  done: Promise<unknown> | null;
}

/** A task's arguments are one JSON object; tasks that belong to a crawl run carry `runId`. */
type TaskArgs = Record<string, unknown> & { runId?: string };

/**
 * Same task + same run → same key, so a retried start (two API instances, a retried request)
 * returns the run the first start created. Tasks without a run get a fresh key per call.
 */
export function idempotencyKeyFor(task: WorkflowTask, args: TaskArgs): string {
  if (typeof args.runId === 'string' && args.runId) return `${task}:${args.runId}`;
  return `${task}:${randomUUID()}`;
}

let sdkClient: WorkflowsStartClient | undefined;

function defaultClient(env: Env, task: WorkflowTask): WorkflowsStartClient {
  const token = env.RENDER_API_KEY?.trim();
  // `render workflows dev` (RENDER_USE_LOCAL_DEV=true): the SDK talks to the local runner.
  if (env.RENDER_USE_LOCAL_DEV === 'true') return (sdkClient ??= createWorkflowsClient({}));
  if (!token) {
    throw new WorkflowsDispatchError(task, 'WORKFLOWS_MODE=workflows needs RENDER_API_KEY');
  }
  sdkClient ??= createWorkflowsClient({ token });
  return sdkClient;
}

export async function dispatch(
  task: WorkflowTask,
  args: TaskArgs,
  deps: DispatchDeps = {},
): Promise<Dispatched> {
  const env = deps.env ?? process.env;
  if (workflowsMode(env) === 'inproc') {
    const body = deps.inproc?.[task] as ((a: TaskArgs) => Promise<unknown>) | undefined;
    if (!body) throw new WorkflowsDispatchError(task, `no in-process body for task ${task}`);
    const id = typeof args.runId === 'string' && args.runId ? args.runId : randomUUID();
    return { mode: 'inproc', workflowRunId: `inproc:${id}`, done: body(args) };
  }

  const client = deps.client ?? defaultClient(env, task);
  let taskRunId: string;
  try {
    ({ taskRunId } = await client.startTask(taskSlug(task, env), [args], {
      idempotencyKey: idempotencyKeyFor(task, args),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    }));
  } catch (err) {
    throw new WorkflowsDispatchError(
      task,
      `Render Workflows did not start ${task}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (typeof args.runId === 'string' && args.runId && deps.db) {
    await deps.db.pool.query('UPDATE crawl_runs SET workflow_run_id = $2 WHERE id = $1', [
      args.runId,
      taskRunId,
    ]);
  }
  return { mode: 'workflows', workflowRunId: taskRunId, done: null };
}

/**
 * The API side of a run that may go to Workflows (`CrawlDeps.handOff`, the APPROVE extract):
 * in `inproc` mode returns null (run it here, as before). In `workflows` mode starts the task and
 * returns its run id; if Render can't be reached it logs and returns null, so the run still
 * happens in process: the demo never depends on Workflows being up.
 */
export async function handOffToWorkflows(
  task: WorkflowTask,
  args: TaskArgs,
  deps: DispatchDeps & { log?: { warn: (obj: object, msg: string) => void } },
): Promise<string | null> {
  if (workflowsMode(deps.env ?? process.env) === 'inproc') return null;
  try {
    return (await dispatch(task, args, deps)).workflowRunId;
  } catch (err) {
    deps.log?.warn({ err, task, runId: args.runId }, 'workflows: start failed, running in process');
    return null;
  }
}
