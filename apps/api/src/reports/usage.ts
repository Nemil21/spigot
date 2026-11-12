import type pg from 'pg';
import { z } from 'zod';
import { ApiError } from '../http/errors.js';
import { isUuid } from '../tenancy.js';
import {
  decodeCursor,
  encodeCursor,
  PG_UTC_MICROS,
  rangeSql,
  UTC_MICROS,
  type Range,
} from './query.js';

/**
 * Buyer usage (api.md §`GET /api/buyer/usage?from&to`; W12): the signed-in buyer's own
 * `api_calls`, newest first, `USAGE_BLOCK` per page; and one call (`GET /api/buyer/calls/:id`).
 * Every query filters on the session buyer id; another buyer's call id is a 404.
 *
 * Replays never create a row (the stored response is returned from the original call), so the
 * "replay flag" is `replayable`: the stored response is still held, so retrying with the same
 * Idempotency-Key returns it again free of charge.
 */

export const USAGE_BLOCK = 100;

export interface UsageRow {
  id: string;
  time: string;
  dataset: { id: string; site: string; slug: string } | null;
  endpoint: string | null;
  channel: 'REST' | 'MCP';
  status: string;
  records: number | null;
  changes: number | null;
  /** What this call cost (0 unless it was charged). */
  chargedMicros: number;
  creditedMicros: number;
  replayable: boolean;
  isSimulated: boolean;
}

export interface UsagePage {
  rows: UsageRow[];
  nextCursor: string | null;
}

export interface CallDetail extends UsageRow {
  unitPriceMicros: number | null;
  httpStatus: number | null;
  idempotencyKey: string;
  /** Keys + content hashes of the records served (for "Report a bad record"). */
  servedRecords: { key: string; hash: string }[];
}

export interface UsageQuery extends Range {
  buyerId: string;
  cursor?: string;
}

const cursorSchema = z.strictObject({
  t: z.string().regex(UTC_MICROS),
  i: z.string().refine(isUuid),
});

const ROW_COLUMNS = `
  c.id, to_char(c.created_at AT TIME ZONE 'UTC', ${PG_UTC_MICROS}) AS "timeKey", c.created_at AS time,
  c.dataset_id AS "datasetId", coalesce(s.slug, s.origin) AS "siteSlug", d.slug AS "datasetSlug",
  c.endpoint, c.channel, c.status, c.records_returned AS records, c.changes_returned AS changes,
  CASE WHEN c.charge_txn_id IS NOT NULL THEN c.price_micros ELSE 0 END AS "chargedMicros",
  c.credited_micros AS "creditedMicros",
  (c.response_body IS NOT NULL AND c.status IN ('CHARGED', 'PARTIALLY_CREDITED', 'CREDITED', 'NOT_CHARGED'))
    AS replayable,
  c.is_simulated AS "isSimulated"`;

const FROM = `
  FROM api_calls c
  LEFT JOIN datasets d ON d.id = c.dataset_id
  LEFT JOIN sites s ON s.id = d.site_id`;

interface RawRow {
  id: string;
  timeKey: string;
  time: Date;
  datasetId: string | null;
  siteSlug: string | null;
  datasetSlug: string | null;
  endpoint: string | null;
  channel: 'REST' | 'MCP';
  status: string;
  records: number | null;
  changes: number | null;
  chargedMicros: number;
  creditedMicros: number;
  replayable: boolean;
  isSimulated: boolean;
}

function toRow(r: RawRow): UsageRow {
  return {
    id: r.id,
    time: r.time.toISOString(),
    dataset:
      r.datasetId && r.datasetSlug
        ? { id: r.datasetId, site: r.siteSlug ?? '', slug: r.datasetSlug }
        : null,
    endpoint: r.endpoint,
    channel: r.channel,
    status: r.status,
    records: r.records,
    changes: r.changes,
    chargedMicros: r.chargedMicros,
    creditedMicros: r.creditedMicros,
    replayable: r.replayable,
    isSimulated: r.isSimulated,
  };
}

export async function buyerUsage(pool: pg.Pool, q: UsageQuery): Promise<UsagePage> {
  const params: unknown[] = [q.buyerId];
  const range = rangeSql('c.created_at', q, params);
  let after = '';
  if (q.cursor !== undefined) {
    const c = decodeCursor(cursorSchema, q.cursor);
    params.push(c.t, c.i);
    after = `AND (c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(USAGE_BLOCK + 1);
  const { rows } = await pool.query<RawRow>(
    `SELECT ${ROW_COLUMNS} ${FROM}
     WHERE c.buyer_id = $1 AND c.hidden_at IS NULL AND ${range} ${after}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const more = rows.length > USAGE_BLOCK;
  const page = more ? rows.slice(0, USAGE_BLOCK) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map(toRow),
    nextCursor: more && last ? encodeCursor({ t: last.timeKey, i: last.id }) : null,
  };
}

const notFound = () => new ApiError('NOT_FOUND', 'No such call.');

/** One of the buyer's own calls, or `404 NOT_FOUND` (never confirms another buyer's ids). */
export async function buyerCall(pool: pg.Pool, buyerId: string, id: string): Promise<CallDetail> {
  if (!isUuid(id)) throw notFound();
  const { rows } = await pool.query<
    RawRow & {
      unitPriceMicros: number | null;
      httpStatus: number | null;
      idempotencyKey: string;
      servedRecords: unknown;
    }
  >(
    `SELECT ${ROW_COLUMNS}, c.unit_price_micros AS "unitPriceMicros", c.http_status AS "httpStatus",
            c.idempotency_key AS "idempotencyKey", c.served_record_keys AS "servedRecords"
     ${FROM}
     WHERE c.id = $1 AND c.buyer_id = $2 AND c.hidden_at IS NULL`,
    [id, buyerId],
  );
  const r = rows[0];
  if (!r) throw notFound();
  const served = Array.isArray(r.servedRecords)
    ? (r.servedRecords as { key: unknown; hash: unknown }[])
        .filter((k) => typeof k?.key === 'string' && typeof k?.hash === 'string')
        .map((k) => ({ key: k.key as string, hash: k.hash as string }))
    : [];
  return {
    ...toRow(r),
    unitPriceMicros: r.unitPriceMicros,
    httpStatus: r.httpStatus,
    idempotencyKey: r.idempotencyKey,
    servedRecords: served,
  };
}
