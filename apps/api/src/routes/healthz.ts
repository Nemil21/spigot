import type { FastifyPluginAsync } from 'fastify';

/** Liveness for Render's health check (SP-040). No DB call: a DB outage must not restart pods. */
const healthz: FastifyPluginAsync = async (app) => {
  app.get('/api/healthz', async () => ({ ok: true }));
};

export default healthz;
