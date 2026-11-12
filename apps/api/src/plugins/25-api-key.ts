import type { FastifyPluginAsync } from 'fastify';

/**
 * `req.apiKey` (SP-007b), null until a route's `authenticateBearer` hook (auth/apiKeys.ts) sets
 * it. API-key auth is per route, not app-wide: `/api/gate/*` also sends `Bearer gk_…`.
 */
const apiKey: FastifyPluginAsync = async (app) => {
  app.decorateRequest('apiKey', null);
};

export default apiKey;
