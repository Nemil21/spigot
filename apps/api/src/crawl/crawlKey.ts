import { createHash, createHmac } from 'node:crypto';

/**
 * The per-site crawl key `ck_…` our crawler sends as `X-Spigot-Key` (features/14 §Auth
 * boundaries). `sites` stores only its SHA-256 (`crawl_key_hash`), so the crawler can't read the
 * key back: it is **derived** from `SESSION_SECRET` and the site id instead. SP-008a generates the
 * key with `deriveCrawlKey` and stores `crawlKeyHash(key)`; rotating `SESSION_SECRET` rotates
 * every crawl key (the gate then sees the new hash on its next policy refresh).
 *
 * One site's key rotates with `sites.crawl_key_version` (SP-034, W16 Keys). Version 1 is the
 * original derivation (no suffix), so existing keys stay. The crawler sends the key for
 * `sentCrawlKeyVersionSql`: the new version once the gate has pulled the policy carrying its hash,
 * and until then the previous one, which the gate still recognises (see 003_sp034 migration).
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

/**
 * SQL for the crawl-key version the crawler sends for the `sites` row aliased `a`: the current
 * version when no rotation is pending or the gate has pulled a policy at or after the rotation's
 * `policy_version`, else the previous version.
 */
export function sentCrawlKeyVersionSql(a: string): string {
  return `CASE WHEN ${a}.crawl_key_rotated_policy_version IS NULL
                 OR ${a}.gate_policy_version_seen >= ${a}.crawl_key_rotated_policy_version
               THEN ${a}.crawl_key_version
               ELSE coalesce(${a}.crawl_key_prev_version, ${a}.crawl_key_version) END`;
}

/** SHA-256 hex: the value stored in `sites.crawl_key_hash` and sent to the gate. */
export function crawlKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
