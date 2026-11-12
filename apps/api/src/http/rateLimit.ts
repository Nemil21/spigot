import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { ApiError } from './errors.js';

/**
 * One shared in-memory rate limiter (SP-007a; features/14 §Security checklist): a token bucket
 * per `(bucket, key)`. A bucket holds `capacity` tokens and refills continuously at
 * `capacity / perMs`; a call takes one token, and a call with no token left is refused with
 * `429 RATE_LIMITED` and `Retry-After`.
 *
 * In-memory is correct only with **one API instance** (the hackathon deploy). Several instances
 * would need a shared store behind the same interface.
 */

export interface BucketSpec {
  /** Burst size, and the number of calls allowed per `perMs` at steady state. */
  capacity: number;
  perMs: number;
}

export const RATE_LIMITS = {
  /** Publisher API (and the buyer portal), per signed-in user: 120/min. Applied in plugins/40-rate-limit.ts. */
  portal: { capacity: 120, perMs: 60_000 },
  /** Buyer data API `/v1`, per API key: 60/min (SP-017b; SP-007b's `rate_limit_per_min` overrides). */
  rest: { capacity: 60, perMs: 60_000 },
  /** MCP, per API key: 30/min (SP-022a). */
  mcp: { capacity: 30, perMs: 60_000 },
  /** Gate hit batches, per site: 1 post / 5 s (SP-008b). */
  gateHits: { capacity: 1, perMs: 5_000 },
  /** Gate ping, per site: 1 / 10 s (SP-055). */
  ping: { capacity: 1, perMs: 10_000 },
  /** Login and signup, per client IP: 20/min (password guessing). */
  auth: { capacity: 20, perMs: 60_000 },
} as const satisfies Record<string, BucketSpec>;

export type RateBucket = keyof typeof RATE_LIMITS;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Whole seconds until one token is back (0 when allowed). */
  retryAfterSec: number;
}

interface BucketState {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private lastSweep = 0;

  constructor(
    private readonly limits: Record<RateBucket, BucketSpec> = RATE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Take one token for `key` in `bucket`. `perMin` (e.g. an API key's `rate_limit_per_min`)
   * replaces the bucket's capacity, keeping a one-minute window.
   */
  take(bucket: RateBucket, key: string, perMin?: number): RateDecision {
    const t = this.now();
    this.sweep(t);
    const spec = this.specFor(bucket, perMin);
    const id = `${bucket}:${key}`;
    const state = this.refilled(this.buckets.get(id), spec, t);
    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.buckets.set(id, state);
      return {
        allowed: true,
        limit: spec.capacity,
        remaining: Math.floor(state.tokens),
        retryAfterSec: 0,
      };
    }
    this.buckets.set(id, state);
    const msPerToken = spec.perMs / spec.capacity;
    const retryAfterSec = Math.max(1, Math.ceil(((1 - state.tokens) * msPerToken) / 1000));
    return { allowed: false, limit: spec.capacity, remaining: 0, retryAfterSec };
  }

  /** For tests. */
  reset(): void {
    this.buckets.clear();
  }

  private specFor(bucket: RateBucket, perMin?: number): BucketSpec {
    if (perMin !== undefined && Number.isFinite(perMin) && perMin >= 1) {
      return { capacity: Math.floor(perMin), perMs: 60_000 };
    }
    return this.limits[bucket];
  }

  private refilled(state: BucketState | undefined, spec: BucketSpec, t: number): BucketState {
    if (!state) return { tokens: spec.capacity, at: t };
    const elapsed = Math.max(0, t - state.at);
    const tokens = Math.min(spec.capacity, state.tokens + (elapsed * spec.capacity) / spec.perMs);
    return { tokens, at: t };
  }

  /** Drop buckets idle for over a minute (refilled long since), so the map stays small. */
  private sweep(t: number): void {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [id, state] of this.buckets) {
      const bucket = id.slice(0, id.indexOf(':')) as RateBucket;
      const perMs = this.limits[bucket]?.perMs ?? 60_000;
      if (t - state.at > Math.max(perMs, 60_000)) this.buckets.delete(id);
    }
  }
}

/** Set the RateLimit headers; throw `429 RATE_LIMITED` with `Retry-After` when refused. */
export function enforceRate(reply: FastifyReply, d: RateDecision): void {
  reply.header('RateLimit-Limit', d.limit);
  reply.header('RateLimit-Remaining', d.remaining);
  if (d.allowed) return;
  throw new ApiError(
    'RATE_LIMITED',
    'Too many requests. Please wait a moment and try again.',
    { retryAfterSec: d.retryAfterSec },
    { 'Retry-After': d.retryAfterSec },
  );
}

/**
 * A route `preHandler` that limits by `keyOf(req)` in `bucket`, using the app's shared limiter
 * (`app.rateLimiter`, plugins/40-rate-limit.ts). `keyOf` returning null skips the limit.
 *
 *   app.post('/api/gate/hits', { preHandler: rateLimit('gateHits', (req) => req.site?.id) }, …)
 */
export function rateLimit(
  bucket: RateBucket,
  keyOf: (req: FastifyRequest) => string | null | undefined,
  perMinOf?: (req: FastifyRequest) => number | undefined,
): preHandlerAsyncHookHandler {
  return async function rateLimitPreHandler(req, reply) {
    const key = keyOf(req);
    if (!key) return;
    enforceRate(reply, req.server.rateLimiter.take(bucket, key, perMinOf?.(req)));
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The process-wide limiter (SP-007a). */
    rateLimiter: RateLimiter;
  }
}
