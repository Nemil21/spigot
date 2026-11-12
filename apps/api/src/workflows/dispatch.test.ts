import { describe, expect, it, vi } from 'vitest';
import {
  dispatch,
  handOffToWorkflows,
  idempotencyKeyFor,
  taskSlug,
  workflowsMode,
  WorkflowsDispatchError,
  type WorkflowsStartClient,
} from './dispatch.js';

/** Render's start endpoint as far as dispatch can tell: one run per idempotency key. */
function fakeRender() {
  const runs = new Map<string, string>();
  const calls: { slug: string; input: unknown[]; key: string }[] = [];
  const client: WorkflowsStartClient = {
    startTask: vi.fn(async (slug, input, { idempotencyKey }) => {
      calls.push({ slug, input, key: idempotencyKey });
      let id = runs.get(idempotencyKey);
      if (!id) {
        id = `trn-${runs.size + 1}`;
        runs.set(idempotencyKey, id);
      }
      return { taskRunId: id };
    }),
  };
  return { client, calls };
}

function fakeDb() {
  const writes: unknown[][] = [];
  return {
    writes,
    db: {
      pool: {
        query: vi.fn(async (_sql: string, params?: unknown[]) => {
          writes.push(params ?? []);
          return { rows: [], rowCount: 1 };
        }),
      },
    } as never,
  };
}

const RUN = '7b0c8e8e-3f7a-4a57-9a8b-3f1b8d1c2a10';
const args = { siteId: 'site-1', trigger: 'MANUAL', runId: RUN };

describe('workflowsMode', () => {
  it('is inproc unless WORKFLOWS_MODE is exactly workflows (any case)', () => {
    expect(workflowsMode({})).toBe('inproc');
    expect(workflowsMode({ WORKFLOWS_MODE: '' })).toBe('inproc');
    expect(workflowsMode({ WORKFLOWS_MODE: 'inproc' })).toBe('inproc');
    expect(workflowsMode({ WORKFLOWS_MODE: 'bogus' })).toBe('inproc');
    expect(workflowsMode({ WORKFLOWS_MODE: ' Workflows ' })).toBe('workflows');
  });

  it('slugs tasks under the workflow service (render.yaml name by default)', () => {
    expect(taskSlug('crawlSite', {})).toBe('spigot-workflows/crawlSite');
    expect(taskSlug('fetchBatch', { RENDER_WORKFLOWS_SERVICE_ID: 'my-wf' })).toBe(
      'my-wf/fetchBatch',
    );
  });

  it('keys a run-scoped start by task + run; others get a fresh key', () => {
    expect(idempotencyKeyFor('crawlSite', args)).toBe(`crawlSite:${RUN}`);
    const a = idempotencyKeyFor('publishWatermark', { datasetId: 'd' });
    const b = idempotencyKeyFor('publishWatermark', { datasetId: 'd' });
    expect(a).not.toBe(b);
  });
});

