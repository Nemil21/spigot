import type { FastifyPluginAsync } from 'fastify';
import { gateHitsSchema } from '@spigot/shared';
import { requirePublisher } from '../auth/publisherAuth.js';
import { gateOnly, requireGateSite } from '../gate/gateAuth.js';
import { GATE_HITS_BODY_LIMIT, recordHits } from '../gate/hits.js';
import { buildGatePolicy } from '../gate/policy.js';
import { parse } from '../http/errors.js';
import { rateLimit } from '../http/rateLimit.js';
import { forPublisher } from '../tenancy.js';

/**
 * Gate endpoints (api.md §Gate endpoints; SP-008b). Called by `spigot-gate` in the background,
 * never on a request path; authenticated by the site's gate key (`Bearer gk_…`), which alone
 * picks the site.
 * - `GET /api/gate/policy` → the policy; `ETag` = `"<policyVersion>"`, `If-None-Match` → `304`.
 * - `POST /api/gate/hits` → `204`. 1 post / 5 s / site (`429 RATE_LIMITED`), body ≤ 1 MB.
 *
 * And for W03 (publisher session): `GET /api/sites/:id/gate-status` →
 * `{ installed, lastSeenAt, policyVersion }`; `installed` = a hit post in the last 10 minutes.
 */

/** How recent the last hit post must be for the gate to count as installed. */
export const GATE_INSTALLED_WINDOW_MINUTES = 10;

const etagOf = (version: number) => `"${version}"`;

function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === etag || t === '*');
}

const gateRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/gate/policy', { preHandler: gateOnly }, async (req, reply) => {
    const site = requireGateSite(req);
    const etag = etagOf(site.policyVersion);
    reply.header('etag', etag).header('cache-control', 'no-cache');
    // SP-034: the gate now holds this version (served now, or a 304 for the one it has), so the
    // crawler may switch to a rotated crawl key whose hash it carries (crawl/crawlKey.ts).
    await app.db.pool.query(
      `UPDATE sites SET gate_policy_version_seen = $2
        WHERE id = $1 AND (gate_policy_version_seen IS NULL OR gate_policy_version_seen < $2)`,
      [site.id, site.policyVersion],
    );
    if (matchesEtag(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return buildGatePolicy(app.db.pool, { appBaseUrl: app.config.APP_BASE_URL }, site);
  });

  app.post(
    '/api/gate/hits',
    {
      bodyLimit: GATE_HITS_BODY_LIMIT,
      // Gate-key auth only, never a cookie: CSRF doesn't apply, and a keyless post gets a 401.
      config: { csrf: false },
      preHandler: [gateOnly, rateLimit('gateHits', (req) => req.gateSite?.id)],
    },
    async (req, reply) => {
      const site = requireGateSite(req);
      const body = parse(gateHitsSchema, req.body, 'hit counts');
      await recordHits(app.db, site, body);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>('/api/sites/:id/gate-status', async (req) => {
    const publisher = requirePublisher(req);
    const row = await forPublisher(publisher.id).get<{
      installed: boolean;
      last_gate_seen_at: Date | null;
      policy_version: number;
    }>(app.db.pool, 'sites', req.params.id, {
      columns: `t.last_gate_seen_at IS NOT NULL
                  AND t.last_gate_seen_at > now() - interval '${GATE_INSTALLED_WINDOW_MINUTES} minutes'
                  AS installed,
                t.last_gate_seen_at, t.policy_version`,
    });
    return {
      installed: row.installed,
      lastSeenAt: row.last_gate_seen_at ? row.last_gate_seen_at.toISOString() : null,
      policyVersion: row.policy_version,
    };
  });
};

export default gateRoutes;
