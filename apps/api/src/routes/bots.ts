import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { botsReport, parseBotsQuery } from '../bots/report.js';

/**
 * W04 bot report (SP-027a; api.md §`GET /api/sites/:id/bots`). Publisher session only; another
 * publisher's site is a 404 (`security/tenancy/bots.cases.ts`).
 *
 * `GET /api/sites/:id/bots?from&to&includeSim=true` → `{ range, includeSim, totals, byBot,
 * series, earnedThisWeek }` (see `bots/report.ts`). `from` / `to` are ISO date-times (default:
 * the 7 days ending now, at most 92 days); `includeSim=false` drops SIM rows.
 */
const botsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/api/sites/:id/bots', async (req) => {
    const publisher = requirePublisher(req);
    const input = parseBotsQuery(req.query);
    return botsReport(app.db.pool, publisher.id, req.params.id, input);
  });
};

export default botsRoutes;
