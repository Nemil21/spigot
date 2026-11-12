import {
  BOT_CATEGORIES,
  formatPer1000,
  gatePolicySchema,
  POLICY_DECISIONS,
  type BotCategory,
  type GatePolicy,
  type PolicyDecision,
} from '@spigot/shared';
import type { Queryable } from '../db/index.js';
import type { GateSite } from './gateAuth.js';

/**
 * `GET /api/gate/policy` (api.md §Gate endpoints; SP-008b). Everything the gate needs to decide
 * a request without calling us: the per-category decisions, which paths are gated, the crawl
 * key's hash, and the live prices for the 402 body. The gate refreshes every 60 s; `ETag` is the
 * `policyVersion`, so anything that changes this response must call `bumpPolicyVersion` in the
 * same transaction (dataset approve / unpublish SP-014a, settings SP-034, key rotation).
 */

/** Datasets that are sold (data-model §dataset lifecycle), so their pages are gated and priced. */
export const SOLD_DATASET_STATUSES = ['LIVE', 'LIVE_STALE'] as const;

/** The `sites.policy` column default (001_init.sql), used for a missing or bad category. */
export const DEFAULT_DECISIONS: Record<BotCategory, PolicyDecision> = {
  SEARCH: 'PASS',
  AI_TRAINING: 'QUOTE',
  AI_AGENT: 'QUOTE',
  SCRAPER_TOOL: 'QUOTE',
  UNKNOWN: 'PASS',
};

/**
 * Increment `sites.policy_version` inside `tx` and return the new version. Call it in the same
 * transaction as any write that changes the policy response (a dataset going LIVE or UNPUBLISHED,
 * a settings change, a crawl-key rotation), so the gate's next refresh sees a new `ETag`.
 */
export async function bumpPolicyVersion(tx: Queryable, siteId: string): Promise<number> {
  const { rows } = await tx.query<{ policy_version: number }>(
    `UPDATE sites SET policy_version = policy_version + 1, updated_at = now()
      WHERE id = $1 RETURNING policy_version`,
    [siteId],
  );
  if (!rows[0]) throw new Error(`bumpPolicyVersion: no site ${siteId}`);
  return rows[0].policy_version;
}

// A regex fragment that matches only itself: plain characters and backslash-escaped ones.
const LITERAL_SEGMENT = /^(?:[^\\.*+?^${}()|[\]]|\\[.*+?^${}()|[\]\\/-])+$/;

/**
 * The gated-path regex for a template's anchored `url_pattern` (SP-010, e.g.
 * `^/listings/[a-z0-9-]+$` → `^/listings/`): the leading literal segments as a prefix, so the
 * whole section is gated, the way api.md's example shows. A pattern that is all literal, or whose
 * first segment is already a parameter (a prefix of `^/` would gate `/robots.txt` and the home
 * page), is kept as it is.
 */
export function gatedPathFor(urlPattern: string): string {
  if (!urlPattern.startsWith('^/')) return urlPattern;
  const body = urlPattern.slice(2).replace(/\$$/, '');
  const segs = body.split('/');
  let literal = 0;
  while (literal < segs.length && LITERAL_SEGMENT.test(segs[literal]!)) literal++;
  if (literal === 0 || literal === segs.length) return urlPattern;
  return `^/${segs.slice(0, literal).join('/')}/`;
}

export function isValidRegex(src: unknown): src is string {
  if (typeof src !== 'string' || src.length === 0) return false;
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

function decisionsOf(policy: Record<string, unknown>): GatePolicy['decisions'] {
  const out = { ...DEFAULT_DECISIONS };
  for (const c of BOT_CATEGORIES) {
    const v = policy[c];
    if ((POLICY_DECISIONS as readonly unknown[]).includes(v)) out[c] = v as PolicyDecision;
  }
  return out;
}

export interface PolicyDeps {
  /** `APP_BASE_URL`, e.g. `https://spigot.onrender.com`. */
  appBaseUrl: string;
}

/** The policy response for `site`, validated against `gatePolicySchema` (@spigot/shared). */
export async function buildGatePolicy(
  q: Queryable,
  deps: PolicyDeps,
  site: GateSite,
): Promise<GatePolicy> {
  const { rows: datasets } = await q.query<{
    slug: string;
    price_per_record_micros: string;
    url_pattern: string | null;
  }>(
    `SELECT d.slug, d.price_per_record_micros, t.url_pattern
       FROM datasets d
       LEFT JOIN templates t ON t.id = d.template_id AND t.site_id = d.site_id
      WHERE d.site_id = $1 AND d.status = ANY($2::text[])
      ORDER BY d.slug`,
    [site.id, SOLD_DATASET_STATUSES],
  );

  const gated = new Set<string>();
  for (const d of datasets) {
    if (d.url_pattern && isValidRegex(d.url_pattern)) gated.add(gatedPathFor(d.url_pattern));
  }
  const configured = Array.isArray(site.policy.gated_paths) ? site.policy.gated_paths : [];
  for (const p of configured) if (isValidRegex(p)) gated.add(p);

  const base = deps.appBaseUrl.replace(/\/+$/, '');
  const slug = encodeURIComponent(site.slug ?? site.id);
  return gatePolicySchema.parse({
    siteId: site.id,
    policyVersion: site.policyVersion,
    apiBase: `${base}/v1/${slug}`,
    catalogUrl: `${base}/c/${slug}`,
    crawlKeySha256: site.crawlKeyHash,
    gatedPaths: [...gated],
    decisions: decisionsOf(site.policy),
    prices: datasets.map((d) => {
      const perRecordMicros = Number(d.price_per_record_micros);
      return { dataset: d.slug, perRecordMicros, display: formatPer1000(perRecordMicros) };
    }),
  });
}
