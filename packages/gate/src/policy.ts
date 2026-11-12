// Gate policy: the wire shape of `GET /api/gate/policy` (api.md §Gate endpoints) and a
// zero-dependency parser that compiles it once, so `classify` never parses or allocates
// regexes on the request path. `@spigot/shared/gate` holds the zod schema for the same
// shape; this package can't import it (zero runtime deps), so SP-006b asserts parity.

export const CATEGORIES = [
  'SEARCH',
  'AI_TRAINING',
  'AI_AGENT',
  'SCRAPER_TOOL',
  'UNKNOWN',
  'HUMAN',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories the owner sets a decision for. HUMAN always passes. */
export const POLICY_CATEGORIES = [
  'SEARCH',
  'AI_TRAINING',
  'AI_AGENT',
  'SCRAPER_TOOL',
  'UNKNOWN',
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export type PolicyDecision = 'PASS' | 'QUOTE';
export type Decision = PolicyDecision | 'SPIGOT_CRAWLER';

export interface PolicyPrice {
  dataset: string;
  perRecordMicros: number;
  display?: string;
  /** Record type name, e.g. `Listing` (optional; shown in the 402 body). */
  type?: string;
  /** Live record count (optional; shown in the 402 body). */
  records?: number;
}

/** JSON body of `GET /api/gate/policy`. */
export interface PolicyWire {
  siteId: string;
  policyVersion: number;
  /** Buyer API base for this site, e.g. `https://spigot.onrender.com/v1/bluebonnet`. */
  apiBase: string;
  /** Public catalog page (W13), e.g. `https://spigot.onrender.com/c/bluebonnet`. */
  catalogUrl: string;
  /** Hex SHA-256 of our crawler's `X-Spigot-Key`; empty or absent disables rule 1. */
  crawlKeySha256?: string | null;
  /** Regex sources matched against the request path. */
  gatedPaths: string[];
  decisions: Record<PolicyCategory, PolicyDecision>;
  prices: PolicyPrice[];
  /** Display name for the 402 body and D04 page; falls back to the site slug. */
  siteName?: string;
}

/** A parsed, compiled policy. Build with `parsePolicy`; treat as immutable. */
export interface Policy {
  readonly wire: PolicyWire;
  readonly policyVersion: number;
  readonly gatedPaths: readonly RegExp[];
  readonly decisions: Readonly<Record<PolicyCategory, PolicyDecision>>;
  /** 32-byte digest, or null when no crawl key is set. */
  readonly crawlKeyDigest: Buffer | null;
}

export class PolicyError extends Error {
  override name = 'PolicyError';
}

const MAX_GATED_PATHS = 200;
const MAX_PATH_PATTERN = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0)
    throw new PolicyError(`policy.${key} must be a non-empty string`);
  return v;
}

function httpUrl(o: Record<string, unknown>, key: string): string {
  const v = str(o, key);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new PolicyError(`policy.${key} must be an absolute URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new PolicyError(`policy.${key} must be http(s)`);
  return v.replace(/\/+$/, '');
}

function nonNegInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new PolicyError(`${what} must be a non-negative integer`);
  return v;
}

/**
 * Validate and compile a policy response. Throws `PolicyError` on any malformed field;
 * the refresher (SP-006b) keeps the last good policy when this throws.
 */
export function parsePolicy(input: unknown): Policy {
  if (!isRecord(input)) throw new PolicyError('policy must be an object');

  const siteId = str(input, 'siteId');
  const policyVersion = nonNegInt(input.policyVersion, 'policy.policyVersion');
  const apiBase = httpUrl(input, 'apiBase');
  const catalogUrl = httpUrl(input, 'catalogUrl');

  let crawlKeyDigest: Buffer | null = null;
  const rawKey = input.crawlKeySha256;
  if (rawKey !== undefined && rawKey !== null && rawKey !== '') {
    if (typeof rawKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      throw new PolicyError('policy.crawlKeySha256 must be a 64-char hex SHA-256');
    }
    crawlKeyDigest = Buffer.from(rawKey, 'hex');
  }

  if (!Array.isArray(input.gatedPaths)) throw new PolicyError('policy.gatedPaths must be an array');
  if (input.gatedPaths.length > MAX_GATED_PATHS)
    throw new PolicyError(`policy.gatedPaths has more than ${MAX_GATED_PATHS} entries`);
  const gatedSources: string[] = [];
  const gatedPaths = input.gatedPaths.map((p, i) => {
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_PATTERN) {
      throw new PolicyError(
        `policy.gatedPaths[${i}] must be a non-empty string under ${MAX_PATH_PATTERN} chars`,
      );
    }
    gatedSources.push(p);
    try {
      return new RegExp(p);
    } catch {
      throw new PolicyError(`policy.gatedPaths[${i}] is not a valid regex`);
    }
  });

  if (!isRecord(input.decisions)) throw new PolicyError('policy.decisions must be an object');
  const rawDecisions = input.decisions;
  const decisions = {} as Record<PolicyCategory, PolicyDecision>;
  for (const c of POLICY_CATEGORIES) {
    const d = rawDecisions[c];
    if (d !== 'PASS' && d !== 'QUOTE')
      throw new PolicyError(`policy.decisions.${c} must be PASS or QUOTE`);
    decisions[c] = d;
  }

  if (!Array.isArray(input.prices)) throw new PolicyError('policy.prices must be an array');
  const prices: PolicyPrice[] = input.prices.map((p, i) => {
    if (!isRecord(p)) throw new PolicyError(`policy.prices[${i}] must be an object`);
    const dataset = str(p, 'dataset');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(dataset))
      throw new PolicyError(`policy.prices[${i}].dataset must be a slug`);
    const price: PolicyPrice = {
      dataset,
      perRecordMicros: nonNegInt(p.perRecordMicros, `policy.prices[${i}].perRecordMicros`),
    };
    if (typeof p.display === 'string') price.display = p.display;
    if (typeof p.type === 'string' && p.type.length > 0) price.type = p.type;
    if (p.records !== undefined && p.records !== null)
      price.records = nonNegInt(p.records, `policy.prices[${i}].records`);
    return price;
  });

  const wire: PolicyWire = {
    siteId,
    policyVersion,
    apiBase,
    catalogUrl,
    crawlKeySha256: crawlKeyDigest ? crawlKeyDigest.toString('hex') : null,
    gatedPaths: gatedSources,
    decisions: { ...decisions },
    prices,
  };
  if (typeof input.siteName === 'string' && input.siteName.trim().length > 0)
    wire.siteName = input.siteName.trim();

  return Object.freeze({
    wire,
    policyVersion,
    gatedPaths: Object.freeze(gatedPaths),
    decisions: Object.freeze(decisions),
    crawlKeyDigest,
  });
}
