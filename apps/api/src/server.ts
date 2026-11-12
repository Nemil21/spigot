import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import autoload from '@fastify/autoload';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { registerErrorHandler } from './http/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export const PLUGINS_DIR = fileURLToPath(new URL('./plugins', import.meta.url));
export const ROUTES_DIR = fileURLToPath(new URL('./routes', import.meta.url));

/** Test files and type declarations next to route files are never loaded as routes. */
const NOT_A_ROUTE = /\.test\.[cm]?[jt]s$|\.d\.[cm]?ts$/;

export interface BuildServerOptions {
  /** Directory of app-wide plugins (hooks, decorators). Tests point this at a fixture directory. */
  pluginsDir?: string;
  /** Directory of route plugins. Tests point this at a fixture directory. */
  routesDir?: string;
  logger?: boolean;
}

/**
 * Build the Fastify app. Nothing feature-specific is registered here (the hot-spot rule: add a
 * file, never edit server.ts):
 * - `plugins/*.ts`: app-wide hooks and decorators (cookies, auth, CSRF, rate limits), loaded
 *   first and not encapsulated, so they apply to every route.
 * - `routes/*.ts`: one encapsulated Fastify plugin per file.
 */
export async function buildServer(
  config: Config,
  opts: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    // Render terminates TLS one hop in front: trust exactly that hop in production and none
    // elsewhere, so a client-sent X-Forwarded-For can't spoof req.ip (rate limits, gate, logs).
    trustProxy:
      config.NODE_ENV === 'production' ? (_addr: string, hop: number) => hop === 0 : false,
  });
  app.decorate('config', config);
  registerErrorHandler(app);
  // tsc emits no folder for a directory with no .ts files yet (e.g. plugins/ before SP-007a).
  const pluginsDir = opts.pluginsDir ?? PLUGINS_DIR;
  if (existsSync(pluginsDir)) {
    await app.register(autoload, {
      dir: pluginsDir,
      ignoreFilter: NOT_A_ROUTE,
      encapsulate: false,
    });
  }
  await app.register(autoload, {
    dir: opts.routesDir ?? ROUTES_DIR,
    ignoreFilter: NOT_A_ROUTE,
    // Route files declare their own paths (or `export const autoPrefix`); folders add nothing.
    dirNameRoutePrefix: false,
    encapsulate: true,
  });
  return app;
}
