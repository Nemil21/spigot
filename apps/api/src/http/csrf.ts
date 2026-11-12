import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { ApiError } from './errors.js';

/**
 * CSRF (features/14 §Security checklist): SameSite=Lax session cookies plus an `Origin` check on
 * mutating cookie routes. The web app is served from the API's own origin (`APP_BASE_URL`), so a
 * legitimate browser call carries that `Origin`.
 *
 * Checked: POST / PUT / PATCH / DELETE under `/api/` and `/admin/` (the cookie surfaces), unless
 *   - the request authenticates with `Authorization: Bearer …` (gate keys, buyer API keys: a
 *     browser can't attach that header cross-site without a CORS preflight we never grant), or
 *   - the route opts out with `config: { csrf: false }`.
 * Not checked: `/v1`, `/mcp` (Bearer), `/webhooks` (PayPal signature).
 *
 * A checked request must send an `Origin` equal to an allowed origin; a missing or `null` Origin
 * is refused (strict: a non-browser client sets the header itself). `Sec-Fetch-Site: cross-site`
 * is refused whatever the other headers say.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const COOKIE_SURFACES = ['/api/', '/admin/'];

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set `false` on a mutating cookie-surface route that must accept cross-origin calls. */
    csrf?: boolean;
  }
}

/** Allowed origins: `APP_BASE_URL`, plus the API's own localhost origin outside production. */
export function allowedOrigins(config: Config): Set<string> {
  const origins = new Set<string>([new URL(config.APP_BASE_URL).origin]);
  if (config.NODE_ENV !== 'production') {
    origins.add(`http://localhost:${config.PORT}`);
    origins.add(`http://127.0.0.1:${config.PORT}`);
  }
  return origins;
}

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Whether `req` needs the Origin check (mutating, cookie surface, not Bearer, not opted out). */
export function needsCsrfCheck(req: FastifyRequest): boolean {
  if (!MUTATING.has(req.method)) return false;
  const path = req.url.split('?', 1)[0]!;
  if (!COOKIE_SURFACES.some((p) => path.startsWith(p))) return false;
  if (/^Bearer\s/i.test(req.headers.authorization ?? '')) return false;
  return req.routeOptions.config?.csrf !== false;
}

const REFUSED = 'Cross-origin request refused.';

/** Throws `403 FORBIDDEN` unless the request comes from an allowed origin. */
export function assertSameOrigin(config: Config, req: FastifyRequest): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('FORBIDDEN', REFUSED);
  const origin = req.headers.origin;
  const parsed = origin ? originOf(origin) : null;
  if (!parsed || !allowedOrigins(config).has(parsed)) throw new ApiError('FORBIDDEN', REFUSED);
}
