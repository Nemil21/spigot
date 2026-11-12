import type { FastifyPluginAsync } from 'fastify';
import { requirePublisher } from '../auth/publisherAuth.js';
import { parse } from '../http/errors.js';
import {
  policyPatchBody,
  publisherPatchBody,
  rotateBody,
  rotateSiteKey,
  updatePublisher,
  updateSitePolicy,
} from '../settings/settings.js';

/**
 * W16 Settings (SP-034; screens.md §W16). Publisher session only; another publisher's site is a
 * 404 (tenancy.ts).
 * - `PATCH /api/publishers/me` `{ name?, payoutEmail? }` → the account (as `GET /api/auth/me`).
 *   A new payout email applies to the next payout batch; a built batch keeps its snapshot.
 * - `PATCH /api/sites/:id/policy` `{ decisions?: { AI_AGENT: "PASS", … }, gatedPaths?: [regex] }`
 *   → `{ siteId, decisions, gatedPaths, policyVersion }`. Bad regexes → `400 VALIDATION_ERROR`
 *   with `details.issues[].path` like `gatedPaths.2`.
 * - `POST /api/sites/:id/keys/rotate` `{ kind: "gate" | "crawl" }` → `{ siteId, kind, key, envVar,
 *   policyVersion }`, the new key shown once (`Cache-Control: no-store`).
 */
const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.patch('/api/publishers/me', async (req) => {
    const publisher = requirePublisher(req);
    const body = parse(publisherPatchBody, req.body, 'account settings');
    return updatePublisher(app.db, publisher.id, body);
  });

  app.patch<{ Params: { id: string } }>('/api/sites/:id/policy', async (req) => {
    const publisher = requirePublisher(req);
    const body = parse(policyPatchBody, req.body, 'gate policy');
    return updateSitePolicy(app.db, publisher.id, req.params.id, body);
  });

  app.post<{ Params: { id: string } }>('/api/sites/:id/keys/rotate', async (req, reply) => {
    const publisher = requirePublisher(req);
    const body = parse(rotateBody, req.body, 'key rotation');
    const rotated = await rotateSiteKey(
      app.db,
      app.config.SESSION_SECRET,
      publisher.id,
      req.params.id,
      body.kind,
    );
    reply.header('cache-control', 'no-store');
    return rotated;
  });
};

export default settingsRoutes;
