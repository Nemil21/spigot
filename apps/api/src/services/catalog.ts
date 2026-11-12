// `GET /v1/catalog` and MCP `list_datasets` (api.md §Buyer data API; SP-017a). Free, no key.
import type { Queryable } from '../db/pool.js';

export interface CatalogDataset {
  slug: string;
  type: string;
  records: number;
  perRecordMicros: number;
  perChangeMicros: number;
  freshness: { lastCrawlAt: string | null; staleSince: string | null };
}

export interface CatalogSite {
  slug: string;
  name: string;
  datasets: CatalogDataset[];
}

export interface Catalog {
  sites: CatalogSite[];
}

interface Row {
  site_slug: string;
  site_name: string | null;
  slug: string;
  type_name: string;
  record_count: number;
  price_per_record_micros: number;
  price_per_change_micros: number;
  stale_since: Date | null;
  last_crawl_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Every sold (LIVE / LIVE_STALE) dataset, grouped by site, sites and datasets by slug. Sites
 * without a slug have nothing on `/v1` and are skipped. `lastCrawlAt` is the site's last
 * finished crawl that fetched pages (SUCCEEDED or PARTIAL).
 */
export async function catalog(q: Queryable, opts: { site?: string } = {}): Promise<Catalog> {
  // `opts.site` narrows to one site (W13's `/c/:site` JSON variant, SP-033); same shape.
  const { rows } = await q.query<Row>(
    `SELECT s.slug AS site_slug, nullif(p.name, '') AS site_name, d.slug, d.type_name, d.record_count,
            d.price_per_record_micros, d.price_per_change_micros, d.stale_since,
            (SELECT max(cr.finished_at) FROM crawl_runs cr
              WHERE cr.site_id = s.id AND cr.status IN ('SUCCEEDED', 'PARTIAL')) AS last_crawl_at
       FROM datasets d
       JOIN sites s ON s.id = d.site_id
       JOIN publishers p ON p.id = s.publisher_id
      WHERE d.status IN ('LIVE', 'LIVE_STALE') AND s.slug IS NOT NULL
        AND ($1::text IS NULL OR s.slug = $1)
      ORDER BY s.slug, d.slug`,
    [opts.site ?? null],
  );
  const sites: CatalogSite[] = [];
  for (const r of rows) {
    let site = sites[sites.length - 1];
    if (!site || site.slug !== r.site_slug) {
      site = { slug: r.site_slug, name: r.site_name ?? r.site_slug, datasets: [] };
      sites.push(site);
    }
    site.datasets.push({
      slug: r.slug,
      type: r.type_name,
      records: r.record_count,
      perRecordMicros: r.price_per_record_micros,
      perChangeMicros: r.price_per_change_micros,
      freshness: { lastCrawlAt: iso(r.last_crawl_at), staleSince: iso(r.stale_since) },
    });
  }
  return { sites };
}
