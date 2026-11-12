import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { transition, type Tx } from '../db/index.js';
import { deriveCrawlKey } from './crawlKey.js';
import {
  CRAWL_DEFAULTS,
  crawlerUserAgent,
  defaultCrawlDeps,
  minGapFor,
  type CrawlDeps,
} from './deps.js';
import { emitPageChanged } from './hooks.js';
import { hostQueueFor, realSleep } from './queue.js';
import { safeFetch, SafeFetchError, type SafeResponse } from './safeFetch.js';

/**
 * `fetchPage({ pageId, runId })` (SP-009a2; features/03 §Logic 4, §Render Workflows layout).
 * The crawler owns `snapshots`: nothing else writes them.
 *
 * - GET through `safeFetch` with `X-Spigot-Key`, `User-Agent: SpigotCrawler/1.0 (+…/crawler)`
 *   and `If-None-Match`, inside the host's 2-concurrent / min-gap queue.
 * - 304 → `pages_not_modified++` (and `fetched_at` moves, so the next crawl skips it by lastmod).
 * - 200 → gzip the body into `snapshots` (only when its hash differs from the newest snapshot;
 *   keep the newest 2), update `content_hash`, `etag`, `fetched_at`, `last_status`; a changed
 *   hash fires `onPageChanged`.
 * - 404/410 on a page whose last status was already 404/410 → `removed_at`, `onPageChanged`.
 * - 429/503 → hold the host for `Retry-After` (cap 10 min) and try again; the 3rd in a row from
 *   the host pauses the run (and the site, when READY).
 * - Network errors / other 5xx → retry after 1 s, 4 s, 16 s, then `pages_failed++`.
 *
 * Idempotent: the page row is locked for the write, so a re-run (or a resumed run) writes the
 * same hash and never more than 2 snapshots. Run counters move in the same transaction as the
 * page, so a crash never double-counts a committed page.
 */

export interface FetchPageArgs {
  pageId: string;
  runId: string;
}

export type FetchOutcome =
  | 'changed' //       200, new hash (fires onPageChanged)
  | 'unchanged' //     200, same hash
  | 'not_modified' //  304
  | 'gone_once' //     first 404/410
  | 'removed' //       second 404/410 (fires onPageChanged)
  | 'failed' //        retries exhausted, blocked, or another status
  | 'paused' //        this fetch's 429/503 paused the run
  | 'skipped'; //      run no longer RUNNING, page removed, or aborted

export interface FetchPageResult {
  outcome: FetchOutcome;
  status?: number;
  error?: string;
  /** Why a fetch was skipped. */
  reason?: 'run_not_running' | 'page_removed' | 'aborted';
}

const RETRYABLE_ERRORS = new Set(['NETWORK', 'TIMEOUT', 'DNS_FAILED']);
const RATE_LIMITED = new Set([429, 503]);
const GONE = new Set([404, 410]);
/** Per page, after this many rate-limited answers (without pausing) the page counts as failed. */
const MAX_RATE_LIMITED_TRIES = 6;

/** `Retry-After` (delta-seconds or HTTP-date) in ms, capped at 10 min; default when absent / bad. */
export function parseRetryAfter(
  value: string | undefined,
  now = Date.now(),
  cap = CRAWL_DEFAULTS.retryAfterCapMs,
): number {
  if (value === undefined || value.trim() === '') return CRAWL_DEFAULTS.retryAfterDefaultMs;
  const s = value.trim();
  let ms: number;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else {
    const at = Date.parse(s);
    if (Number.isNaN(at)) return CRAWL_DEFAULTS.retryAfterDefaultMs;
    ms = at - now;
  }
  return Math.min(Math.max(0, ms), cap);
}

interface PageRow {
  id: string;
  url: string;
  etag: string | null;
  content_hash: string | null;
  removed_at: Date | null;
  site_id: string;
  crawl_key_version: number;
  origin: string;
  last_gate_seen_at: Date | null;
  run_status: string;
}

type Counter = 'pages_fetched' | 'pages_not_modified' | 'pages_failed';

