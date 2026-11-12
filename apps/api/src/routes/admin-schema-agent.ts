import type { FastifyPluginAsync } from 'fastify';
import { adminOnly } from '../auth/admin.js';
import { ApiError } from '../http/errors.js';
import { proposeForSite } from '../schema-agent/propose.js';
import { logResult, schemaAgentRuntime } from '../schema-agent/runtime.js';
import { isUuid } from '../tenancy.js';

/**
 * `POST /admin/sites/:id/repropose` (SP-012a; admins only): run the schema agent's proposal for a
 * PROPOSING or READY site now, the on-demand twin of the resume job. Templates that already have
 * a dataset are skipped, so this only fills in what is missing. Waits for the run and returns its
 * per-template outcome.
 * 404 unknown site · 409 STATE_CONFLICT when the site isn't PROPOSING / READY or a run holds the lock.
 */
const adminSchemaAgentRoutes: FastifyPluginAsync = async (app) => {
  app.post('/admin/sites/:id/repropose', { preHandler: adminOnly }, async (req) => {
    const { id } = req.params as { id?: string };
    if (!isUuid(id)) throw new ApiError('NOT_FOUND', 'No such site.');
    const rt = schemaAgentRuntime();
    if (!rt) throw new ApiError('INTERNAL_ERROR', 'The schema agent is not running.');

    const r = await proposeForSite(rt.deps(), id, { trigger: 'ADMIN' });
    if (r.status === 'not_found') throw new ApiError('NOT_FOUND', 'No such site.');
    if (r.status === 'busy') {
      throw new ApiError('STATE_CONFLICT', 'A proposal run for this site is already in progress.');
    }
    if (r.status === 'wrong_status') {
      throw new ApiError(
        'STATE_CONFLICT',
        `Site is ${r.siteStatus}; only PROPOSING or READY sites can be re-proposed.`,
      );
    }
    logResult(rt.log, r);
    return {
      siteId: r.siteId,
      siteStatus: r.siteStatus,
      runId: r.runId,
      proposals: r.proposals,
      aiCalls: r.aiCalls,
      templates: r.templates.map((t) => ({
        pathPattern: t.pathPattern,
        pageCount: t.pageCount,
        status: t.status,
        typeName: t.typeName ?? null,
        datasetId: t.datasetId ?? null,
        reason: t.reason ?? null,
      })),
    };
  });
};

export default adminSchemaAgentRoutes;
