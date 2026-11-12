import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { onRunFinished } from '../crawl/hooks.js';
import { ApiError } from '../http/errors.js';
import {
  pendingReproposal,
  reinferDataset,
  reinferStale,
  type ReinferResult,
} from '../schema-agent/reinfer.js';
import { schemaAgentRuntime } from '../schema-agent/runtime.js';
import { forPublisher } from '../tenancy.js';

/**
 * Re-inference after drift (SP-052b; api.md `POST /api/datasets/:id/reinfer`, features/04 §7).
 *
 * - `POST /api/datasets/:id/reinfer` → `202 { status: 'REINFERRING' }` (the model runs after the
 *   response; `proposal.ready` on the publisher SSE when the new version is in), or
 *   `202 { status: 'PROPOSED', schemaVersionId, version }` when a re-proposal for this stale
 *   period already exists (no second model call). Only a LIVE_STALE dataset: else 409.
 * - Auto-run: when a crawl run finishes, every LIVE_STALE dataset of its site without a
 *   re-proposal is re-inferred in the background (the sweep job `schema-agent-reinfer` retries
 *   failures and catches drift the post-run backstop flagged after this hook ran).
 */

/** How long `app.close()` waits for in-process re-inference runs. */
const CLOSE_WAIT_MS = 10_000;

const reinferRoutes: FastifyPluginAsync = async (app) => {
  const running = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const t = p
      .catch((err: unknown) => app.log.error({ err }, 'schema agent: re-inference failed'))
      .finally(() => running.delete(t));
    running.add(t);
  };
  const logResults = (results: ReinferResult[]) => {
    for (const r of results) {
      if (r.status === 'busy' || r.status === 'existing') continue;
      app.log.info(
        { datasetId: r.datasetId, status: r.status, modelCalls: r.modelCalls, reason: r.reason },
        'schema agent: re-inference finished',
      );
    }
  };

  const offRun = onRunFinished(async (runId) => {
    const rt = schemaAgentRuntime();
    if (!rt) return;
    const run = (
      await app.db.pool.query<{ site_id: string }>('SELECT site_id FROM crawl_runs WHERE id = $1', [
        runId,
      ])
    ).rows[0];
    if (!run) return;
    // Background: a live model call takes a while and the crawler shouldn't wait for it.
    track(reinferStale(rt.deps(), { trigger: 'DRIFT', siteId: run.site_id }).then(logResults));
  });
  app.addHook('onClose', async () => {
    offRun();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...running]),
      new Promise((r) => {
        timer = setTimeout(r, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  });

  app.post<{ Params: { id: string } }>('/api/datasets/:id/reinfer', async (req, reply) => {
    const publisher = requirePublisher(req);
    const ds = await forPublisher(publisher.id).get<{ id: string; status: string }>(
      app.db.pool,
      'datasets',
      req.params.id,
      { columns: 't.id, t.status' },
    );
    if (ds.status !== 'LIVE_STALE') {
      throw new ApiError(
        'STATE_CONFLICT',
        `This dataset is ${ds.status}; only a dataset whose site changed layout can be re-inferred.`,
        { status: ds.status },
      );
    }
    const pending = await pendingReproposal(app.db.pool, ds.id);
    if (pending) {
      return reply
        .code(202)
        .send({ status: 'PROPOSED', schemaVersionId: pending.id, version: pending.version });
    }
    const rt = schemaAgentRuntime();
    if (!rt) throw new ApiError('INTERNAL_ERROR', 'The schema agent is not running.');
    track(reinferDataset(rt.deps(), ds.id, { trigger: 'OWNER' }).then((r) => logResults([r])));
    return reply.code(202).send({ status: 'REINFERRING' });
  });
};

export default reinferRoutes;