async function bump(tx: Tx, runId: string, counter: Counter): Promise<void> {
  await tx.query(`UPDATE crawl_runs SET ${counter} = ${counter} + 1 WHERE id = $1`, [runId]);
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

export async function fetchPage(
  args: FetchPageArgs,
  deps: CrawlDeps = defaultCrawlDeps(),
): Promise<FetchPageResult> {
  const { pageId, runId } = args;
  const { db } = deps;
  const sleep = deps.sleep ?? realSleep;
  const doFetch = deps.fetch ?? safeFetch;
  const delays = deps.retryDelaysMs ?? CRAWL_DEFAULTS.retryDelaysMs;

  const { rows } = await db.pool.query<PageRow>(
    `SELECT p.id, p.url, p.etag, p.content_hash, p.removed_at,
            s.id AS site_id, s.crawl_key_version, s.origin, s.last_gate_seen_at, r.status AS run_status
       FROM pages p
       JOIN sites s ON s.id = p.site_id
       JOIN crawl_runs r ON r.id = $2 AND r.site_id = s.id
      WHERE p.id = $1`,
    [pageId, runId],
  );
  const page = rows[0];
  if (!page) throw new Error(`fetchPage: page ${pageId} not found for run ${runId}`);
  if (page.run_status !== 'RUNNING') return { outcome: 'skipped', reason: 'run_not_running' };
  if (page.removed_at) return { outcome: 'skipped', reason: 'page_removed' };
  if (deps.signal?.aborted) return { outcome: 'skipped', reason: 'aborted' };

  const origin = new URL(page.origin);
  const queue = hostQueueFor(origin.host, {
    minGapMs: minGapFor(deps, page.last_gate_seen_at),
    sleep: deps.sleep,
  });
  const headers: Record<string, string> = {
    'x-spigot-key': deriveCrawlKey(page.site_id, deps.crawlSecret, page.crawl_key_version),
    'user-agent': crawlerUserAgent(deps.appBaseUrl),
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  };
  // Only ask for a 304 when we hold the body it would stand for.
  if (page.etag && page.content_hash) headers['if-none-match'] = page.etag;

  let retries = 0;
  let rateLimited = 0;
  let res: SafeResponse | undefined;
  let failure: string | undefined;

  for (;;) {
    if (deps.signal?.aborted) return { outcome: 'skipped', reason: 'aborted' };
    try {
      res = await queue.run(() =>
        doFetch(page.url, {
          origin: page.origin,
          headers,
          allowLocal: deps.allowLocal,
          resolver: deps.resolver,
        }),
      );
    } catch (err) {
      res = undefined;
      const code = err instanceof SafeFetchError ? err.code : 'UNEXPECTED';
      failure = `${code}: ${(err as Error).message}`;
      if (RETRYABLE_ERRORS.has(code) && retries < delays.length) {
        await sleep(delays[retries++]!);
        continue;
      }
      break;
    }

    if (RATE_LIMITED.has(res.status)) {
      queue.rateLimitStreak += 1;
      rateLimited += 1;
      if (queue.rateLimitStreak >= CRAWL_DEFAULTS.rateLimitPauseStreak) {
        queue.rateLimitStreak = 0;
        await pauseRun(deps, runId, page.site_id, res.status);
        return { outcome: 'paused', status: res.status };
      }
      if (rateLimited >= MAX_RATE_LIMITED_TRIES) {
        failure = `HTTP ${res.status} (rate limited ${rateLimited}×)`;
        break;
      }
      queue.backoffUntil(Date.now() + parseRetryAfter(res.headers['retry-after']));
      continue;
    }
    queue.rateLimitStreak = 0;

    if (res.status >= 500 && retries < delays.length) {
      await sleep(delays[retries++]!);
      continue;
    }
    break;
  }

  const result = await db.tx(async (tx): Promise<FetchPageResult> => {
    const locked = await tx.query<{ content_hash: string | null; last_status: number | null }>(
      'SELECT content_hash, last_status FROM pages WHERE id = $1 FOR UPDATE',
      [pageId],
    );
    const current = locked.rows[0]!;

    if (!res) {
      await bump(tx, runId, 'pages_failed');
      return { outcome: 'failed', error: failure };
    }

    if (res.status === 304) {
      await tx.query('UPDATE pages SET fetched_at = now() WHERE id = $1', [pageId]);
      await bump(tx, runId, 'pages_not_modified');
      return { outcome: 'not_modified', status: 304 };
    }

    if (res.status === 200) {
      const hash = sha256(res.body);
      const newest = await tx.query<{ content_hash: string | null }>(
        'SELECT content_hash FROM snapshots WHERE page_id = $1 ORDER BY id DESC LIMIT 1',
        [pageId],
      );
      if (newest.rows[0]?.content_hash !== hash) {
        await tx.query(
          `INSERT INTO snapshots (page_id, http_status, html_gz, content_hash, bytes)
           VALUES ($1, 200, $2, $3, $4)`,
          [pageId, gzipSync(res.body), hash, res.body.length],
        );
        await tx.query(
          `DELETE FROM snapshots
            WHERE page_id = $1
              AND id NOT IN (SELECT id FROM snapshots WHERE page_id = $1 ORDER BY id DESC LIMIT 2)`,
          [pageId],
        );
      }
      await tx.query(
        `UPDATE pages
            SET content_hash = $2, etag = $3, fetched_at = now(), last_status = 200
          WHERE id = $1`,
        [pageId, hash, res.headers['etag'] ?? null],
      );
      await bump(tx, runId, 'pages_fetched');
      return { outcome: current.content_hash === hash ? 'unchanged' : 'changed', status: 200 };
    }

    if (GONE.has(res.status)) {
      const twice = current.last_status !== null && GONE.has(current.last_status);
      await tx.query(
        twice
          ? 'UPDATE pages SET last_status = $2, fetched_at = now(), removed_at = now() WHERE id = $1'
          : 'UPDATE pages SET last_status = $2 WHERE id = $1',
        [pageId, res.status],
      );
      await bump(tx, runId, 'pages_fetched');
      return { outcome: twice ? 'removed' : 'gone_once', status: res.status };
    }

    // Any other status (401, 403, 5xx after retries, …): record it, count the page as failed.
    await tx.query('UPDATE pages SET last_status = $2 WHERE id = $1', [pageId, res.status]);
    await bump(tx, runId, 'pages_failed');
    return { outcome: 'failed', status: res.status, error: `HTTP ${res.status}` };
  });

  if (result.outcome === 'changed' || result.outcome === 'removed') {
    await emitPageChanged(pageId, runId);
  }
  return result;
}

/** 3 consecutive 429/503: run RUNNING → PAUSED; site READY → PAUSED (the only edge into PAUSED). */
async function pauseRun(
  deps: CrawlDeps,
  runId: string,
  siteId: string,
  status: number,
): Promise<void> {
  await deps.db.tx(async (tx) => {
    await transition(tx, 'crawl_runs', runId, 'RUNNING', 'PAUSED', {
      finished_at: new Date(),
      error: `Origin answered ${status} ${CRAWL_DEFAULTS.rateLimitPauseStreak} times in a row; crawl paused`,
    });
    await transition(tx, 'sites', siteId, 'READY', 'PAUSED');
  });
}
