// `GET /v1/:site/datasets/:dataset/quote` and MCP `quote` (api.md; SP-017a). Free. Shares the
// request normalization with `paidRead`, so a quote counts exactly the rows the paid call would
// return (same filters, same clamped limit, same cursor) and prices them with the same unit.
import { formatMicros } from '@spigot/shared';
import type { Queryable } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import {
  parseFilterList,
  parseQueryFilters,
  parseSort,
  type FilterClause,
  type SortDirection,
} from '../records/filters.js';
import {
  countRecords,
  HARD_MAX_LIMIT,
  loadServedDataset,
  queryRecords,
  type ServedDataset,
} from '../records/query.js';
import { priceMicros } from '../meter/quote.js';
import { balance, wouldAutoTopUp } from './balance.js';
import { requireSold, resolveDataset, type ResolvedDataset } from './lookup.js';

export type ReadKind = 'records' | 'record' | 'changes';

/** REST passes its flat querystring; MCP passes `[{field, op, value}]`. Both parse the same way. */
export type FiltersInput = Record<string, unknown> | readonly unknown[];

export interface ReadParams {
  site: string;
  dataset: string;
  kind: ReadKind;
  filters?: FiltersInput;
  /** `-updated_at` (default) or `updated_at`. Records only. */
  sort?: unknown;
  /** Records: default 50, clamped to `max_records_per_call`. Changes: default 200, max 1,000. */
  limit?: unknown;
  /** Records: the keyset cursor. Changes: `since` (omitted = start at the watermark, `0` = all). */
  cursor?: string | number | null;
  /** `kind: 'record'`: the public record key. */
  key?: string;
  /** Changes: `include=record`. */
  includeRecord?: boolean;
}

export const DEFAULT_RECORDS_LIMIT = 50;
export const DEFAULT_CHANGES_LIMIT = 200;
export const QUOTE_VALID_FOR_SECONDS = 60;

/** A request after validation against the dataset: what runs, and what gets hashed. */
export interface NormalizedRead {
  kind: ReadKind;
  filters: FilterClause[];
  sort: SortDirection;
  /** Effective limit: the default when omitted, clamped by the dataset. Runs the query. */
  limit: number;
  /**
   * The limit the client sent (null when omitted), unclamped. This is what gets hashed: an
   * owner changing `max_records_per_call` mustn't turn a retry of the same request into a 409.
   */
  requestedLimit: number | null;
  cursor: string | number | null;
  key: string | null;
  includeRecord: boolean;
}

function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ApiError('VALIDATION_ERROR', 'limit must be a positive integer.');
  }
  return n;
}

function parseFilters(input: FiltersInput | undefined, ds: ServedDataset): FilterClause[] {
  if (input === undefined || input === null) return [];
  return Array.isArray(input)
    ? parseFilterList(input, ds.fields)
    : parseQueryFilters(input as Record<string, unknown>, ds.fields);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Validates `p` against the served dataset and fixes every default, so equal reads hash equal. */
export function normalizeRead(p: ReadParams, ds: ServedDataset): NormalizedRead {
  const kind = p.kind;
  if (kind !== 'records' && kind !== 'record' && kind !== 'changes') {
    throw new ApiError('VALIDATION_ERROR', 'kind must be records, record or changes.');
  }
  const filters = kind === 'records' ? parseFilters(p.filters, ds) : [];
  // Filter order doesn't change the result, so it mustn't change the idempotency hash either.
  filters.sort((a, b) =>
    cmp(
      `${a.field}\0${a.op}\0${JSON.stringify(a.value)}`,
      `${b.field}\0${b.op}\0${JSON.stringify(b.value)}`,
    ),
  );
  const requestedLimit = kind === 'record' ? null : parseLimit(p.limit);
  const limit =
    kind === 'records'
      ? Math.min(requestedLimit ?? DEFAULT_RECORDS_LIMIT, ds.maxRecordsPerCall)
      : kind === 'changes'
        ? Math.min(requestedLimit ?? DEFAULT_CHANGES_LIMIT, HARD_MAX_LIMIT)
        : 1;
  if (kind === 'record' && (typeof p.key !== 'string' || p.key.length === 0)) {
    throw new ApiError('VALIDATION_ERROR', 'A record key is required.');
  }
  const cursor = p.cursor === undefined || p.cursor === '' ? null : p.cursor;
  return {
    kind,
    filters,
    sort: kind === 'records' ? parseSort(p.sort) : 'desc',
    limit,
    requestedLimit,
    cursor: kind === 'record' ? null : cursor,
    key: kind === 'record' ? (p.key as string) : null,
    includeRecord: kind === 'changes' && p.includeRecord === true,
  };
}

/** The unit price for `kind`, read from the dataset row loaded for this call (the snapshot). */
export function unitPriceMicros(ds: ServedDataset, kind: ReadKind): number {
  return kind === 'changes' ? ds.pricePerChangeMicros : ds.pricePerRecordMicros;
}

/** Resolve + status check + load the served dataset (the allowlisted active schema). */
export async function loadSoldDataset(
  q: Queryable,
  site: string,
  dataset: string,
): Promise<{ resolved: ResolvedDataset; ds: ServedDataset }> {
  const resolved = await resolveDataset(q, site, dataset);
  requireSold(resolved.status);
  const ds = await loadServedDataset(q, resolved.datasetId);
  if (!ds) throw new ApiError('NOT_FOUND', 'No such dataset.');
  // Re-check on the row we'll actually use: an unpublish between the two reads is a 410 too.
  requireSold(ds.status);
  return { resolved, ds };
}

export interface Quote {
  records: number;
  unitPriceMicros: number;
  priceMicros: number;
  /** "$0.0555" */
  display: string;
  balanceMicros: number;
  wouldAutoTopUp: boolean;
  /** A hint only: the call is charged at the price when it runs (features/06 §Edge cases). */
  validForSeconds: number;
}

export interface QuoteParams extends Omit<ReadParams, 'kind' | 'key' | 'includeRecord'> {
  kind?: 'records';
}

/**
 * Prices a records query without running it: a count capped at the (clamped) limit. With a
 * cursor, the count must start there, so the page itself is read (still free).
 */
export async function quote(
  ctx: { db: Queryable; buyerId: string },
  params: QuoteParams,
): Promise<Quote> {
  const { ds } = await loadSoldDataset(ctx.db, params.site, params.dataset);
  const req = normalizeRead({ ...params, kind: 'records' }, ds);
  const records =
    req.cursor === null
      ? await countRecords(ctx.db, ds, req.filters, req.limit)
      : (
          await queryRecords(ctx.db, ds, {
            filters: req.filters,
            sort: req.sort,
            limit: req.limit,
            cursor: String(req.cursor),
          })
        ).records.length;
  const unit = unitPriceMicros(ds, 'records');
  const price = priceMicros(records, unit);
  const b = await balance(ctx, ctx.buyerId);
  return {
    records,
    unitPriceMicros: unit,
    priceMicros: price,
    display: formatMicros(price),
    balanceMicros: b.balanceMicros,
    wouldAutoTopUp: wouldAutoTopUp(b, price),
    validForSeconds: QUOTE_VALID_FOR_SECONDS,
  };
}
