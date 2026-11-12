import type { FastifyPluginAsync } from 'fastify';
import { createKey, createKeyBody, listKeys, revokeKey } from '../auth/apiKeys.js';
import { requireBuyerSession } from '../auth/buyerAuth.js';
import { parse } from '../http/errors.js';

/**
 * Buyer API keys in the portal (api.md §Buyer portal endpoints; SP-007b). Session cookie only: an
 * API key can't mint or revoke keys.
 * - `POST /api/buyer/keys` `{ name?, scopes?: ["read","topup"] }` (default `["read"]`) →
 *   `201 { id, key, name, prefix, scopes, … }`. `key` is shown once and never stored in clear.
 * - `GET /api/buyer/keys` → `{ keys: [{ id, name, prefix, scopes, lastUsedAt, revokedAt, … }] }`.
 * - `DELETE /api/buyer/keys/:id` → `{ key }` with `revokedAt`; the next Bearer request with it is
 *   `401 KEY_REVOKED`. Another buyer's key → 404.
 */
const buyerKeysRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/buyer/keys', async (req, reply) => {
    const buyer = requireBuyerSession(req);
    const body = parse(createKeyBody, req.body ?? {}, 'API key');
    const created = await createKey(app.db.pool, buyer.id, body);
    return reply.code(201).header('Cache-Control', 'no-store').send(created);
  });

  app.get('/api/buyer/keys', async (req) => {
    const buyer = requireBuyerSession(req);
    return { keys: await listKeys(app.db.pool, buyer.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/buyer/keys/:id', async (req) => {
    const buyer = requireBuyerSession(req);
    return { key: await revokeKey(app.db.pool, buyer.id, req.params.id) };
  });
};

export default buyerKeysRoutes;
