import { createHash, createHmac } from 'node:crypto';

/**
 * The per-site crawl key `ck_…` our crawler sends as `X-Spigot-Key` (features/14 §Auth
 * boundaries). `sites` stores only its SHA-256 (`crawl_key_hash`), so the crawler can't read the
 * key back: it is **derived** from `SESSION_SECRET` and the site id instead. SP-008a generates the
 * key with `deriveCrawlKey` and stores `crawlKeyHash(key)`; rotating `SESSION_SECRET` rotates
 * every crawl key (the gate then sees the new hash on its next policy refresh).
 */

const PREFIX = 'ck_';

export function deriveCrawlKey(siteId: string, secret: string): string {
  if (!secret) throw new Error('deriveCrawlKey: secret is empty');
  const mac = createHmac('sha256', secret)
    .update(`spigot-crawl-key:v1:${siteId}`)
    .digest('base64url');
  return `${PREFIX}${mac}`;
}

/** SHA-256 hex: the value stored in `sites.crawl_key_hash` and sent to the gate. */
export function crawlKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
