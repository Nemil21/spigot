import type { FastifyPluginAsync } from 'fastify';
import { enforceRate, RateLimiter } from '../http/rateLimit.js';

const PORTAL = ['/api/', '/admin/'];

/**
 * `app.rateLimiter` (one in-memory token-bucket limiter per process, http/rateLimit.ts) and the
 * publisher API limit: 120 requests/min per signed-in user on `/api/` and `/admin/`. A buyer
 * portal session gets the same limit under its own key. Other limits (REST, MCP, gate) are
 * applied by their routes with `rateLimit(bucket, keyOf)`.
 */
const rateLimits: FastifyPluginAsync = async (app) => {
  app.decorate('rateLimiter', new RateLimiter());
  app.addHook('onRequest', async (req, reply) => {
    const principal = req.publisher
      ? `publisher:${req.publisher.id}`
      : req.buyer?.via === 'session'
        ? `buyer:${req.buyer.id}`
        : null;
    if (!principal) return;
    const path = req.url.split('?', 1)[0]!;
    if (!PORTAL.some((p) => path.startsWith(p))) return;
    enforceRate(reply, app.rateLimiter.take('portal', principal));
  });
};

export default rateLimits;
