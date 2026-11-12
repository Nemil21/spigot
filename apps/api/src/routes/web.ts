import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, sendError } from '../http/errors.js';

/**
 * Same-origin web app (SP-024a). Serves the built SPA from `apps/web/dist`, so the session cookie,
 * SSE and the API all share one origin.
 *
 *   - Built files are served as-is: hashed `/assets/*` cached for a year, everything else `no-cache`.
 *   - The SPA history fallback (`index.html`) is **only** for `/`, `/app`, `/app/*`, `/buyers`
 *     and `/buyers/*`. Explicit routes, not a not-found handler, so nothing else can ever get
 *     `index.html`: `/c/*` (SP-033), `/v1/*`, `/mcp`, `/api/*`, `/admin/*`, `/webhooks/*` and
 *     `/topups/return` keep their own routes or the api.md JSON 404 (http/errors.ts).
 *   - A file-looking path under a SPA prefix (`/app/logo.png`) is a JSON 404, not `index.html`.
 *
 * Loaded by `@fastify/autoload` over `routes/` (server.ts) with no options; the options are for
 * tests.
 */
export interface WebRoutesOptions {
  /** Directory with the built app. `null` disables static serving (pages answer 503). */
  webDistDir?: string | null;
}

/** `apps/web/dist`, from both `apps/api/src/routes` (tsx) and `apps/api/dist/routes` (node). */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/** The only paths that get the SPA's `index.html`. */
export const SPA_ROUTES = ['/', '/app', '/app/*', '/buyers', '/buyers/*'] as const;

const IMMUTABLE = 'public, max-age=31536000, immutable';

function looksLikeFile(url: string): boolean {
  const last = (url.split('?')[0] ?? '').split('/').pop() ?? '';
  return /\.[a-z0-9]+$/i.test(last);
}

const webRoutes: FastifyPluginAsync<WebRoutesOptions> = async (
  app: FastifyInstance,
  opts: WebRoutesOptions,
) => {
  const distDir = opts.webDistDir === undefined ? DEFAULT_WEB_DIST : opts.webDistDir;
  const hasBuild = distDir !== null && existsSync(join(distDir, 'index.html'));

  if (hasBuild) {
    const assetsDir = join(distDir, 'assets');
    await app.register(fastifyStatic, {
      root: distDir,
      // One route per built file; no catch-all, so unknown paths never reach this plugin.
      wildcard: false,
      index: false,
      cacheControl: false,
      // @fastify/static 10 passes the Fastify reply here (v9 passed the raw response).
      setHeaders(reply, path) {
        reply.header('Cache-Control', path.startsWith(assetsDir) ? IMMUTABLE : 'no-cache');
      },
    });
  } else if (app.config?.NODE_ENV !== 'test') {
    app.log.warn(
      'apps/web/dist not found: the API is running without the web app. Run `npm run build -w @spigot/web`.',
    );
  }

  const page = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '';
    if (looksLikeFile(path)) {
      return sendError(reply, new ApiError('NOT_FOUND', `No file at ${path}.`));
    }
    if (!hasBuild) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The web app is not built. Run `npm run build -w @spigot/web`.');
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  };

  for (const url of SPA_ROUTES) app.get(url, page);
};

export default webRoutes;
