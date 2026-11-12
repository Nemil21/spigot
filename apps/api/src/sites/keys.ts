import { createHash, randomBytes } from 'node:crypto';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';

/**
 * Per-site secrets (SP-008a; data-model §sites, features/14 §Auth boundaries):
 *
 * - **Gate key** `gk_…`: random; the publisher's gate sends it as `Authorization: Bearer` to pull
 *   policy and post hit counts. Only `sites.gate_key_hash` (SHA-256 hex) is stored.
 * - **Crawl key** `ck_…`: derived from `SESSION_SECRET` and the site id (crawl/crawlKey.ts), so
 *   the crawler can recompute it; only `sites.crawl_key_hash` is stored.
 * - **Verify token** `spigot-verify=<hex>`: public by design (it is served from the publisher's
 *   origin), stored as-is in `sites.verify_token`. It is the whole content of
 *   `/.well-known/spigot.txt`.
 *
 * Keys are returned once, by `POST /api/sites`, and never again.
 */

export const VERIFY_PATH = '/.well-known/spigot.txt';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateGateKey(): string {
  return `gk_${randomBytes(32).toString('base64url')}`;
}

export function generateVerifyToken(): string {
  return `spigot-verify=${randomBytes(16).toString('hex')}`;
}

export interface SiteSecrets {
  gateKey: string;
  crawlKey: string;
  verifyToken: string;
  gateKeyHash: string;
  crawlKeyHash: string;
}

export function generateSiteSecrets(siteId: string, crawlSecret: string): SiteSecrets {
  const gateKey = generateGateKey();
  const crawlKey = deriveCrawlKey(siteId, crawlSecret);
  return {
    gateKey,
    crawlKey,
    verifyToken: generateVerifyToken(),
    gateKeyHash: sha256Hex(gateKey),
    crawlKeyHash: crawlKeyHash(crawlKey),
  };
}

/**
 * True when the body of `/.well-known/spigot.txt` carries `token`: the whole file trimmed, or any
 * one trimmed line of it (a publisher may keep other lines in the file). Exact match only.
 */
export function verifyBodyMatches(body: string, token: string): boolean {
  if (!token) return false;
  const text = body.replace(/^\uFEFF/, '');
  if (text.trim() === token) return true;
  return text.split(/\r?\n/).some((line) => line.trim() === token);
}
