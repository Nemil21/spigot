import { createHash, createHmac } from 'node:crypto';

/**
 * The per-site crawl key `ck_…` our crawler sends as `X-Spigot-Key` (features/14 §Auth
 * boundaries). `sites` stores only its SHA-256 (`crawl_key_hash`), so the crawler can't read the
 * key back: it is **derived** from `SESSION_SECRET` and the site id instead. SP-008a generates the
 * key with `deriveCrawlKey` and stores `crawlKeyHash(key)`; rotating `SESSION_SECRET` rotates
 * every crawl key (the gate then sees the new hash on its next policy refresh).
 *
 * One site's key rotates with `sites.crawl_key_version` (SP-034, W16 Keys): the crawler derives
 * the key for the site's current version, so after a rotation it sends the new key and the old
 * one matches nothing. Version 1 is the original derivation (no suffix), so existing keys stay.
 */

const PREFIX = 'ck_';

export function deriveCrawlKey(siteId: string, secret: string, version = 1): string {
  if (!secret) throw new Error('deriveCrawlKey: secret is empty');
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`deriveCrawlKey: bad version ${version}`);
  }
  const input = `spigot-crawl-key:v1:${siteId}${version === 1 ? '' : `:${version}`}`;
  const mac = createHmac('sha256', secret).update(input).digest('base64url');
  return `${PREFIX}${mac}`;
}

/** SHA-256 hex: the value stored in `sites.crawl_key_hash` and sent to the gate. */
export function crawlKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
