import { withAdvisoryXactLock, type Db } from '../db/index.js';
import { normalizeUrl } from './normalizeUrl.js';
import type { SitemapEntry } from './sitemap.js';

/**
 * Keep `pages` in step with the sitemap (SP-009a1; features/03 §Logic 3.3.2, data-model §pages).
 *
 * - A URL not yet in `pages` is inserted with its `sitemap_lastmod` → `new`.
 * - A listed URL whose `sitemap_lastmod` differs, or that was removed and is listed again
 *   (`removed_at` cleared) → `changed`.
 * - A live page whose URL is no longer listed gets `removed_at = now()` → `removed`.
 *
 * Idempotent: the same list a second time changes nothing and returns zeros. One transaction,
 * serialized per site by the `pages:<siteId>` advisory lock, so two concurrent runs can't
 * interleave their removals. Pass the complete list: anything missing is marked removed.
 */

export interface UpsertPagesResult {
  new: number;
  changed: number;
  removed: number;
}

export async function upsertPages(
  db: Db,
  siteId: string,
  entries: readonly SitemapEntry[],
): Promise<UpsertPagesResult> {
  // Normalize and dedupe (first entry wins), so the statements below see each URL once.
  const byUrl = new Map<string, Date | null>();
  for (const e of entries) {
    const url = normalizeUrl(e.url);
    if (!byUrl.has(url)) byUrl.set(url, e.lastmod);
  }
  const urls = [...byUrl.keys()];
  const lastmods = [...byUrl.values()].map((d) => (d ? d.toISOString() : null));

  return db.tx(async (tx) => {
    await withAdvisoryXactLock(tx, `pages:${siteId}`);

    const inserted = await tx.query(
      `INSERT INTO pages (site_id, url, sitemap_lastmod)
       SELECT $1, u.url, u.lastmod
         FROM unnest($2::text[], $3::timestamptz[]) AS u(url, lastmod)
       ON CONFLICT (site_id, url) DO NOTHING`,
      [siteId, urls, lastmods],
    );

    const changed = await tx.query(
      `UPDATE pages p
          SET sitemap_lastmod = u.lastmod, removed_at = NULL, updated_at = now()
         FROM unnest($2::text[], $3::timestamptz[]) AS u(url, lastmod)
        WHERE p.site_id = $1
          AND p.url = u.url
          AND (p.sitemap_lastmod IS DISTINCT FROM u.lastmod OR p.removed_at IS NOT NULL)`,
      [siteId, urls, lastmods],
    );

    const removed = await tx.query(
      `UPDATE pages
          SET removed_at = now(), updated_at = now()
        WHERE site_id = $1
          AND removed_at IS NULL
          AND NOT (url = ANY($2::text[]))`,
      [siteId, urls],
    );

    return {
      new: inserted.rowCount ?? 0,
      changed: changed.rowCount ?? 0,
      removed: removed.rowCount ?? 0,
    };
  });
}
