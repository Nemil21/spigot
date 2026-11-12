import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { sha256Hex } from '../sites/keys.js';
import { startCrawl } from './crawlSite.js';
import type { CrawlDeps } from './deps.js';
import { normalizeOnOrigin } from './normalizeUrl.js';
import { MAX_PING_URLS, queuePings } from './ping.js';

/**
 * CMS ping service (SP-055; api.md §`POST /api/sites/:id/ping`). `routes/ping.ts` is the HTTP
 * shell; the queue and the run side are in ping.ts.
 *
 * - Auth: the site's crawl key `ck_…` as Bearer (only `sites.crawl_key_hash` is stored). The key
 *   alone picks the site; a path id that isn't the key's site is the same 401 as a bad key.
 * - Body `{ urls }`: 1–500 URLs, each on the site's origin (relative paths resolve against it).
 *   Whether a URL is in the sitemap is decided by the run, which re-reads the sitemap when a
 *   pinged URL isn't a known page yet (a new listing); URLs still not listed are dropped.
 * - The URLs are queued, then `startCrawl(trigger: 'PING')`: a new PING run, or the site's live
 *   run when there is one (joined).
 */

/** Longest URL accepted in a ping. */
export const MAX_PING_URL_LENGTH = 2_048;
/** Fits 500 URLs of the maximum length. */
export const PING_BODY_LIMIT = 1_200_000;

export const pingBody = z
  .object({
    urls: z.array(z.string().min(1).max(MAX_PING_URL_LENGTH)).min(1).max(MAX_PING_URLS),
  })
  .strict();
export type PingBody = z.infer<typeof pingBody>;

export interface PingSite {
  id: string;
  origin: string;
  status: string;
}

const BEARER_CRAWL_KEY = /^Bearer\s+(ck_[A-Za-z0-9_-]{16,200})\s*$/i;

const unauthenticated = () => new ApiError('UNAUTHENTICATED', 'A valid crawl key is required.');

/** The site whose crawl key is in `authorization`, if it is `siteId`; else `401 UNAUTHENTICATED`. */
export async function authenticateCrawlKey(
  q: Queryable,
  authorization: string | undefined,
  siteId: string,
): Promise<PingSite> {
  const m = BEARER_CRAWL_KEY.exec(authorization ?? '');
  if (!m) throw unauthenticated();
  const { rows } = await q.query<PingSite>(
    'SELECT id, origin, status FROM sites WHERE crawl_key_hash = $1',
    [sha256Hex(m[1]!)],
  );
  const site = rows[0];
  if (!site || site.id !== siteId) throw unauthenticated();
  return site;
}

/** Normalized, deduped URLs on `origin`; any URL off it (or unparseable) is a 400. */
export function normalizePingUrls(urls: readonly string[], origin: string): string[] {
  const out = new Set<string>();
  const invalid: string[] = [];
  for (const u of urls) {
    const n = normalizeOnOrigin(u, origin);
    if (n) out.add(n);
    else invalid.push(u);
  }
  if (invalid.length) {
    throw new ApiError('VALIDATION_ERROR', `Every URL must be on ${origin}.`, {
      invalid: invalid.slice(0, 20),
      invalidCount: invalid.length,
    });
  }
  return [...out];
}

export interface PingAccepted {
  crawlRunId: string;
  workflowRunId: string | null;
  /** True when the URLs joined a run that was already live. */
  joined: boolean;
  urls: number;
}

/**
 * The ping: validate, queue, start or join the site's run. Only a READY site (approved datasets,
 * no discovery pending) takes pings: before that there is nothing to keep fresh, and a PING run
 * must never be the run that moves a VERIFIED site to PROPOSING.
 *
 * `onStarted` receives the run's `done` promise when this process executes it.
 */
export async function requestPing(
  deps: CrawlDeps,
  site: PingSite,
  body: PingBody,
  onStarted: (done: Promise<unknown>) => void = () => {},
): Promise<PingAccepted> {
  const urls = normalizePingUrls(body.urls, site.origin);
  if (site.status === 'PENDING_VERIFY') {
    throw new ApiError('SITE_NOT_VERIFIED', 'Verify the site before pinging it.', {
      path: '/.well-known/spigot.txt',
    });
  }
  if (site.status !== 'READY') {
    throw new ApiError(
      'STATE_CONFLICT',
      `Pings are taken once the site is READY (it is ${site.status}).`,
      {
        status: site.status,
      },
    );
  }

  await queuePings(deps, site.id, urls);
  const started = await startCrawl({ siteId: site.id, trigger: 'PING' }, deps);
  started.done.catch(() => {});
  if (started.created || started.resumed) onStarted(started.done);

  const { rows } = await deps.db.pool.query<{ workflow_run_id: string | null }>(
    'SELECT workflow_run_id FROM crawl_runs WHERE id = $1',
    [started.runId],
  );
  return {
    crawlRunId: started.runId,
    workflowRunId: rows[0]?.workflow_run_id ?? null,
    joined: !started.created,
    urls: urls.length,
  };
}
