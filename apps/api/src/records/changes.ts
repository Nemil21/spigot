// The changes feed reader (SP-015; features/05 §Logic 5 and 7, data-model rule 7). Reads
// `record_versions` in seq order, never past the dataset's `published_seq` watermark, strips
// hidden fields from patches and `include=record`, and skips changes that touched only hidden
// fields (so they are never returned or charged).
import type { Queryable } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { decodeChangesCursor, encodeChangesCursor } from './cursor.js';
import { HARD_MAX_LIMIT, type ServedDataset } from './query.js';
import {
  publicKey,
  serializeRecord,
  stripPatch,
  type PatchOp,
  type RecordRow,
  type ServedRecord,
} from './serialize.js';

/** Days of `record_versions` kept (features/05 §Logic 7); SP-019's retention job deletes older. */
export const CHANGES_RETENTION_DAYS = 30;
/** Batches scanned per call when hidden-only changes are skipped, so one call stays bounded. */
const MAX_SCAN_ROUNDS = 10;

export interface ReadChangesInput {
  /** Omitted → no changes, cursor at the watermark. `0` / `'0'` → full history. */
  since?: string | number | null;
  limit: number;
  includeRecord?: boolean;
}

export interface ServedChange {
  cursor: string;
  key: string;
  op: 'add' | 'update' | 'remove';
  version: number;
  patch: PatchOp[];
  changedAt: string;
  /** Present with `includeRecord`: the record now (visible fields only), null once removed. */
  record?: ServedRecord | null;
}

export interface ReadChangesResult {
  changes: ServedChange[];
  /** Always set: pass it back as `since` to continue. */
  next: string;
  hasMore: boolean;
}

interface VersionRow {
  seq: number;
  op: string;
  version: number;
  patch: unknown;
  changed_at: Date;
  record_key: string;
  record_id: string;
  data: unknown;
  record_version: number;
  updated_at: Date;
  crawled_at: Date | null;
  source_lastmod: Date | null;
  removed_at: Date | null;
  url: string | null;
}

function cursorExpired(): ApiError {
  return new ApiError(
    'CURSOR_EXPIRED',
    `This cursor is older than the ${CHANGES_RETENTION_DAYS}-day change history. Resync with /records, then start again without since.`,
    { retentionDays: CHANGES_RETENTION_DAYS },
  );
}

function parseSince(since: ReadChangesInput['since'], datasetId: string): number | null {
  if (since === undefined || since === null || since === '') return null;
  if (since === 0 || since === '0') return 0;
  return decodeChangesCursor(since, datasetId);
}

export async function readChanges(
  q: Queryable,
  ds: ServedDataset,
  input: ReadChangesInput,
): Promise<ReadChangesResult> {
  const { limit } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > HARD_MAX_LIMIT) {
    throw new ApiError('VALIDATION_ERROR', `limit must be an integer from 1 to ${HARD_MAX_LIMIT}.`);
  }
  const sinceSeq = parseSince(input.since, ds.id);

  // Read the watermark now rather than trusting `ds`: everything below stays <= this value,
  // and the row query re-checks it against the live column as well.
  const wm = await q.query<{ published_seq: number; last_seq: number | null }>(
    `SELECT d.published_seq,
            (SELECT max(v.seq) FROM record_versions v WHERE v.dataset_id = d.id AND v.seq <= d.published_seq) AS last_seq
       FROM datasets d WHERE d.id = $1`,
    [ds.id],
  );
  const watermark = wm.rows[0]?.published_seq ?? 0;

  if (sinceSeq === null) {
    // Start position: the dataset's last published change (a real row, so it can't look
    // expired later just because the watermark isn't one of ours), or 0 if there is none.
    return {
      changes: [],
      next: encodeChangesCursor(ds.id, wm.rows[0]?.last_seq ?? 0),
      hasMore: false,
    };
  }
  if (sinceSeq >= watermark) {
    return { changes: [], next: encodeChangesCursor(ds.id, sinceSeq), hasMore: false };
  }
  if (sinceSeq > 0) {
    // Every cursor we hand out (other than 0) is the seq of one of this dataset's changes. If
    // that change is past retention (or already purged), changes after it may be gone too.
    const at = await q.query<{ expired: boolean }>(
      `SELECT changed_at < now() - make_interval(days => $3) AS expired
         FROM record_versions WHERE seq = $1 AND dataset_id = $2`,
      [sinceSeq, ds.id, CHANGES_RETENTION_DAYS],
    );
    if (!at.rows[0] || at.rows[0].expired) throw cursorExpired();
  }

  const include = input.includeRecord === true;
  const ctx = { datasetSlug: ds.slug, fields: ds.fields, staleSince: ds.staleSince };
  const changes: ServedChange[] = [];
  let position = sinceSeq;
  let exhausted = false;

  for (let round = 0; round < MAX_SCAN_ROUNDS && changes.length < limit; round++) {
    const need = limit - changes.length;
    const { rows } = await q.query<VersionRow>(
      `SELECT v.seq, v.op, v.version, v.patch, v.changed_at,
              r.record_key, r.id AS record_id, r.data, r.version AS record_version, r.updated_at,
              r.crawled_at, r.source_lastmod, r.removed_at, pages.url
         FROM record_versions v
         JOIN records r ON r.id = v.record_id
         LEFT JOIN pages ON pages.id = r.page_id
        WHERE v.dataset_id = $1 AND v.seq > $2 AND v.seq <= $3
          AND v.seq <= (SELECT published_seq FROM datasets WHERE id = $1)
        ORDER BY v.seq
        LIMIT $4`,
      [ds.id, position, watermark, need],
    );
    for (const row of rows) {
      position = row.seq;
      const change = toChange(ds, row, include, ctx);
      if (change) changes.push(change);
    }
    if (rows.length < need) {
      exhausted = true;
      break;
    }
  }

  let hasMore = false;
  if (!exhausted) {
    const more = await q.query(
      `SELECT 1 FROM record_versions WHERE dataset_id = $1 AND seq > $2 AND seq <= $3 LIMIT 1`,
      [ds.id, position, watermark],
    );
    hasMore = more.rows.length > 0;
  }
  return { changes, next: encodeChangesCursor(ds.id, position), hasMore };
}

function toChange(
  ds: ServedDataset,
  row: VersionRow,
  include: boolean,
  ctx: { datasetSlug: string; fields: ServedDataset['fields']; staleSince: Date | null },
): ServedChange | null {
  if (row.op !== 'add' && row.op !== 'update' && row.op !== 'remove') return null;
  const patch = stripPatch(ds.fields, row.patch);
  // An update whose every op touched a hidden (or unknown) path: nothing to sell, so skip it.
  if (row.op === 'update' && patch.length === 0) return null;
  const change: ServedChange = {
    cursor: encodeChangesCursor(ds.id, row.seq),
    key: publicKey(ds.slug, row.record_key),
    op: row.op,
    version: row.version,
    patch,
    changedAt: row.changed_at.toISOString(),
  };
  if (include) {
    const rec: RecordRow = {
      id: row.record_id,
      record_key: row.record_key,
      data: row.data,
      version: row.record_version,
      updated_at: row.updated_at,
      crawled_at: row.crawled_at,
      source_lastmod: row.source_lastmod,
      url: row.url,
    };
    change.record = row.removed_at ? null : serializeRecord(ctx, rec);
  }
  return change;
}
