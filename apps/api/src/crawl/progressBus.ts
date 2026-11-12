import pg from 'pg';
import type { CrawlCounters, RunStatus } from './crawlSite.js';

/**
 * The LISTEN side of `crawl_progress` (SP-009b; api.md `GET /api/crawl-runs/:id/events`).
 *
 * The crawler `notify`s `{ runId, status, counters }` every `progressEvery` pages and at run end
 * (SP-009a2). Each API process holds **one** dedicated LISTEN connection, opened on the first
 * subscriber, and fans notifications out in memory by run id. NOTIFY keeps no history, so the
 * stream sends a snapshot from `crawl_runs` on every (re)connect, and this bus tells subscribers
 * to re-snapshot after its own LISTEN connection drops and comes back.
 */

export const CRAWL_PROGRESS_CHANNEL = 'crawl_progress';

export interface CrawlProgress {
  runId: string;
  status: RunStatus;
  counters: CrawlCounters;
}

export interface CrawlProgressSubscriber {
  onProgress(p: CrawlProgress): void;
  /** LISTEN came back after a gap: notifications may have been missed, re-read the run. */
  onResync(): void;
}

export interface CrawlProgressBusOptions {
  connectionString: string;
  /** Reconnect delays in ms; the last one repeats. */
  backoffMs?: number[];
  log?: { warn(obj: object, msg: string): void };
}

const DEFAULT_BACKOFF_MS = [250, 1_000, 2_000, 5_000, 15_000];
const STATUSES: readonly string[] = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'PAUSED',
];
const COUNTER_KEYS = [
  'pages_total',
  'pages_fetched',
  'pages_not_modified',
  'pages_failed',
] as const;

/** A notification payload, or null when it isn't one of the crawler's. */
export function parseCrawlProgress(payload: string | undefined): CrawlProgress | null {
  if (!payload) return null;
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return null;
  }
  const o = v as { runId?: unknown; status?: unknown; counters?: Record<string, unknown> };
  if (typeof o?.runId !== 'string' || typeof o.status !== 'string') return null;
  if (!STATUSES.includes(o.status) || !o.counters || typeof o.counters !== 'object') return null;
  const counters = {} as CrawlCounters;
  for (const k of COUNTER_KEYS) {
    const n = o.counters[k];
    if (typeof n !== 'number' || !Number.isInteger(n)) return null;
    counters[k] = n;
  }
  return { runId: o.runId, status: o.status as RunStatus, counters };
}

export class CrawlProgressBus {
  private readonly subscribers = new Map<string, Set<CrawlProgressSubscriber>>();
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;

  constructor(private readonly opts: CrawlProgressBusOptions) {}

  /** Open the LISTEN connection if needed. Resolves once listening or after a failed attempt. */
  start(): Promise<void> {
    if (this.closed || this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  subscribe(runId: string, s: CrawlProgressSubscriber): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(s);
    return () => {
      const current = this.subscribers.get(runId);
      if (!current) return;
      current.delete(s);
      if (current.size === 0) this.subscribers.delete(runId);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.opts.connectionString,
      application_name: 'spigot-listen-crawl',
      keepAlive: true,
    });
    // Without an 'error' listener a dropped connection would crash the process.
    client.on('error', (err) => this.dropped(client, err));
    client.on('end', () => this.dropped(client));
    client.on('notification', (msg) => {
      if (msg.channel === CRAWL_PROGRESS_CHANNEL) this.dispatch(msg.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CRAWL_PROGRESS_CHANNEL}`);
    } catch (err) {
      client.removeAllListeners('end');
      await client.end().catch(() => {});
      this.opts.log?.warn({ err: (err as Error).message }, 'crawl progress: LISTEN failed');
      this.scheduleReconnect();
      return;
    }
    if (this.closed) {
      await client.end().catch(() => {});
      return;
    }
    this.client = client;
    const wasRetry = this.attempt > 0;
    this.attempt = 0;
    if (wasRetry) this.resyncAll();
  }

  private dropped(client: pg.Client, err?: Error): void {
    if (this.client !== client) return;
    this.client = null;
    client.removeAllListeners('notification');
    client.end().catch(() => {});
    if (this.closed) return;
    this.opts.log?.warn({ err: err?.message }, 'crawl progress: LISTEN connection dropped');
    this.attempt = Math.max(this.attempt, 1);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 1_000;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
    this.retryTimer.unref();
  }

  private dispatch(payload: string | undefined): void {
    const p = parseCrawlProgress(payload);
    if (!p) return;
    for (const s of [...(this.subscribers.get(p.runId) ?? [])]) {
      try {
        s.onProgress(p);
      } catch (err) {
        this.opts.log?.warn({ err: (err as Error).message }, 'crawl progress: subscriber threw');
      }
    }
  }

  private resyncAll(): void {
    for (const set of this.subscribers.values()) {
      for (const s of [...set]) {
        try {
          s.onResync();
        } catch {
          // A broken stream cleans itself up on close.
        }
      }
    }
  }
}
