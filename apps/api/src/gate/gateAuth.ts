import type { FastifyRequest } from 'fastify';
import type { Queryable } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { sha256Hex } from '../sites/keys.js';

/**
 * Gate auth (SP-008b; features/14 §Auth boundaries): the publisher's `spigot-gate` sends its
 * gate key as `Authorization: Bearer gk_…`. Only `sites.gate_key_hash` (SHA-256 hex) is stored,
 * so the key is hashed and the site looked up by hash. The site comes **only** from the key: a
 * gate key can never name another site, so site A's key can't read or write site B.
 */

export interface GateSite {
  id: string;
  publisherId: string;
  slug: string | null;
  crawlKeyHash: string;
  policy: Record<string, unknown>;
  policyVersion: number;
}

const BEARER_GATE_KEY = /^Bearer\s+(gk_[A-Za-z0-9_-]{16,200})\s*$/i;

const unauthenticated = () => new ApiError('UNAUTHENTICATED', 'A valid gate key is required.');

/** The site whose gate key is in `authorization`, or `401 UNAUTHENTICATED`. */
export async function authenticateGate(
  q: Queryable,
  authorization: string | undefined,
): Promise<GateSite> {
  const m = BEARER_GATE_KEY.exec(authorization ?? '');
  if (!m) throw unauthenticated();
  const { rows } = await q.query<{
    id: string;
    publisher_id: string;
    slug: string | null;
    crawl_key_hash: string;
    policy: Record<string, unknown>;
    policy_version: number;
  }>(
    `SELECT id, publisher_id, slug, crawl_key_hash, policy, policy_version
       FROM sites WHERE gate_key_hash = $1`,
    [sha256Hex(m[1]!)],
  );
  const r = rows[0];
  if (!r) throw unauthenticated();
  return {
    id: r.id,
    publisherId: r.publisher_id,
    slug: r.slug,
    crawlKeyHash: r.crawl_key_hash,
    policy: r.policy,
    policyVersion: r.policy_version,
  };
}

/** Route `preHandler`: sets `req.gateSite` from the gate key, or answers 401. */
export async function gateOnly(req: FastifyRequest): Promise<void> {
  req.gateSite = await authenticateGate(req.server.db.pool, req.headers.authorization);
}

export function requireGateSite(req: FastifyRequest): GateSite {
  if (!req.gateSite) throw unauthenticated();
  return req.gateSite;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The site authenticated by a gate key (set by `gateOnly`). */
    gateSite?: GateSite;
  }
}
