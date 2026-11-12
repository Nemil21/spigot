import type { FastifyPluginAsync } from 'fastify';
import { activityFeed, parseActivityQuery } from '../activity/feed.js';
import { requirePublisher } from '../auth/publisherAuth.js';

/**
 * Publisher activity feed for W04 (SP-027a; api.md §`GET /api/publishers/me/activity`).
 * `?limit=50` (1–200) → `{ events: [{ id, at, action, entity, entityId, isSimulated, line }] }`,
 * newest first, only the session publisher's events (`activity/feed.ts`).
 */
const activityRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/publishers/me/activity', async (req) => {
    const publisher = requirePublisher(req);
    const limit = parseActivityQuery(req.query);
    return { events: await activityFeed(app.db.pool, publisher.id, limit) };
  });
};

export default activityRoutes;
