import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { isUniqueViolation } from '../auth/credentials.js';
import { crawlerUserAgent } from '../crawl/deps.js';
import { normalizeOnOrigin } from '../crawl/normalizeUrl.js';
import {
  safeFetch,
  SafeFetchError,
  type Resolver,
  type SafeFetchOptions,
  type SafeResponse,
} from '../crawl/safeFetch.js';
import { parseSitemapXml } from '../crawl/sitemap.js';
import type { Db, Queryable } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { forPublisher } from '../tenancy.js';
import { generateSiteSecrets, VERIFY_PATH } from './keys.js';

/**
 * Sites: connect and read (SP-008a; features/03 §Logic 1, api.md §`POST /api/sites`).
 *
 * Connect normalizes the origin, probes `/robots.txt` and the sitemap through `safeFetch` (the
 * one SSRF-guarded fetch; 5 s each), then inserts the site `PENDING_VERIFY` with only key hashes
 * and audits `SITE_CONNECTED` in the same transaction. Nothing is written when the probe fails.
 */

export interface SitesDeps {
  db: Db;
  /** `SESSION_SECRET`: the crawl key is derived from it (crawl/crawlKey.ts). */
  crawlSecret: string;
  /** `ALLOW_LOCAL_ORIGINS` (dev only; forced off in production by `loadConfig`). */
  allowLocal: boolean;
  /** `APP_BASE_URL`: the gate's `apiBase` in the install snippet, and the crawler UA link. */
  appBaseUrl: string;
  /** Test seams. */
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeResponse>;
  resolver?: Resolver;
}

export const PROBE_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 512 * 1024;
const SITEMAP_MAX_XML_BYTES = 50 * 1024 * 1024;

export const MESSAGES = {
  unreachable: "We couldn't reach that site",
  noSitemap: 'Add a sitemap.xml or enter one',
  blocked: "That address isn't a public website",
  taken: 'That site is already connected to Spigot',
} as const;

export const connectBody = z.object({
  origin: z.string().trim().min(1).max(2048),
  sitemapUrl: z.string().trim().min(1).max(2048).optional(),
});
export type ConnectInput = z.infer<typeof connectBody>;

// ---------------------------------------------------------------------------------------------
// Origin and slug

/**
 * `scheme://host[:port]` from what the publisher typed: a bare host gets `https://`; a path,
 * query or fragment is dropped. Credentials and non-http(s) schemes are a 400.
 */
export function normalizeOrigin(input: string): string {
  const raw = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Enter a site URL like https://example.com.', {
      field: 'origin',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('VALIDATION_ERROR', 'Only http and https sites can be connected.', {
      field: 'origin',
    });
  }
  if (url.username || url.password) {
    throw new ApiError('VALIDATION_ERROR', 'Remove the username and password from the URL.', {
      field: 'origin',
    });
  }
  if (!url.hostname) {
    throw new ApiError('VALIDATION_ERROR', 'Enter a site URL like https://example.com.', {
      field: 'origin',
    });
  }
  return url.origin;
}

/** Slugs that would shadow a fixed path segment (`/v1/catalog`, `/c/:site`, …). */
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'assets',
  'balance',
  'c',
  'catalog',
  'claims',
  'docs',
  'healthz',
  'mcp',
  'openapi',
  'openapi-yaml',
  'static',
  'topups',
  'v1',
  'webhooks',
  'www',
]);

/**
 * The slug used in API paths (`/v1/<slug>/…`): the first DNS label of the host (after `www.`),
 * lowercased, `[a-z0-9-]`, 3–40 chars, starting with a letter. IP literals become `site`.
 * Uniqueness is the caller's job (`-2`, `-3`, … suffixes).
 */
export function baseSlug(origin: string): string {
  const host = new URL(origin).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  let label = isIP(host) ? 'site' : (host.replace(/^www\./, '').split('.')[0] ?? 'site');
  label = label
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  if (!/^[a-z]/.test(label)) label = `site-${label}`.replace(/-$/, '');
  if (label.length < 3 || RESERVED_SLUGS.has(label)) label = `${label}-site`;
  return label;
}

/** The smallest free `base`, `base-2`, `base-3`, … given the taken slugs. */
export function pickSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!set.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------
// Probe

