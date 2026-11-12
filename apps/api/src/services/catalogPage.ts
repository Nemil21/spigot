// W13 public catalog page `/c/:site` (screens.md §W13, features/16 §Catalog page; SP-033). Free,
// no login. Everything the HTML page shows about one site; the JSON variant is `catalog()`.
import type { FieldType } from '@spigot/shared';
import type { Queryable } from '../db/pool.js';
import { servedFields } from '../records/fields.js';
import { SOLD_STATUSES } from './lookup.js';

/** Same shape check as `lookup.ts`, so a junk slug never reaches SQL. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export interface CatalogPageDataset {
  slug: string;
  type: string;
  records: number;
  perRecordMicros: number;
  perChangeMicros: number;
  /** Visible fields only (the served allowlist), in schema order. */
  fields: { name: string; type: FieldType }[];
  lastCrawlAt: Date | null;
  /** Set when the dataset is LIVE_STALE. */
  staleSince: Date | null;
}

export interface CatalogPageSite {
  slug: string;
  /** Display name ("Bluebonnet Rentals"); the slug when the publisher has none. */
  name: string;
  paused: boolean;
  /** LIVE / LIVE_STALE datasets, by slug. */
  datasets: CatalogPageDataset[];
  /** True when nothing is sold now but something was (every dataset UNPUBLISHED). */
  unpublished: boolean;
}

interface SiteRow {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  unpublished: number;
}

interface DatasetRow {
  slug: string;
  type_name: string;
  record_count: number;
  price_per_record_micros: string | number;
  price_per_change_micros: string | number;
  stale_since: Date | null;
  fields: unknown;
  last_crawl_at: Date | null;
}

/** One site's catalog page, or null for an unknown slug (or a site with no slug yet). */
export async function loadCatalogPage(
  q: Queryable,
  siteSlug: string,
): Promise<CatalogPageSite | null> {
  if (typeof siteSlug !== 'string' || !SLUG.test(siteSlug)) return null;
  const { rows: sites } = await q.query<SiteRow>(
    `SELECT s.id, s.slug, nullif(p.name, '') AS name, s.status,
            (SELECT count(*)::int FROM datasets d
              WHERE d.site_id = s.id AND d.status = 'UNPUBLISHED') AS unpublished
       FROM sites s JOIN publishers p ON p.id = s.publisher_id
      WHERE s.slug = $1`,
    [siteSlug],
  );
  const site = sites[0];
  if (!site) return null;

  const { rows } = await q.query<DatasetRow>(
    `SELECT d.slug, d.type_name, d.record_count, d.price_per_record_micros,
            d.price_per_change_micros, d.stale_since, sv.fields,
            (SELECT max(cr.finished_at) FROM crawl_runs cr
              WHERE cr.site_id = d.site_id AND cr.status IN ('SUCCEEDED', 'PARTIAL')) AS last_crawl_at
       FROM datasets d
       LEFT JOIN schema_versions sv ON sv.id = d.active_schema_id
      WHERE d.site_id = $1 AND d.status = ANY($2::text[])
      ORDER BY d.slug`,
    [site.id, [...SOLD_STATUSES]],
  );

  const datasets = rows.map<CatalogPageDataset>((r) => ({
    slug: r.slug,
    type: r.type_name,
    records: r.record_count,
    perRecordMicros: Number(r.price_per_record_micros),
    perChangeMicros: Number(r.price_per_change_micros),
    fields: servedFields(r.fields).map((f) => ({ name: f.name, type: f.type })),
    lastCrawlAt: r.last_crawl_at,
    staleSince: r.stale_since,
  }));

  return {
    slug: site.slug,
    name: site.name ?? site.slug,
    paused: site.status === 'PAUSED',
    datasets,
    unpublished: datasets.length === 0 && site.unpublished > 0,
  };
}
