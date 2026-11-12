// Serving records (SP-015; features/05 §Logic 4). Live rows only (`removed_at IS NULL`), filters
// from `filters.ts`, ordered `records.updated_at DESC, id` with a keyset cursor. Callers
// (SP-017a `paidRead` / `quote`) check the dataset status and clamp `limit` to
// `max_records_per_call` first; this layer only refuses limits outside 1..1,000.
import type { Queryable } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { decodeRecordsCursor, encodeRecordsCursor } from './cursor.js';
import { servedFields, type ServedField } from './fields.js';
import { filterSql, type FilterClause, type SortDirection } from './filters.js';
import { publicKey, serialize, type RecordRow, type ServedRecord } from './serialize.js';

/** data-model §datasets: `max_records_per_call` is capped at 1,000. */
export const HARD_MAX_LIMIT = 1000;

/** A dataset with its active schema reduced to the served-field allowlist. */
export interface ServedDataset {
  id: string;
  siteId: string;
  slug: string;
  typeName: string;
  status: string;
  /** Visible fields of the active schema; empty when nothing is approved yet. */
  fields: ServedField[];
  schemaVersion: number | null;
  staleSince: Date | null;
  publishedSeq: number;
  pricePerRecordMicros: number;
  pricePerChangeMicros: number;
  maxRecordsPerCall: number;
}

export async function loadServedDataset(
  q: Queryable,
  datasetId: string,
): Promise<ServedDataset | null> {
  const { rows } = await q.query<{
    id: string;
    site_id: string;
    slug: string;
    type_name: string;
    status: string;
    fields: unknown;
    schema_version: number | null;
    stale_since: Date | null;
    published_seq: number;
    price_per_record_micros: number;
    price_per_change_micros: number;
    max_records_per_call: number;
  }>(
    // Buyer-facing status, as `BUYER_STATUS_SQL` in services/lookup.ts: a dataset taken back by
    // demo:reset (PROPOSED with an active schema, SP-038) answers like an unpublished one.
    `SELECT d.id, d.site_id, d.slug, d.type_name,
            CASE WHEN d.status = 'PROPOSED' AND d.active_schema_id IS NOT NULL
              THEN 'UNPUBLISHED' ELSE d.status END AS status,
            sv.fields, sv.version AS schema_version,
            d.stale_since, d.published_seq, d.price_per_record_micros, d.price_per_change_micros,
            d.max_records_per_call
       FROM datasets d
       LEFT JOIN schema_versions sv ON sv.id = d.active_schema_id AND sv.dataset_id = d.id
      WHERE d.id = $1`,
    [datasetId],
  );
  const d = rows[0];
  if (!d) return null;
  return {
    id: d.id,
    siteId: d.site_id,
    slug: d.slug,
    typeName: d.type_name,
    status: d.status,
    fields: servedFields(d.fields),
    schemaVersion: d.schema_version,
    staleSince: d.stale_since,
    publishedSeq: d.published_seq,
    pricePerRecordMicros: d.price_per_record_micros,
    pricePerChangeMicros: d.price_per_change_micros,
    maxRecordsPerCall: d.max_records_per_call,
  };
}

export interface QueryRecordsInput {
  filters?: readonly FilterClause[];
  sort?: SortDirection;
  limit: number;
  cursor?: string | null;
}

export interface QueryRecordsResult {
  records: ServedRecord[];
  /** Cursor for the next page, or null when this was the last one. */
  next: string | null;
  /** Public key + stored hash of each record served (SP-017a passes these on for claims). */
  servedKeys: { key: string; hash: string }[];
}

function checkLimit(limit: number, what = 'limit'): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > HARD_MAX_LIMIT) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `${what} must be an integer from 1 to ${HARD_MAX_LIMIT}.`,
    );
  }
}

type Row = RecordRow & { hash: string; updated_at_key: string };

