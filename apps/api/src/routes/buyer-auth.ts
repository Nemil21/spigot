import type { FastifyPluginAsync } from 'fastify';
import {
  buyerSignupBody,
  getBuyer,
  loginBuyer,
  requireBuyerSession,
  signupBuyer,
} from '../auth/buyerAuth.js';
import { loginBody } from '../auth/credentials.js';
import { clearSessionCookie, setSessionCookie } from '../auth/sessions.js';
import { ApiError, parse } from '../http/errors.js';
import { rateLimit } from '../http/rateLimit.js';

/**
 * Buyer portal auth (api.md §Buyer portal endpoints; SP-007a). Same as publishers, with its own
 * 30-day cookie (`spg_buy`):
 * - `POST /api/buyer/signup` `{ name, email, password }` → `201 { buyerId }`, signed in.
 * - `POST /api/buyer/login` → `{ buyerId }` · `POST /api/buyer/logout` → 204.
 * - `GET /api/buyer/me` → the signed-in buyer.
 */
const byIp = rateLimit('auth', (req) => req.ip);

const buyerAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/buyer/signup', { preHandler: byIp }, async (req, reply) => {
    const body = parse(buyerSignupBody, req.body, 'signup');
    const buyer = await signupBuyer(app.db.pool, body);
    setSessionCookie(reply, app.config, 'buyer', buyer.id);
    return reply.code(201).send({ buyerId: buyer.id });
  });

  app.post('/api/buyer/login', { preHandler: byIp }, async (req, reply) => {
    const body = parse(loginBody, req.body, 'login');
    const buyer = await loginBuyer(app.db.pool, body);
    setSessionCookie(reply, app.config, 'buyer', buyer.id);
    return { buyerId: buyer.id };
  });

  app.post('/api/buyer/logout', async (_req, reply) => {
    clearSessionCookie(reply, app.config, 'buyer');
    return reply.code(204).send();
  });

  app.get('/api/buyer/me', async (req) => {
    const buyer = await getBuyer(app.db.pool, requireBuyerSession(req).id);
    if (!buyer) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
    return { id: buyer.id, name: buyer.name, email: buyer.email };
  });
};

export default buyerAuthRoutes;
