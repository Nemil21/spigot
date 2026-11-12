// `GET /v1/:site/datasets/:dataset` and MCP `describe_dataset` (api.md; SP-017a). Free: the
// visible fields of the active schema with their filter ops, pricing, freshness and licence.
import { formatPer1000, type FieldType } from '@spigot/shared';
import type { Queryable } from '../db/pool.js';
import type { FilterOp } from '../records/fields.js';
import { UPDATED_AT, UPDATED_AT_OPS } from '../records/filters.js';
import { loadServedDataset } from '../records/query.js';
import { links402 } from './payment402.js';
import { requireSold, resolveDataset } from './lookup.js';

export interface DescribedField {
  name: string;
  type: FieldType;
  description?: string;
  filterable: FilterOp[];
}

export interface DatasetDescription {
  type: string;
  version: number | null;
  records: number;
  fields: DescribedField[];
  pricing: { perRecordMicros: number; perChangeMicros: number; display: string };
  maxRecordsPerCall: number;
  freshness: { lastCrawlAt: string | null; staleSince: string | null };
  license: string;
}

export async function describe(
  deps: { db: Queryable; baseUrl: string },
  siteSlug: string,
  datasetSlug: string,
): Promise<DatasetDescription> {
  const resolved = await resolveDataset(deps.db, siteSlug, datasetSlug);
  requireSold(resolved.status);
  const ds = await loadServedDataset(deps.db, resolved.datasetId);
  if (!ds) throw new Error(`describe: dataset ${resolved.datasetId} vanished`);
  requireSold(ds.status);

  const extra = await deps.db.query<{ records: number; last_crawl_at: Date | null }>(
    `SELECT d.record_count AS records,
            (SELECT max(cr.finished_at) FROM crawl_runs cr
              WHERE cr.site_id = d.site_id AND cr.status IN ('SUCCEEDED', 'PARTIAL')) AS last_crawl_at
       FROM datasets d WHERE d.id = $1`,
    [ds.id],
  );

  // Visible fields only (the served allowlist), then `updated_at`, which is always filterable.
  const fields: DescribedField[] = ds.fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.description === undefined ? {} : { description: f.description }),
    filterable: [...f.filterable],
  }));
  if (!fields.some((f) => f.name === UPDATED_AT)) {
    fields.push({ name: UPDATED_AT, type: 'datetime', filterable: [...UPDATED_AT_OPS] });
  }

  const links = links402(deps.baseUrl, resolved.site.slug);
  return {
    type: ds.typeName,
    version: ds.schemaVersion,
    records: extra.rows[0]?.records ?? 0,
    fields,
    pricing: {
      perRecordMicros: ds.pricePerRecordMicros,
      perChangeMicros: ds.pricePerChangeMicros,
      display: formatPer1000(ds.pricePerRecordMicros),
    },
    maxRecordsPerCall: ds.maxRecordsPerCall,
    freshness: {
      lastCrawlAt: extra.rows[0]?.last_crawl_at?.toISOString() ?? null,
      staleSince: ds.staleSince?.toISOString() ?? null,
    },
    license: `${links.catalogUrl}/terms`,
  };
}
