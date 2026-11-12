import type { FastifyPluginAsync } from 'fastify';
import { isAdmin } from '../auth/admin.js';
import { getBuyer } from '../auth/buyerAuth.js';
import { loginBody } from '../auth/credentials.js';
import {
  getPublisher,
  loginPublisher,
  publisherSignupBody,
  signupPublisher,
} from '../auth/publisherAuth.js';
import { clearSessionCookie, setSessionCookie } from '../auth/sessions.js';
import { ApiError, parse } from '../http/errors.js';
import { rateLimit } from '../http/rateLimit.js';

/**
 * Publisher auth (api.md §Publisher endpoints; SP-007a):
 * - `POST /api/auth/signup` `{ name, email, password, payoutEmail }` → `201 { publisherId }`, signed in.
 * - `POST /api/auth/login` `{ email, password }` → `{ publisherId }`, signed in; else 401.
 * - `POST /api/auth/logout` → 204, cookie cleared.
 * - `GET /api/auth/me` → who is signed in, as a publisher and / or a buyer; 401 if nobody.
 */
const byIp = rateLimit('auth', (req) => req.ip);

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/auth/signup', { preHandler: byIp }, async (req, reply) => {
    const body = parse(publisherSignupBody, req.body, 'signup');
    const publisher = await signupPublisher(app.db.pool, body);
    setSessionCookie(reply, app.config, 'publisher', publisher.id);
    return reply.code(201).send({ publisherId: publisher.id });
  });

  app.post('/api/auth/login', { preHandler: byIp }, async (req, reply) => {
    const body = parse(loginBody, req.body, 'login');
    const publisher = await loginPublisher(app.db.pool, body);
    setSessionCookie(reply, app.config, 'publisher', publisher.id);
    return { publisherId: publisher.id };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply, app.config, 'publisher');
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    const [publisher, buyer] = await Promise.all([
      req.publisher ? getPublisher(app.db.pool, req.publisher.id) : null,
      req.buyer?.via === 'session' ? getBuyer(app.db.pool, req.buyer.id) : null,
    ]);
    if (!publisher && !buyer) throw new ApiError('UNAUTHENTICATED', 'Sign in to continue.');
    return {
      publisher: publisher && {
        id: publisher.id,
        name: publisher.name,
        email: publisher.email,
        payoutEmail: publisher.payoutEmail,
        isDemo: publisher.isDemo,
      },
      buyer: buyer && { id: buyer.id, name: buyer.name, email: buyer.email },
      isAdmin: !!publisher && isAdmin(req, publisher.email),
    };
  });
};

export default authRoutes;