/** Network-class failures mean "couldn't reach"; address/URL problems are the publisher's input. */
function probeError(err: unknown): ApiError {
  if (err instanceof SafeFetchError) {
    switch (err.code) {
      case 'BLOCKED_ADDRESS':
        return new ApiError('VALIDATION_ERROR', MESSAGES.blocked, { field: 'origin' });
      case 'INVALID_URL':
        return new ApiError('VALIDATION_ERROR', 'Enter a site URL like https://example.com.', {
          field: 'origin',
        });
      case 'OFF_ORIGIN': {
        let redirectsTo: string | undefined;
        try {
          redirectsTo = new URL(err.url).origin;
        } catch {
          redirectsTo = undefined;
        }
        return new ApiError(
          'VALIDATION_ERROR',
          redirectsTo
            ? `That site redirects to ${redirectsTo}. Connect that address instead.`
            : 'That site redirects to another address. Connect that address instead.',
          { field: 'origin', reason: 'REDIRECTS_OFF_ORIGIN', redirectsTo },
        );
      }
      default:
        return new ApiError('ORIGIN_ERROR', MESSAGES.unreachable, { reason: err.code });
    }
  }
  return new ApiError('ORIGIN_ERROR', MESSAGES.unreachable);
}

/** `Sitemap:` lines from robots.txt that point at this origin, in order. */
export function sitemapsFromRobots(robots: string, origin: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    const url = m && normalizeOnOrigin(m[1]!, origin);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

function looksLikeSitemap(res: SafeResponse): boolean {
  if (res.status !== 200 || res.body.length === 0) return false;
  try {
    const body = res.body;
    const xml =
      body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b
        ? gunzipSync(body, { maxOutputLength: SITEMAP_MAX_XML_BYTES }).toString('utf8')
        : body.toString('utf8');
    parseSitemapXml(xml);
    return true;
  } catch {
    return false;
  }
}

export interface ProbeResult {
  sitemapUrl: string;
}

/**
 * Reachability and sitemap check. `/robots.txt` answering with any HTTP status proves the origin
 * is reachable; its `Sitemap:` lines are candidates after the override and before
 * `/sitemap.xml`. The first candidate that is a parseable urlset / sitemap index wins.
 */
export async function probeOrigin(
  origin: string,
  sitemapOverride: string | undefined,
  deps: Pick<SitesDeps, 'allowLocal' | 'appBaseUrl' | 'fetch' | 'resolver'>,
): Promise<ProbeResult> {
  const doFetch = deps.fetch ?? safeFetch;
  const base: SafeFetchOptions = {
    origin,
    allowLocal: deps.allowLocal,
    resolver: deps.resolver,
    timeoutMs: PROBE_TIMEOUT_MS,
    headers: { 'user-agent': crawlerUserAgent(deps.appBaseUrl) },
  };

  let override: string | undefined;
  if (sitemapOverride !== undefined) {
    override = normalizeOnOrigin(sitemapOverride, origin) ?? undefined;
    if (!override) {
      throw new ApiError('VALIDATION_ERROR', 'The sitemap URL must be on the same site.', {
        field: 'sitemapUrl',
      });
    }
  }

  let fromRobots: string[] = [];
  try {
    const robots = await doFetch(`${origin}/robots.txt`, { ...base, maxBytes: ROBOTS_MAX_BYTES });
    if (robots.status === 200)
      fromRobots = sitemapsFromRobots(robots.body.toString('utf8'), origin);
  } catch (err) {
    // An oversized robots.txt still proves the origin answers.
    if (!(err instanceof SafeFetchError && err.code === 'BODY_TOO_LARGE')) throw probeError(err);
  }

  const candidates = [
    ...(override ? [override] : []),
    ...fromRobots,
    `${origin}/sitemap.xml`,
  ].filter((u, i, all) => all.indexOf(u) === i);

  for (const url of candidates) {
    let ok = false;
    try {
      ok = looksLikeSitemap(await doFetch(url, base));
    } catch (err) {
      if (
        err instanceof SafeFetchError &&
        ['DNS_FAILED', 'NETWORK', 'TIMEOUT'].includes(err.code)
      ) {
        throw probeError(err);
      }
      // Too large, redirected off origin, …: not a usable sitemap.
    }
    if (ok) return { sitemapUrl: url };
    // An explicit override that isn't a sitemap is the publisher's to fix; don't silently fall back.
    if (url === override) break;
  }
  throw new ApiError('VALIDATION_ERROR', MESSAGES.noSitemap, {
    field: 'sitemapUrl',
    reason: 'NO_SITEMAP',
  });
}

// ---------------------------------------------------------------------------------------------
// Connect

export interface ConnectResult {
  siteId: string;
  slug: string;
  origin: string;
  sitemapUrl: string;
  status: 'PENDING_VERIFY';
  verify: { path: string; content: string };
  gateKey: string;
  crawlKey: string;
  install: string;
}

export function installSnippet(appBaseUrl: string): string {
  const apiBase = appBaseUrl.replace(/\/+$/, '');
  return (
    `npm i @spigot/gate  →  app.use(spigotGate({ gateKey: process.env.SPIGOT_GATE_KEY, ` +
    `apiBase: '${apiBase}' }))`
  );
}

const SLUG_ATTEMPTS = 5;

async function originTaken(q: Queryable, origin: string): Promise<boolean> {
  const { rows } = await q.query('SELECT 1 FROM sites WHERE origin = $1', [origin]);
  return rows.length > 0;
}

export async function connectSite(
  deps: SitesDeps,
  publisherId: string,
  input: ConnectInput,
): Promise<ConnectResult> {
  const scope = forPublisher(publisherId);
  const origin = normalizeOrigin(input.origin);

  // Fast path before any outbound fetch; the unique index still decides the race below.
  if (await originTaken(deps.db.pool, origin)) throw new ApiError('STATE_CONFLICT', MESSAGES.taken);

  const { sitemapUrl } = await probeOrigin(origin, input.sitemapUrl, deps);

  const siteId = randomUUID();
  const secrets = generateSiteSecrets(siteId, deps.crawlSecret);
  const base = baseSlug(origin);

  for (let attempt = 1; ; attempt++) {
    try {
      const slug = await deps.db.tx(async (tx) => {
        const { rows: taken } = await tx.query<{ slug: string }>(
          `SELECT slug FROM sites WHERE slug = $1 OR slug LIKE $2`,
          [base, `${base.replace(/[\\%_]/g, '\\$&')}-%`],
        );
        const slug = pickSlug(
          base,
          taken.map((r) => r.slug),
        );
        await tx.query(
          `INSERT INTO sites (id, publisher_id, origin, slug, sitemap_url, verify_token,
                              crawl_key_hash, gate_key_hash, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_VERIFY')`,
          [
            siteId,
            scope.publisherId,
            origin,
            slug,
            sitemapUrl,
            secrets.verifyToken,
            secrets.crawlKeyHash,
            secrets.gateKeyHash,
          ],
        );
        await audit(tx, {
          actorType: 'PUBLISHER',
          actorId: scope.publisherId,
          publisherId: scope.publisherId,
          entity: 'sites',
          entityId: siteId,
          action: 'SITE_CONNECTED',
          data: { origin, slug, sitemapUrl },
        });
        return slug;
      });
      return {
        siteId,
        slug,
        origin,
        sitemapUrl,
        status: 'PENDING_VERIFY',
        verify: { path: VERIFY_PATH, content: secrets.verifyToken },
        gateKey: secrets.gateKey,
        crawlKey: secrets.crawlKey,
        install: installSnippet(deps.appBaseUrl),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const constraint = (err as { constraint?: string }).constraint ?? '';
      if (constraint.includes('origin') || (await originTaken(deps.db.pool, origin))) {
        throw new ApiError('STATE_CONFLICT', MESSAGES.taken);
      }
      // A concurrent connect took the same slug: pick again.
      if (attempt >= SLUG_ATTEMPTS) throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reads

export interface SiteView {
  id: string;
  slug: string;
  origin: string;
  sitemapUrl: string | null;
  status: string;
  verify: { path: string; content: string };
  policy: Record<string, unknown>;
  policyVersion: number;
  lastGateSeenAt: string | null;
  rightsAttestedAt: string | null;
  createdAt: string;
}

/** Never selects `crawl_key_hash` / `gate_key_hash`. */
const VIEW_COLUMNS = `t.id, t.slug, t.origin, t.sitemap_url, t.status, t.verify_token, t.policy,
  t.policy_version, t.last_gate_seen_at, t.rights_attested_at, t.created_at`;

interface SiteRow {
  id: string;
  slug: string;
  origin: string;
  sitemap_url: string | null;
  status: string;
  verify_token: string;
  policy: Record<string, unknown>;
  policy_version: number;
  last_gate_seen_at: Date | null;
  rights_attested_at: Date | null;
  created_at: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toView(r: SiteRow): SiteView {
  return {
    id: r.id,
    slug: r.slug,
    origin: r.origin,
    sitemapUrl: r.sitemap_url,
    status: r.status,
    // The token is public (served from the publisher's origin); W03 shows it until verified.
    verify: { path: VERIFY_PATH, content: r.verify_token },
    policy: r.policy,
    policyVersion: r.policy_version,
    lastGateSeenAt: iso(r.last_gate_seen_at),
    rightsAttestedAt: iso(r.rights_attested_at),
    createdAt: r.created_at.toISOString(),
  };
}

export async function listSites(q: Queryable, publisherId: string): Promise<SiteView[]> {
  const params: unknown[] = [];
  const where = forPublisher(publisherId).owns('sites', 't', params);
  const { rows } = await q.query<SiteRow>(
    `SELECT ${VIEW_COLUMNS} FROM sites t WHERE ${where} ORDER BY t.created_at, t.id`,
    params,
  );
  return rows.map(toView);
}

/** 404 when the id isn't a uuid, doesn't exist, or is another publisher's. */
export async function getSite(
  q: Queryable,
  publisherId: string,
  siteId: string,
): Promise<SiteView> {
  const row = await forPublisher(publisherId).get<SiteRow>(q, 'sites', siteId, {
    columns: VIEW_COLUMNS,
  });
  return toView(row);
}
