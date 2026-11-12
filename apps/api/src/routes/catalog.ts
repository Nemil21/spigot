import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, sendError } from '../http/errors.js';
import { rateLimit } from '../http/rateLimit.js';
import { catalog } from '../services/catalog.js';
import { loadCatalogPage } from '../services/catalogPage.js';
import { links402 } from '../services/payment402.js';
import {
  catalogPageLinks,
  renderCatalogNotFound,
  renderCatalogPage,
} from '../views/catalog.html.js';
import { renderTermsPage } from '../views/terms.html.js';

/**
 * W13 public catalog (screens.md §W13, features/16 §Catalog page; SP-033). Where every 402 points
 * (the gate's and the data API's `Link: rel="payment"` and `terms`). Public: no login, no key.
 *
 * - `GET /c/:site`: server-rendered HTML; with `Accept: application/json` (preferred over HTML)
 *   the catalog JSON instead, `catalog()` narrowed to this site (same shape as `/v1/catalog`).
 * - `GET /c/:site/terms`: the data terms (the 402 body's `terms`, the schema's `license`).
 * - Unknown site → 404 (a small page, or the api.md error envelope for JSON).
 *
 * Per-IP rate limit on the shared `portal` bucket (120/min): public, unauthenticated, DB-backed.
 * No tenant-scoped data, so no tenancy case: everything here is what a 402 already discloses.
 */

const HTML = 'text/html; charset=utf-8';

/**
 * The `Accept` range that best matches `type` (exact 2 > `type/*` 1 > `*\/*` 0) and its q-value;
 * `spec` -1 and q 0 when nothing matches.
 */
function match(accept: string, type: string): { spec: number; q: number } {
  const [major] = type.split('/');
  let best = -1;
  let q = 0;
  for (const part of accept.split(',')) {
    const [range = '', ...params] = part.trim().toLowerCase().split(';');
    const spec = range === type ? 2 : range === `${major}/*` ? 1 : range === '*/*' ? 0 : -1;
    if (spec < 0) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const parsed = qp ? Number(qp.slice(2)) : 1;
    const value = Number.isFinite(parsed) ? parsed : 0;
    if (spec > best) {
      best = spec;
      q = value;
    } else if (spec === best && value > q) {
      q = value;
    }
  }
  return { spec: best, q };
}

/**
 * JSON only when the client asks for it over HTML: a higher q, or the same q from a more specific
 * range (`application/json, *\/*`). curl's default `*\/*` and browsers get HTML.
 */
export function wantsJson(accept: string | undefined): boolean {
  if (!accept) return false;
  const json = match(accept, 'application/json');
  const html = match(accept, 'text/html');
  if (json.q <= 0) return false;
  return json.q > html.q || (json.q === html.q && json.spec > html.spec);
}

const catalogRoutes: FastifyPluginAsync = async (app) => {
  const baseUrl = app.config.APP_BASE_URL;
  const limit = rateLimit('portal', (req) => `catalog:${req.ip}`);

  const notFound = (req: FastifyRequest, reply: FastifyReply, site: string) =>
    wantsJson(req.headers.accept)
      ? sendError(reply, new ApiError('NOT_FOUND', 'No such site.'))
      : reply.code(404).type(HTML).send(renderCatalogNotFound(site));

  app.get<{ Params: { site: string } }>('/c/:site', { preHandler: limit }, async (req, reply) => {
    const db = app.db.pool;
    const site = await loadCatalogPage(db, req.params.site);
    reply.header('Vary', 'Accept').header('Cache-Control', 'no-cache');
    if (!site) return notFound(req, reply, req.params.site);
    if (wantsJson(req.headers.accept)) return catalog(db, { site: site.slug });
    const links = catalogPageLinks(links402(baseUrl, site.slug));
    return reply.type(HTML).send(renderCatalogPage(site, links));
  });

  app.get<{ Params: { site: string } }>(
    '/c/:site/terms',
    { preHandler: limit },
    async (req, reply) => {
      const site = await loadCatalogPage(app.db.pool, req.params.site);
      reply.header('Vary', 'Accept').header('Cache-Control', 'no-cache');
      if (!site) return notFound(req, reply, req.params.site);
      const links = catalogPageLinks(links402(baseUrl, site.slug));
      return reply.type(HTML).send(renderTermsPage(site, links));
    },
  );
};

export default catalogRoutes;
