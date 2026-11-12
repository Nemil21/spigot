import cookie from '@fastify/cookie';
import type { FastifyPluginAsync } from 'fastify';

/** `req.cookies`, `reply.setCookie` / `clearCookie` for the session cookies (SP-007a). */
const cookies: FastifyPluginAsync = async (app) => {
  await app.register(cookie);
};

export default cookies;