const SELECT_ROW = `
  SELECT records.id, records.record_key, records.data, records.version, records.hash,
         records.updated_at,
         to_char(records.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_key,
         records.crawled_at, records.source_lastmod, pages.url
    FROM records
    LEFT JOIN pages ON pages.id = records.page_id`;

/** `WHERE` conditions shared by the query and the count. */
function baseWhere(
  ds: ServedDataset,
  filters: readonly FilterClause[],
  params: unknown[],
): string[] {
  params.push(ds.id);
  return [
    `records.dataset_id = $${params.length}`,
    'records.removed_at IS NULL',
    ...filterSql(filters, ds.fields, params),
  ];
}

export async function queryRecords(
  q: Queryable,
  ds: ServedDataset,
  input: QueryRecordsInput,
): Promise<QueryRecordsResult> {
  checkLimit(input.limit);
  const sort = input.sort ?? 'desc';
  const params: unknown[] = [];
  const where = baseWhere(ds, input.filters ?? [], params);

  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    const pos = decodeRecordsCursor(input.cursor, ds.id, sort);
    params.push(pos.updatedAt, pos.id);
    const [u, i] = [`$${params.length - 1}::timestamptz`, `$${params.length}::uuid`];
    // DESC: updated_at DESC, id ASC. ASC is its exact reverse (updated_at ASC, id DESC), so both
    // walk the (dataset_id, updated_at DESC, id) index.
    where.push(
      sort === 'desc'
        ? `(records.updated_at < ${u} OR (records.updated_at = ${u} AND records.id > ${i}))`
        : `(records.updated_at > ${u} OR (records.updated_at = ${u} AND records.id < ${i}))`,
    );
  }
  const order =
    sort === 'desc'
      ? 'records.updated_at DESC, records.id ASC'
      : 'records.updated_at ASC, records.id DESC';
  params.push(input.limit + 1);
  const { rows } = await q.query<Row>(
    `${SELECT_ROW} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const next =
    rows.length > input.limit && last
      ? encodeRecordsCursor({ datasetId: ds.id, updatedAt: last.updated_at_key, id: last.id, sort })
      : null;
  return {
    records: serialize(
      { datasetSlug: ds.slug, fields: ds.fields, staleSince: ds.staleSince },
      page,
    ),
    next,
    servedKeys: page.map((r) => ({ key: publicKey(ds.slug, r.record_key), hash: r.hash })),
  };
}

/** Matching live records, counting at most `cap` (quotes: the count is capped at `limit`). */
export async function countRecords(
  q: Queryable,
  ds: ServedDataset,
  filters: readonly FilterClause[],
  cap: number,
): Promise<number> {
  checkLimit(cap, 'limit');
  const params: unknown[] = [];
  const where = baseWhere(ds, filters, params);
  params.push(cap);
  const { rows } = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM records WHERE ${where.join(' AND ')} LIMIT $${params.length}) s`,
    params,
  );
  return rows[0]?.n ?? 0;
}

const MAX_KEY_LENGTH = 1024;

/**
 * One live record by its public key (`<dataset-slug>/<stored key>`; a bare stored key works
 * too). Removed or unknown → null.
 */
export async function getRecord(
  q: Queryable,
  ds: ServedDataset,
  key: string,
): Promise<{ record: ServedRecord; hash: string } | null> {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new ApiError('VALIDATION_ERROR', 'Invalid record key.');
  }
  const prefix = `${ds.slug}/`;
  const stored = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const { rows } = await q.query<Row>(
    `${SELECT_ROW}
      WHERE records.dataset_id = $1 AND records.record_key = $2 AND records.removed_at IS NULL`,
    [ds.id, stored],
  );
  const row = rows[0];
  if (!row) return null;
  const [record] = serialize(
    { datasetSlug: ds.slug, fields: ds.fields, staleSince: ds.staleSince },
    [row],
  );
  return { record: record!, hash: row.hash };
}
