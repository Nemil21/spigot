// Resolving `/:site/datasets/:dataset` for the paid-read services (SP-017a). One query: the
// dataset row (any status), the site's display name, and the site's sold datasets for 402 bodies.
import { DATASET_UNPUBLISHED_MESSAGE } from '@spigot/shared';
import type { Queryable } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import type { Site402, SiteDataset402 } from './payment402.js';

/** Only these are sold (data-model §Dataset states). */
export const SOLD_STATUSES = ['LIVE', 'LIVE_STALE'] as const;

/**
 * The dataset status buyers see, as SQL over `datasets d`. A PROPOSED dataset that still has an
 * active schema was sold before and taken back by `demo:reset` (SP-038's DEMO_RESET transition):
 * it answers like an unpublished one (410) until the owner re-approves it. A dataset that was
 * never approved has no active schema and stays a 404.
 */
export const BUYER_STATUS_SQL = `CASE WHEN d.status = 'PROPOSED' AND d.active_schema_id IS NOT NULL
  THEN 'UNPUBLISHED' ELSE d.status END`;

/** Cheap shape check before SQL (values are parameters anyway); generous for dataset slugs. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export interface ResolvedDataset {
  datasetId: string;
  status: string;
  site: Site402;
}

/**
 * Site name: `sites` has no name column, so the publisher's account name stands in (the demo
 * publisher is "Bluebonnet Rentals"); the slug when that's empty.
 */
const SITE_DATASETS = `
  coalesce((
    SELECT json_agg(json_build_object(
             'slug', d2.slug, 'type', d2.type_name, 'records', d2.record_count,
             'perRecordMicros', d2.price_per_record_micros) ORDER BY d2.slug)
      FROM datasets d2
     WHERE d2.site_id = s.id AND d2.status IN ('LIVE', 'LIVE_STALE')
  ), '[]'::json)`;

interface SiteRow {
  site_id: string;
  site_slug: string;
  site_name: string | null;
  site_datasets: SiteDataset402[];
}

function notFound(): ApiError {
  return new ApiError('NOT_FOUND', 'No such dataset.');
}

/** The site's 402 facts by slug, or null for an unknown site. */
export async function loadSite402(q: Queryable, siteSlug: string): Promise<Site402 | null> {
  if (typeof siteSlug !== 'string' || !SLUG.test(siteSlug)) return null;
  const { rows } = await q.query<SiteRow>(
    `SELECT s.id AS site_id, s.slug AS site_slug, nullif(p.name, '') AS site_name, ${SITE_DATASETS} AS site_datasets
       FROM sites s JOIN publishers p ON p.id = s.publisher_id
      WHERE s.slug = $1`,
    [siteSlug],
  );
  const r = rows[0];
  return r ? { slug: r.site_slug, name: r.site_name, datasets: r.site_datasets } : null;
}

/**
 * `site/dataset` → the dataset, whatever its status. Unknown → `404 NOT_FOUND`. The status check
 * is the caller's (`requireSold`), because idempotent replays come first (features/06).
 */
export async function resolveDataset(
  q: Queryable,
  siteSlug: string,
  datasetSlug: string,
): Promise<ResolvedDataset> {
  if (
    typeof siteSlug !== 'string' ||
    typeof datasetSlug !== 'string' ||
    !SLUG.test(siteSlug) ||
    !SLUG.test(datasetSlug)
  ) {
    throw notFound();
  }
  const { rows } = await q.query<SiteRow & { dataset_id: string; status: string }>(
    `SELECT d.id AS dataset_id, ${BUYER_STATUS_SQL} AS status, s.id AS site_id, s.slug AS site_slug,
            nullif(p.name, '') AS site_name, ${SITE_DATASETS} AS site_datasets
       FROM sites s
       JOIN publishers p ON p.id = s.publisher_id
       JOIN datasets d ON d.site_id = s.id AND d.slug = $2
      WHERE s.slug = $1`,
    [siteSlug, datasetSlug],
  );
  const r = rows[0];
  if (!r) throw notFound();
  return {
    datasetId: r.dataset_id,
    status: r.status,
    site: { slug: r.site_slug, name: r.site_name, datasets: r.site_datasets },
  };
}

/**
 * A dataset must be LIVE / LIVE_STALE to be read or quoted. UNPUBLISHED → `410
 * DATASET_UNPUBLISHED`; never published (PROPOSED, REJECTED) → `404`, so a proposal's existence
 * doesn't leak.
 */
export function requireSold(status: string): void {
  if ((SOLD_STATUSES as readonly string[]).includes(status)) return;
  if (status === 'UNPUBLISHED') {
    throw new ApiError('DATASET_UNPUBLISHED', DATASET_UNPUBLISHED_MESSAGE);
  }
  throw notFound();
}
