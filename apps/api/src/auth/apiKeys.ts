import { createHash, randomBytes } from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { enforceRate, RATE_LIMITS } from '../http/rateLimit.js';
import { isUuid } from '../tenancy.js';

/**
 * Buyer API keys (SP-007b; api.md §Auth, data-model.md §api_keys, features/14 §Auth).
 *
 * - A key is `sk_spg_` + 32 random bytes in base62 (43 chars). Only its SHA-256 is stored, with
 *   the first 8 chars of the random part as `prefix` for display (`sk_spg_<prefix>…`). The full
 *   key is returned once, by `createKey`.
 * - `authenticateBearer` is the Fastify hook for `/v1` (SP-017b) and `/mcp` (SP-022a): it looks the
 *   key up on **every** request (no cache), so a revoked key is `401 KEY_REVOKED` on the very next
 *   request after the revoke commits. It sets `req.buyer` (`via: 'apiKey'`) and `req.apiKey`.
 * - `requireScope('topup')` guards routes that need a scope (`403 FORBIDDEN` without it).
 * - `apiKeyRateLimit('rest' | 'mcp')` applies SP-007a's limiter per key, honouring the key's
 *   `rate_limit_per_min`.
 */

export const API_KEY_PREFIX = 'sk_spg_';
export const API_KEY_SCOPES = ['read', 'topup'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** `last_used_at` is written at most once per this interval per key. */
export const LAST_USED_THROTTLE_MS = 60_000;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** ceil(256 / log2(62)): every 32-byte value fits, so keys have a fixed length. */
const BODY_LENGTH = 43;
const KEY_SHAPE = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{${BODY_LENGTH}}$`);

/** The key the buyer authenticates with, on `req.apiKey` after `authenticateBearer`. */
export interface ApiKeyPrincipal {
  id: string;
  buyerId: string;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticateBearer` (SP-007b); null on cookie and anonymous requests. */
    apiKey: ApiKeyPrincipal | null;
  }
}

/** Base62 of `bytes` as one big number, left-padded to `length`. */
export function base62(bytes: Buffer, length = BODY_LENGTH): string {
  let n = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)]! + out;
    n /= 62n;
  }
  return out.padStart(length, '0');
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** A fresh key and what is stored for it. */
export function generateKey(): { key: string; prefix: string; keyHash: string } {
  const body = base62(randomBytes(32));
  const key = `${API_KEY_PREFIX}${body}`;
  return { key, prefix: body.slice(0, 8), keyHash: hashKey(key) };
}

export const createKeyBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1)
    .max(API_KEY_SCOPES.length)
    .refine((s) => new Set(s).size === s.length, 'Scopes must not repeat.')
    .default(['read']),
});

export type CreateKeyInput = z.input<typeof createKeyBody> & {
  /** Seed / ops only (SP-035); the portal route never accepts it. Default 60 (the column default). */
  rateLimitPerMin?: number;
};

