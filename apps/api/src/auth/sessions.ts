import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';

/**
 * Session cookies (features/14 §Auth). Stateless, signed tokens: `payload.signature`, both
 * base64url, HMAC-SHA256 under a key derived from `SESSION_SECRET` per role, so a buyer token can
 * never pass as a publisher token. The payload is readable, so it carries ids only, never an
 * email. Logout clears the cookie; a copied token stays valid until it expires (12 h / 30 days):
 * there is no sessions table in SP-002's schema.
 *
 * Cookies: HttpOnly, SameSite=Lax, Path=/, `Secure` when the app is served over HTTPS or in
 * production (local HTTP dev and tests can't round-trip a Secure cookie).
 */

export type SessionRole = 'publisher' | 'buyer';

export const SESSION_COOKIE: Record<SessionRole, string> = {
  publisher: 'spg_pub',
  buyer: 'spg_buy',
};

export const SESSION_TTL_MS: Record<SessionRole, number> = {
  publisher: 12 * 60 * 60 * 1000,
  buyer: 30 * 24 * 60 * 60 * 1000,
};

export interface SessionClaims {
  /** publishers.id / buyers.id */
  sub: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Random per-token id. */
  jti: string;
}

/** The signed-in publisher, from the `spg_pub` cookie (plugins/20-session.ts). */
export interface PublisherPrincipal {
  id: string;
}

/**
 * The buyer making the request: from the `spg_buy` cookie here, or from a Bearer API key in
 * SP-007b (`via: 'apiKey'`, which also sets `req.apiKey`).
 */
export interface BuyerPrincipal {
  id: string;
  via: 'session' | 'apiKey';
}

declare module 'fastify' {
  interface FastifyRequest {
    publisher: PublisherPrincipal | null;
    buyer: BuyerPrincipal | null;
  }
}

function keyFor(secret: string, role: SessionRole): Buffer {
  return createHmac('sha256', secret).update(`spigot:session:${role}`).digest();
}

function mac(secret: string, role: SessionRole, body: string): Buffer {
  return createHmac('sha256', keyFor(secret, role)).update(body).digest();
}

export function signSession(
  secret: string,
  role: SessionRole,
  sub: string,
  now: number = Date.now(),
): string {
  const claims: SessionClaims = {
    sub,
    exp: now + SESSION_TTL_MS[role],
    jti: randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${mac(secret, role, body).toString('base64url')}`;
}

/** The claims, or null when the token is missing, malformed, forged, for the other role or expired. */
export function verifySession(
  secret: string,
  role: SessionRole,
  token: string | undefined,
  now: number = Date.now(),
): SessionClaims | null {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = mac(secret, role, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let c: Partial<SessionClaims>;
  try {
    c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionClaims>;
  } catch {
    return null;
  }
  if (typeof c.sub !== 'string' || typeof c.exp !== 'number' || typeof c.jti !== 'string') {
    return null;
  }
  return c.exp > now ? (c as SessionClaims) : null;
}

export function secureCookies(config: Config): boolean {
  return config.NODE_ENV === 'production' || config.APP_BASE_URL.startsWith('https:');
}

/** Sign in: set the role's session cookie for `sub`. */
export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  role: SessionRole,
  sub: string,
): void {
  reply.setCookie(SESSION_COOKIE[role], signSession(config.SESSION_SECRET, role, sub), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(config),
    maxAge: Math.floor(SESSION_TTL_MS[role] / 1000),
  });
}

/** Sign out: expire the role's session cookie. */
export function clearSessionCookie(reply: FastifyReply, config: Config, role: SessionRole): void {
  reply.clearCookie(SESSION_COOKIE[role], {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(config),
  });
}