describe('dispatch', () => {
  it('inproc: runs the task body here, records inproc:<runId>, never calls Render', async () => {
    const { client } = fakeRender();
    const body = vi.fn(async (a: typeof args) => ({ ran: a.runId }));
    const d = await dispatch('crawlSite', args, {
      env: { WORKFLOWS_MODE: 'inproc', RENDER_API_KEY: 'rnd_x' },
      client,
      inproc: { crawlSite: body as never },
    });
    expect(d).toMatchObject({ mode: 'inproc', workflowRunId: `inproc:${RUN}` });
    await expect(d.done).resolves.toEqual({ ran: RUN });
    expect(body).toHaveBeenCalledWith(args);
    expect(client.startTask).not.toHaveBeenCalled();
  });

  it('inproc without a body for the task is an error, not a silent no-op', async () => {
    await expect(dispatch('extractPage', { pageId: 'p' }, { env: {} })).rejects.toBeInstanceOf(
      WorkflowsDispatchError,
    );
  });

  it('workflows: starts <slug>/<task> with the args and stores workflow_run_id', async () => {
    const { client, calls } = fakeRender();
    const { db, writes } = fakeDb();
    const d = await dispatch('crawlSite', args, {
      env: { WORKFLOWS_MODE: 'workflows' },
      client,
      db,
    });
    expect(d).toEqual({ mode: 'workflows', workflowRunId: 'trn-1', done: null });
    expect(calls).toEqual([
      { slug: 'spigot-workflows/crawlSite', input: [args], key: `crawlSite:${RUN}` },
    ]);
    expect(writes).toEqual([[RUN, 'trn-1']]);
  });

  it('a retried start for the same run gets the same Render run (idempotency key)', async () => {
    const { client, calls } = fakeRender();
    const { db, writes } = fakeDb();
    const deps = { env: { WORKFLOWS_MODE: 'workflows' }, client, db };
    const [a, b] = await Promise.all([
      dispatch('crawlSite', args, deps),
      dispatch('crawlSite', args, deps),
    ]);
    expect(a.workflowRunId).toBe('trn-1');
    expect(b.workflowRunId).toBe('trn-1');
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set([`crawlSite:${RUN}`]));
    expect(writes).toEqual([
      [RUN, 'trn-1'],
      [RUN, 'trn-1'],
    ]);
  });

  it('flipping WORKFLOWS_MODE back to inproc takes effect on the next call (no redeploy)', async () => {
    const { client } = fakeRender();
    const env: Record<string, string> = { WORKFLOWS_MODE: 'workflows' };
    const body = vi.fn(async () => 'local');
    const deps = { env, client, db: fakeDb().db, inproc: { crawlSite: body as never } };

    expect((await dispatch('crawlSite', args, deps)).mode).toBe('workflows');
    env.WORKFLOWS_MODE = 'inproc';
    const second = await dispatch('crawlSite', { ...args, runId: 'run-2' }, deps);
    expect(second).toMatchObject({ mode: 'inproc', workflowRunId: 'inproc:run-2' });
    await expect(second.done).resolves.toBe('local');
    expect(client.startTask).toHaveBeenCalledTimes(1);
  });

  it('workflows without RENDER_API_KEY fails with a clear error', async () => {
    await expect(
      dispatch('crawlSite', args, { env: { WORKFLOWS_MODE: 'workflows' } }),
    ).rejects.toThrow(/RENDER_API_KEY/);
  });

  it('a failed start is a WorkflowsDispatchError and writes nothing', async () => {
    const { db, writes } = fakeDb();
    const client: WorkflowsStartClient = {
      startTask: async () => {
        throw new Error('503 from Render');
      },
    };
    await expect(
      dispatch('crawlSite', args, { env: { WORKFLOWS_MODE: 'workflows' }, client, db }),
    ).rejects.toThrow(/did not start crawlSite: 503 from Render/);
    expect(writes).toEqual([]);
  });
});

describe('handOffToWorkflows (the API side)', () => {
  it('inproc → null (run here) without touching Render', async () => {
    const { client } = fakeRender();
    expect(await handOffToWorkflows('crawlSite', args, { env: {}, client })).toBeNull();
    expect(client.startTask).not.toHaveBeenCalled();
  });

  it('workflows → the Render run id', async () => {
    const { client } = fakeRender();
    const id = await handOffToWorkflows('crawlSite', args, {
      env: { WORKFLOWS_MODE: 'workflows' },
      client,
      db: fakeDb().db,
    });
    expect(id).toBe('trn-1');
  });

  it('Render down → logs and returns null, so the run still happens in process', async () => {
    const warn = vi.fn();
    const client: WorkflowsStartClient = {
      startTask: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const id = await handOffToWorkflows('extractTemplate', args, {
      env: { WORKFLOWS_MODE: 'workflows' },
      client,
      log: { warn },
    });
    expect(id).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'extractTemplate', runId: RUN }),
      'workflows: start failed, running in process',
    );
  });
});