/** What the portal shows for a key: never the hash, never the key itself. */
export interface ApiKeySummary {
  id: string;
  name: string | null;
  /** First 8 chars after `sk_spg_`; display as `sk_spg_<prefix>…`. */
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMin: number;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const SUMMARY = `id, name, prefix, scopes, rate_limit_per_min AS "rateLimitPerMin",
  last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt"`;

/** Create a key for `buyerId`. The returned `key` is the only time it exists in clear. */
export async function createKey(
  q: Queryable,
  buyerId: string,
  input: CreateKeyInput = {},
): Promise<ApiKeySummary & { key: string }> {
  const { name, scopes } = createKeyBody.parse(input);
  const { key, prefix, keyHash } = generateKey();
  const { rows } = await q.query<ApiKeySummary>(
    `INSERT INTO api_keys (buyer_id, name, prefix, key_hash, scopes, rate_limit_per_min)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 60))
     RETURNING ${SUMMARY}`,
    [buyerId, name ?? null, prefix, keyHash, scopes, input.rateLimitPerMin ?? null],
  );
  return { ...rows[0]!, key };
}

/** The buyer's keys, newest first, revoked ones included (with `revokedAt`). */
export async function listKeys(q: Queryable, buyerId: string): Promise<ApiKeySummary[]> {
  const { rows } = await q.query<ApiKeySummary>(
    `SELECT ${SUMMARY} FROM api_keys WHERE buyer_id = $1 ORDER BY created_at DESC, id`,
    [buyerId],
  );
  return rows;
}

/**
 * Revoke one of the buyer's keys. Takes effect for every request that starts after this commits.
 * Revoking an already revoked key keeps the first `revoked_at`. Another buyer's key, an unknown
 * id or a non-uuid → `404 NOT_FOUND` (other tenants' ids are never confirmed to exist).
 */
export async function revokeKey(
  q: Queryable,
  buyerId: string,
  keyId: string,
): Promise<ApiKeySummary> {
  if (!isUuid(keyId)) throw keyNotFound();
  const { rows } = await q.query<ApiKeySummary>(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE id = $1 AND buyer_id = $2
      RETURNING ${SUMMARY}`,
    [keyId, buyerId],
  );
  if (!rows[0]) throw keyNotFound();
  return rows[0];
}

function keyNotFound(): ApiError {
  return new ApiError('NOT_FOUND', 'No such API key.');
}

interface KeyRow extends ApiKeyPrincipal {
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

const UNAUTHENTICATED = 'Send your Spigot API key as "Authorization: Bearer sk_spg_…".';

/** The key from `Authorization: Bearer sk_spg_…`, or null. */
function bearerKey(req: FastifyRequest): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1]! : null;
}

/**
 * Resolve a key to its principal: unknown or malformed → `401 UNAUTHENTICATED`, revoked →
 * `401 KEY_REVOKED`. Reads the row every time (no cache). Bumps `last_used_at` when it is more
 * than a minute old; the conditional UPDATE keeps concurrent requests to one write.
 */
export async function authenticateKey(q: Queryable, key: string | null): Promise<ApiKeyPrincipal> {
  if (!key || !KEY_SHAPE.test(key)) throw new ApiError('UNAUTHENTICATED', UNAUTHENTICATED);
  const { rows } = await q.query<KeyRow>(
    `SELECT id, buyer_id AS "buyerId", scopes, rate_limit_per_min AS "rateLimitPerMin",
            revoked_at AS "revokedAt", last_used_at AS "lastUsedAt"
       FROM api_keys WHERE key_hash = $1`,
    [hashKey(key)],
  );
  const row = rows[0];
  if (!row) throw new ApiError('UNAUTHENTICATED', UNAUTHENTICATED);
  if (row.revokedAt) throw new ApiError('KEY_REVOKED', 'This API key has been revoked.');
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
    await q.query(
      `UPDATE api_keys SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 minute')`,
      [row.id],
    );
  }
  return {
    id: row.id,
    buyerId: row.buyerId,
    scopes: row.scopes,
    rateLimitPerMin: row.rateLimitPerMin,
  };
}

/**
 * Fastify hook for API-key routes (`/v1`, `/mcp`). Add it inside your encapsulated route file:
 *
 *   app.addHook('onRequest', authenticateBearer);
 *   app.post('/v1/topups', { preHandler: requireScope('topup') }, …);
 *
 * Every request must carry a valid key; a portal session cookie doesn't count (it is replaced).
 */
export const authenticateBearer: onRequestAsyncHookHandler = async function authenticateBearer(
  req: FastifyRequest,
  _reply: FastifyReply,
) {
  const principal = await authenticateKey(req.server.db.pool, bearerKey(req));
  req.apiKey = principal;
  req.buyer = { id: principal.buyerId, via: 'apiKey' };
};

/** The request's API key, or `401 UNAUTHENTICATED` (route not behind `authenticateBearer`). */
export function requireApiKey(req: FastifyRequest): ApiKeyPrincipal {
  if (!req.apiKey) throw new ApiError('UNAUTHENTICATED', UNAUTHENTICATED);
  return req.apiKey;
}

/** `preHandler`: the API key must have `scope`, else `403 FORBIDDEN`. */
export function requireScope(scope: ApiKeyScope): preHandlerAsyncHookHandler {
  return async function requireScopePreHandler(req) {
    const key = requireApiKey(req);
    if (!key.scopes.includes(scope)) {
      throw new ApiError('FORBIDDEN', `This API key lacks the "${scope}" scope.`, {
        requiredScope: scope,
      });
    }
  };
}

/**
 * `preHandler`: per-key rate limit with SP-007a's limiter. REST uses the key's
 * `rate_limit_per_min` (default 60); MCP uses the same, capped at the MCP limit (30/min).
 */
export function apiKeyRateLimit(bucket: 'rest' | 'mcp'): preHandlerAsyncHookHandler {
  return async function apiKeyRateLimitPreHandler(req, reply) {
    const key = requireApiKey(req);
    const perMin =
      bucket === 'mcp'
        ? Math.min(key.rateLimitPerMin, RATE_LIMITS.mcp.capacity)
        : key.rateLimitPerMin;
    enforceRate(reply, req.server.rateLimiter.take(bucket, key.id, perMin));
  };
}
