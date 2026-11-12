import type { FastifyPluginAsync } from 'fastify';
import { assertSameOrigin, needsCsrfCheck } from '../http/csrf.js';

/** CSRF: same-origin `Origin` on mutating cookie routes (SP-007a; rules in http/csrf.ts). */
const csrf: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req) => {
    if (needsCsrfCheck(req)) assertSameOrigin(app.config, req);
  });
};

export default csrf;
