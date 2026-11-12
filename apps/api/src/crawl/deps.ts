import { loadConfig } from '../config.js';
import { createDb, createPool, type Db } from '../db/index.js';
import type { FetchBatchResult } from './fetchBatch.js';
import { createBrowserRenderer, type Renderer } from './render.js';
import type { Resolver, SafeFetchOptions, SafeResponse } from './safeFetch.js';

/**
 * What the crawl tasks need from the outside world (SP-009a2). The Workflows entry and the
 * in-process dispatcher call `crawlSite(args)` / `fetchPage(args)` without deps and get
 * `defaultCrawlDeps()` (config + one small pool); tests pass their own.
 */
export interface CrawlDeps {
  db: Db;
  /** `SESSION_SECRET`: the crawl key is derived from it (crawlKey.ts). */
  crawlSecret: string;
  /** `ALLOW_LOCAL_ORIGINS` (dev only; forced off in production by `loadConfig`). */
  allowLocal: boolean;
  /** `APP_BASE_URL`, for the User-Agent's `(+…/crawler)` link. */
  appBaseUrl: string;
  /**
   * `CRAWL_MIN_GAP_MS` when set explicitly. Unset: 250 ms, or 25 ms for an origin whose gate
   * posted hits in the last 10 minutes (`sites.last_gate_seen_at`).
   */
  minGapMs?: number;
  /**
   * Headless Chromium for `render = 'browser'` templates (SP-064). Set only when
   * `CRAWL_RENDER=browser`; without it those pages count as failed and keep their old snapshot.
   */
  renderer?: Renderer;
  /** Test seams. */
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeResponse>;
  resolver?: Resolver;
  /** Used for the 1 s / 4 s / 16 s retry back-off and Retry-After holds. */
  sleep?: (ms: number) => Promise<void>;
  /** Default [1000, 4000, 16000]. */
  retryDelaysMs?: readonly number[];
  /** A live run whose row hasn't been touched for this long is orphaned and may be resumed. Default 120 000. */
  staleRunMs?: number;
  /** How often a running run touches its row. Default 30 000. */
  heartbeatMs?: number;
  /** `crawl_progress` notify cadence in pages. Default 25. */
  progressEvery?: number;
  /** `fetchPage` calls in flight per run (each still goes through the 2-per-host queue). Default 4. */
  pageWorkers?: number;
  /** Aborting stops the run where it is without finishing it, like a killed process. */
  signal?: AbortSignal;
  /**
   * SP-041a, API side: offered every run this process creates or adopts. Returns the Render
   * Workflows run id when the run was started on Workflows (`WORKFLOWS_MODE=workflows`), or null
   * to execute it in this process. Unset: always in process.
   */
  handOff?: (args: { siteId: string; trigger: string; runId: string }) => Promise<string | null>;
  /**
   * SP-041a, Workflows side: fetch the run's pages as `fetchBatch` tasks (at most 2 per host,
   * `planBatches`) instead of the in-process page queue. Resolves when every batch has ended.
   */
  fanOut?: (runId: string, pageIds: string[]) => Promise<FetchBatchResult[]>;
}

export const CRAWL_DEFAULTS = {
  minGapMs: 250,
  gatedMinGapMs: 25,
  gateSeenWithinMs: 10 * 60_000,
  retryDelaysMs: [1_000, 4_000, 16_000] as readonly number[],
  retryAfterCapMs: 10 * 60_000,
  /** Used when a 429/503 carries no (parseable) Retry-After. */
  retryAfterDefaultMs: 5_000,
  rateLimitPauseStreak: 3,
  staleRunMs: 120_000,
  heartbeatMs: 30_000,
  progressEvery: 25,
  pageWorkers: 4,
} as const;

let cached: CrawlDeps | undefined;

export function defaultCrawlDeps(env: Record<string, string | undefined> = process.env): CrawlDeps {
  if (cached) return cached;
  const config = loadConfig(env);
  const pool = createPool(config.DATABASE_URL, { max: 6, applicationName: 'spigot-crawl' });
  cached = {
    db: createDb(pool),
    crawlSecret: config.SESSION_SECRET,
    allowLocal: config.ALLOW_LOCAL_ORIGINS,
    appBaseUrl: config.APP_BASE_URL,
    minGapMs: env.CRAWL_MIN_GAP_MS?.trim() ? config.CRAWL_MIN_GAP_MS : undefined,
    renderer:
      config.CRAWL_RENDER === 'browser'
        ? createBrowserRenderer({ userAgent: crawlerUserAgent(config.APP_BASE_URL) })
        : undefined,
  };
  return cached;
}

/** The gap for one origin: explicit config wins; otherwise 25 ms behind a live gate, else 250 ms. */
export function minGapFor(
  deps: Pick<CrawlDeps, 'minGapMs'>,
  lastGateSeenAt: Date | null,
  now = Date.now(),
): number {
  if (deps.minGapMs !== undefined) return deps.minGapMs;
  const gateLive =
    lastGateSeenAt !== null && now - lastGateSeenAt.getTime() <= CRAWL_DEFAULTS.gateSeenWithinMs;
  return gateLive ? CRAWL_DEFAULTS.gatedMinGapMs : CRAWL_DEFAULTS.minGapMs;
}

export function crawlerUserAgent(appBaseUrl: string): string {
  return `SpigotCrawler/1.0 (+${appBaseUrl.replace(/\/+$/, '')}/crawler)`;
}
