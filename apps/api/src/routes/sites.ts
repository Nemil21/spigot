import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { parse } from '../http/errors.js';
import { connectBody, connectSite, getSite, listSites, type SitesDeps } from '../sites/sites.js';
import { verifySite } from '../sites/verify.js';

/**
 * Sites (api.md §Publisher endpoints; SP-008a). Publisher session only; every read goes through
 * `forPublisher` (another publisher's site is a 404).
 * - `POST /api/sites` `{ origin, sitemapUrl? }` → `201` with the gate and crawl keys (shown once).
 * - `POST /api/sites/:id/verify` → `{ status }`; `409 STATE_CONFLICT` when the token isn't served.
 * - `GET /api/sites` → `{ sites: [...] }` · `GET /api/sites/:id` → one site. No key hashes.
 */
const sitesRoutes: FastifyPluginAsync = async (app) => {
  const deps = (): SitesDeps => ({
    db: app.db,
    crawlSecret: app.config.SESSION_SECRET,
    allowLocal: app.config.ALLOW_LOCAL_ORIGINS,
    appBaseUrl: app.config.APP_BASE_URL,
  });

  app.post('/api/sites', async (req, reply) => {
    const publisher = requirePublisher(req);
    const body = parse(connectBody, req.body, 'site');
    const result = await connectSite(deps(), publisher.id, body);
    reply.header('cache-control', 'no-store');
    return reply.code(201).send(result);
  });

  app.post<{ Params: { id: string } }>('/api/sites/:id/verify', async (req) => {
    const publisher = requirePublisher(req);
    return verifySite(deps(), publisher.id, req.params.id);
  });

  app.get('/api/sites', async (req) => {
    const publisher = requirePublisher(req);
    return { sites: await listSites(app.db.pool, publisher.id) };
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id', async (req) => {
    const publisher = requirePublisher(req);
    return getSite(app.db.pool, publisher.id, req.params.id);
  });
};

export default sitesRoutes;
