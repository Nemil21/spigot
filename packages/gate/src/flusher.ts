// Hit flusher (features/02 §Hit counting): in-memory counters keyed (minute, category, botName,
// decision, isSimulated), posted to `POST {apiBase}/api/gate/hits` every 10 s, fire-and-forget
// with a 2 s timeout. A batch is dropped after 3 failed tries; memory is capped at 10k keys.
// The payload mirrors `gateHitsSchema` in `@spigot/shared/gate` (flusher.test.ts checks it).

import type { Category } from './policy.js';
import {
  GATE_TIMEOUT_MS,
  consoleLogger,
  gateUrl,
  type FetchLike,
  type GateLogger,
} from './refresher.js';

export type HitDecision = 'PASS' | 'QUOTE_402' | 'FAIL_OPEN' | 'SPIGOT_CRAWLER';

export interface HitBucket {
  /** Start of the UTC minute, e.g. `2026-11-11T17:42:00Z`. */
  bucket: string;
  category: Category;
  botName: string;
  decision: HitDecision;
  hits: number;
  bytes: number;
  isSimulated: boolean;
}

export interface HitsPayload {
  sentAt: string;
  buckets: HitBucket[];
}

export interface HitInput {
  category: Category;
  botName: string;
  decision: HitDecision;
  bytes: number;
  isSimulated: boolean;
  /** Request time in ms; defaults to now. */
  at?: number;
}

export interface FlusherOptions {
  apiBase: string;
  gateKey: string;
  intervalMs?: number;
  timeoutMs?: number;
  maxKeys?: number;
  maxTries?: number;
  fetch?: FetchLike;
  logger?: GateLogger;
  now?: () => number;
}

export interface HitFlusher {
  add(hit: HitInput): void;
  /** Distinct keys held in memory (live counters plus a batch awaiting retry). */
  readonly size: number;
  /** Hits dropped because the key cap was reached, since start. */
  readonly droppedHits: number;
  /** Post one batch now. Never rejects. */
  flush(): Promise<void>;
  stop(): void;
}

export const FLUSH_INTERVAL_MS = 10_000;
/** Same cap as `MAX_HIT_BUCKETS` in `@spigot/shared/gate`. */
export const MAX_HIT_KEYS = 10_000;
export const MAX_FLUSH_TRIES = 3;
// Matches the shared schema's botName bound.
const MAX_BOT_NAME = 100;

/** `2026-11-11T17:42:31.250Z` → `2026-11-11T17:42:00Z`. */
export function minuteBucket(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function startHitFlusher(opts: FlusherOptions): HitFlusher {
  const url = gateUrl(opts.apiBase, '/api/gate/hits');
  const timeoutMs = opts.timeoutMs ?? GATE_TIMEOUT_MS;
  const maxKeys = opts.maxKeys ?? MAX_HIT_KEYS;
  const maxTries = opts.maxTries ?? MAX_FLUSH_TRIES;
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const log = opts.logger ?? consoleLogger;
  const now = opts.now ?? Date.now;

  let live = new Map<string, HitBucket>();
  // A batch that failed to post, retried on the next ticks until maxTries.
  let retry: { buckets: HitBucket[]; tries: number } | null = null;
  let inflight: Promise<void> | null = null;
  let droppedHits = 0;
  let failing = false;

  function add(hit: HitInput): void {
    const bucket = minuteBucket(hit.at ?? now());
    const botName = (hit.botName || '-').slice(0, MAX_BOT_NAME);
    const key = `${bucket}\u0000${hit.category}\u0000${botName}\u0000${hit.decision}\u0000${hit.isSimulated ? 1 : 0}`;
    const b = live.get(key);
    const bytes = Number.isFinite(hit.bytes) && hit.bytes > 0 ? Math.floor(hit.bytes) : 0;
    if (b) {
      b.hits += 1;
      b.bytes += bytes;
      return;
    }
    if (live.size >= maxKeys) {
      droppedHits += 1;
      return;
    }
    live.set(key, {
      bucket,
      category: hit.category,
      botName,
      decision: hit.decision,
      hits: 1,
      bytes,
      isSimulated: hit.isSimulated,
    });
  }

  async function post(buckets: HitBucket[]): Promise<boolean> {
    try {
      const body: HitsPayload = { sentAt: new Date(now()).toISOString(), buckets };
      const res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.gateKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Don't hold the socket for a body we ignore.
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failing) log.info('hit flush recovered');
      failing = false;
      return true;
    } catch (err) {
      if (!failing) {
        const why = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
        log.warn(`hit flush failed (${why}); retrying up to ${maxTries} times, then dropping`);
      }
      failing = true;
      return false;
    }
  }

  async function flushOnce(): Promise<void> {
    // One POST per tick (the API rate-limits to 1 per 5 s per site): a pending retry goes
    // first, and live counters wait for the next tick.
    let batch = retry;
    if (!batch) {
      if (live.size === 0) return;
      batch = { buckets: [...live.values()], tries: 0 };
      live = new Map();
    }
    batch.tries += 1;
    const ok = await post(batch.buckets);
    if (ok || batch.tries >= maxTries) {
      if (!ok) log.warn(`dropped ${batch.buckets.length} hit bucket(s) after ${batch.tries} tries`);
      retry = null;
    } else {
      retry = batch;
    }
  }

  function flush(): Promise<void> {
    inflight ??= flushOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const timer = setInterval(() => void flush(), opts.intervalMs ?? FLUSH_INTERVAL_MS);
  timer.unref();

  return {
    add,
    get size() {
      return live.size + (retry?.buckets.length ?? 0);
    },
    get droppedHits() {
      return droppedHits;
    },
    flush,
    stop: () => clearInterval(timer),
  };
}
