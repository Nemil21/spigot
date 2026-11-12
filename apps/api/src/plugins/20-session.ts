import type { FastifyPluginAsync } from 'fastify';
import { SESSION_COOKIE, verifySession } from '../auth/sessions.js';

/**
 * Resolve the session cookies on every request (SP-007a): `req.publisher` from `spg_pub`,
 * `req.buyer` from `spg_buy`. An invalid or expired cookie is simply no session (routes decide
 * whether that's a 401 via `requirePublisher` / `requireBuyer`). SP-007b's Bearer hook may set
 * `req.buyer` from an API key instead.
 */
const session: FastifyPluginAsync = async (app) => {
  app.decorateRequest('publisher', null);
  app.decorateRequest('buyer', null);
  const secret = app.config.SESSION_SECRET;
  app.addHook('onRequest', async (req) => {
    const cookies = req.cookies ?? {};
    const pub = verifySession(secret, 'publisher', cookies[SESSION_COOKIE.publisher]);
    req.publisher = pub ? { id: pub.sub } : null;
    const buy = verifySession(secret, 'buyer', cookies[SESSION_COOKIE.buyer]);
    req.buyer = buy ? { id: buy.sub, via: 'session' } : null;
  });
};

export default session;
