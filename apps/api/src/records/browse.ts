// W07 Records browser (SP-053; screens.md §W07, features/05, features/13 §Screens). The owner's
// view of their own records: every schema field, hidden ones included (they are the owner's data
// and the screen marks them), filtered and sorted server-side for AG Grid's server-side row model.
//
// This is never a buyer path. Buyers read through `query.ts`, which only knows visible fields and
// only sorts by `updated_at`. Here the column allowlist is the dataset's schema: a column id is
// either a fixed meta column or `data.<field>` for a field that parses with SP-011's
// `fieldNameSchema`, and the SQL for a field always goes through `fieldExpr` (or `data->>'f'` for
// text matching). Nothing from the request reaches SQL except as a typed parameter.
import { z } from 'zod';
import { fieldNameSchema, fieldTypeSchema, type FieldType } from '@spigot/shared';
import type { Queryable } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { fieldExpr } from './filters.js';

/** AG Grid `cacheBlockSize`: one request never returns more than this. */
export const BLOCK_SIZE = 100;
/** Deepest offset a browser request may ask for (a dataset is a few thousand records). */
export const MAX_START_ROW = 1_000_000;
const MAX_SORTS = 3;
const MAX_FILTERS = 30;
const MAX_TEXT = 200;
/** Versions returned per record, newest first (retention keeps 30 days anyway). */
export const MAX_VERSIONS = 100;

export interface OwnerField {
  name: string;
  type: FieldType;
  /** False = never sold; W07 shows it to the owner, marked hidden. */
  visible: boolean;
  pii: boolean;
}

const storedField = z.object({
  name: fieldNameSchema,
  type: fieldTypeSchema,
  visible: z.unknown().optional(),
  pii: z.unknown().optional(),
});

/**
 * Every field of a stored schema, in schema order. Unparseable entries and duplicate names are
 * dropped (their names can't be trusted to reach SQL); `visible` is true only when it is `true`,
 * matching `servedFields`.
 */
export function ownerFields(stored: unknown): OwnerField[] {
  if (!Array.isArray(stored)) return [];
  const parsed = stored.map((f) => storedField.safeParse(f));
  const counts = new Map<string, number>();
  for (const p of parsed)
    if (p.success) counts.set(p.data.name, (counts.get(p.data.name) ?? 0) + 1);
  const out: OwnerField[] = [];
  for (const p of parsed) {
    if (!p.success || counts.get(p.data.name) !== 1) continue;
    out.push({
      name: p.data.name,
      type: p.data.type,
      visible: p.data.visible === true,
      pii: p.data.pii === true,
    });
  }
  return out;
}

/** The schema the browser shows: the active (served) one, else the newest version. */
export async function loadOwnerFields(q: Queryable, datasetId: string): Promise<OwnerField[]> {
  const { rows } = await q.query<{ fields: unknown }>(
    `SELECT sv.fields FROM datasets d
       JOIN schema_versions sv ON sv.dataset_id = d.id
      WHERE d.id = $1
      ORDER BY (sv.id = d.active_schema_id) DESC NULLS LAST, sv.version DESC
      LIMIT 1`,
    [datasetId],
  );
  return ownerFields(rows[0]?.fields);
}

// --- columns -----------------------------------------------------------------------------------

type FilterKind = 'text' | 'number' | 'date';

interface Column {
  /** Typed expression for sort and number / date filters. */
  expr: string;
  /** Text expression for text filters. */
  text: string;
  kind: FilterKind;
  /** Timestamp column (vs. ISO text): date bounds are cast to timestamptz. */
  timestamp: boolean;
}

const META: Record<string, Column> = {
  key: { expr: 'records.record_key', text: 'records.record_key', kind: 'text', timestamp: false },
  version: {
    expr: 'records.version',
    text: 'records.version::text',
    kind: 'number',
    timestamp: false,
  },
  updatedAt: { expr: 'records.updated_at', text: '', kind: 'date', timestamp: true },
  crawledAt: { expr: 'records.crawled_at', text: '', kind: 'date', timestamp: true },
  sourceLastmod: { expr: 'records.source_lastmod', text: '', kind: 'date', timestamp: true },
};

export const FIELD_COL_PREFIX = 'data.';

function kindOf(type: FieldType): FilterKind {
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'date' || type === 'datetime') return 'date';
  return 'text';
}

function fieldColumn(f: OwnerField): Column {
  const text = fieldExpr(f.name, 'string');
  const kind = kindOf(f.type);
  // `string[]` and booleans have no ordered `fieldExpr`; they sort and match as text.
  const expr = kind === 'text' ? text : fieldExpr(f.name, f.type);
  return { expr, text, kind, timestamp: false };
}

function column(colId: unknown, fields: readonly OwnerField[]): Column {
  if (typeof colId === 'string') {
    if (Object.hasOwn(META, colId)) return META[colId]!;
    if (colId.startsWith(FIELD_COL_PREFIX)) {
      const f = fields.find((x) => x.name === colId.slice(FIELD_COL_PREFIX.length));
      if (f) return fieldColumn(f);
    }
  }
  throw new ApiError(
    'VALIDATION_ERROR',
    `Unknown column ${JSON.stringify(String(colId).slice(0, 80))}.`,
  );
}

// --- request parsing ---------------------------------------------------------------------------

export interface SortItem {
  colId: string;
  sort: 'asc' | 'desc';
}

const sortModelSchema = z
  .array(z.object({ colId: z.string().max(100), sort: z.enum(['asc', 'desc']) }))
  .max(MAX_SORTS);

const textCond = z.object({
  filterType: z.literal('text'),
  type: z.enum([
    'contains',
    'notContains',
    'equals',
    'notEqual',
    'startsWith',
    'endsWith',
    'blank',
    'notBlank',
  ]),
  filter: z.union([z.string().max(MAX_TEXT), z.number()]).nullish(),
});
const numberCond = z.object({
  filterType: z.literal('number'),
  type: z.enum([
    'equals',
    'notEqual',
    'lessThan',
    'lessThanOrEqual',
    'greaterThan',
    'greaterThanOrEqual',
    'inRange',
    'blank',
    'notBlank',
  ]),
  filter: z.number().finite().nullish(),
  filterTo: z.number().finite().nullish(),
});
const dateCond = z.object({
  filterType: z.literal('date'),
  type: z.enum(['equals', 'notEqual', 'lessThan', 'greaterThan', 'inRange', 'blank', 'notBlank']),
  dateFrom: z.string().max(40).nullish(),
  dateTo: z.string().max(40).nullish(),
});
const condition = z.discriminatedUnion('filterType', [textCond, numberCond, dateCond]);
type Condition = z.infer<typeof condition>;
const combined = z.object({
  filterType: z.enum(['text', 'number', 'date']),
  operator: z.enum(['AND', 'OR']),
  conditions: z.array(condition).min(1).max(2),
});
const columnFilter = z.union([combined, condition]);
const filterModelSchema = z.record(z.string().max(100), columnFilter);
export type FilterModel = z.infer<typeof filterModelSchema>;

export interface BrowseInput {
  startRow: number;
  endRow: number;
  sortModel: SortItem[];
  filterModel: FilterModel;
}

function intParam(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n))
    throw new ApiError('VALIDATION_ERROR', `${name} must be a non-negative integer.`);
  return n;
}

function jsonParam<T>(raw: unknown, name: string, schema: z.ZodType<T>, fallback: T): T {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || raw.length > 8_000) {
    throw new ApiError('VALIDATION_ERROR', `${name} must be a JSON string.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ApiError('VALIDATION_ERROR', `${name} is not valid JSON.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new ApiError('VALIDATION_ERROR', `${name} is not a supported AG Grid model.`);
  return parsed.data;
}

/**
 * `?startRow=0&endRow=100&sortModel=[…]&filterModel={…}`: AG Grid's `IServerSideGetRowsRequest`
 * fields, the models JSON-encoded. A block is at most `BLOCK_SIZE` rows.
 */
export function parseBrowseQuery(query: Record<string, unknown>): BrowseInput {
  const startRow = intParam(query.startRow, 'startRow', 0);
  const endRow = intParam(query.endRow, 'endRow', startRow + BLOCK_SIZE);
  if (startRow > MAX_START_ROW)
    throw new ApiError('VALIDATION_ERROR', `startRow is at most ${MAX_START_ROW}.`);
  if (endRow <= startRow || endRow - startRow > BLOCK_SIZE) {
    throw new ApiError('VALIDATION_ERROR', `endRow must be 1 to ${BLOCK_SIZE} rows past startRow.`);
  }
  const sortModel = jsonParam(query.sortModel, 'sortModel', sortModelSchema, []);
  const filterModel = jsonParam(query.filterModel, 'filterModel', filterModelSchema, {});
  if (Object.keys(filterModel).length > MAX_FILTERS) {
    throw new ApiError('VALIDATION_ERROR', `At most ${MAX_FILTERS} column filters.`);
  }
  return { startRow, endRow, sortModel, filterModel };
}

// --- SQL ---------------------------------------------------------------------------------------

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `2026-11-12` or AG Grid's `2026-11-12 00:00:00` → the day; anything else is a 400. */
function day(raw: string | null | undefined): string {
  const d = typeof raw === 'string' ? raw.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new ApiError('VALIDATION_ERROR', 'Date filters need a date (YYYY-MM-DD).');
  }
  return d;
}

function nextDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function conditionSql(col: Column, c: Condition, params: unknown[]): string {
  if (c.filterType !== col.kind) {
    throw new ApiError('VALIDATION_ERROR', `This column takes a ${col.kind} filter.`);
  }
  const p = (v: unknown, cast = '') => {
    params.push(v);
    return `$${params.length}${cast}`;
  };

  if (c.type === 'blank') {
    return col.kind === 'text'
      ? `(${col.text} IS NULL OR ${col.text} = '')`
      : `${col.expr} IS NULL`;
  }
  if (c.type === 'notBlank') {
    return col.kind === 'text'
      ? `(${col.text} IS NOT NULL AND ${col.text} <> '')`
      : `${col.expr} IS NOT NULL`;
  }

  if (c.filterType === 'text') {
    if (c.filter === null || c.filter === undefined || c.filter === '') {
      throw new ApiError('VALIDATION_ERROR', 'Text filters need a value.');
    }
    const v = likeEscape(String(c.filter));
    const pattern = {
      contains: `%${v}%`,
      notContains: `%${v}%`,
      equals: v,
      notEqual: v,
      startsWith: `${v}%`,
      endsWith: `%${v}`,
    }[c.type];
    const like = `${col.text} ILIKE ${p(pattern)}`;
    return c.type === 'notContains' || c.type === 'notEqual'
      ? `(${col.text} IS NULL OR NOT (${like}))`
      : like;
  }

  if (c.filterType === 'number') {
    if (c.filter === null || c.filter === undefined) {
      throw new ApiError('VALIDATION_ERROR', 'Number filters need a value.');
    }
    const v = p(c.filter, '::numeric');
    switch (c.type) {
      case 'equals':
        return `${col.expr} = ${v}`;
      case 'notEqual':
        return `(${col.expr} IS NULL OR ${col.expr} <> ${v})`;
      case 'lessThan':
        return `${col.expr} < ${v}`;
      case 'lessThanOrEqual':
        return `${col.expr} <= ${v}`;
      case 'greaterThan':
        return `${col.expr} > ${v}`;
      case 'greaterThanOrEqual':
        return `${col.expr} >= ${v}`;
      case 'inRange': {
        if (c.filterTo === null || c.filterTo === undefined) {
          throw new ApiError('VALIDATION_ERROR', 'inRange needs filterTo.');
        }
        // AG Grid's default `inRangeInclusive: false`.
        return `(${col.expr} > ${v} AND ${col.expr} < ${p(c.filterTo, '::numeric')})`;
      }
    }
  }

  // Dates match whole UTC days. ISO text compares in time order (SP-011 canonical form), and a
  // timestamp column gets the same bounds as timestamptz.
  const bound = (d: string) =>
    col.timestamp ? p(`${d}T00:00:00Z`, '::timestamptz') : p(d, '::text');
  const from = day(c.dateFrom);
  switch (c.type) {
    case 'equals':
      return `(${col.expr} >= ${bound(from)} AND ${col.expr} < ${bound(nextDay(from))})`;
    case 'notEqual':
      return `(${col.expr} IS NULL OR ${col.expr} < ${bound(from)} OR ${col.expr} >= ${bound(nextDay(from))})`;
    case 'lessThan':
      return `${col.expr} < ${bound(from)}`;
    case 'greaterThan':
      return `${col.expr} >= ${bound(nextDay(from))}`;
    case 'inRange':
      // Both days included.
      return `(${col.expr} >= ${bound(from)} AND ${col.expr} < ${bound(nextDay(day(c.dateTo)))})`;
  }
  throw new ApiError('VALIDATION_ERROR', 'Unsupported filter.');
}

/** `WHERE` conditions for a filter model, values pushed onto `params`. */
export function filterModelSql(
  model: FilterModel,
  fields: readonly OwnerField[],
  params: unknown[],
): string[] {
  const out: string[] = [];
  for (const [colId, f] of Object.entries(model)) {
    const col = column(colId, fields);
    if ('conditions' in f) {
      const parts = f.conditions.map((c) => conditionSql(col, c, params));
      out.push(`(${parts.join(f.operator === 'AND' ? ' AND ' : ' OR ')})`);
    } else {
      out.push(conditionSql(col, f, params));
    }
  }
  return out;
}

/** `ORDER BY` for a sort model; default newest change first. Always ends on `id` (stable blocks). */
export function orderSql(sortModel: readonly SortItem[], fields: readonly OwnerField[]): string {
  if (sortModel.length === 0) return 'records.updated_at DESC, records.id ASC';
  const parts = sortModel.map((s) => {
    const col = column(s.colId, fields);
    return `${col.expr} ${s.sort === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
  });
  return [...parts, 'records.id ASC'].join(', ');
}

export interface BrowseRow {
  id: string;
  key: string;
  url: string | null;
  data: Record<string, unknown>;
  version: number;
  updatedAt: Date;
  crawledAt: Date | null;
  sourceLastmod: Date | null;
}

/** One block of a dataset's live records, plus the filtered total (AG Grid's `rowCount`). */
export async function browseRecords(
  q: Queryable,
  datasetId: string,
  fields: readonly OwnerField[],
  input: BrowseInput,
): Promise<{ rows: BrowseRow[]; rowCount: number }> {
  const params: unknown[] = [datasetId];
  const where = [
    'records.dataset_id = $1',
    'records.removed_at IS NULL',
    ...filterModelSql(input.filterModel, fields, params),
  ].join(' AND ');
  const order = orderSql(input.sortModel, fields);

  const count = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM records WHERE ${where}`,
    params,
  );
  const rowParams = [...params, input.endRow - input.startRow, input.startRow];
  const { rows } = await q.query<{
    id: string;
    record_key: string;
    url: string | null;
    data: Record<string, unknown>;
    version: number;
    updated_at: Date;
    crawled_at: Date | null;
    source_lastmod: Date | null;
  }>(
    `SELECT records.id, records.record_key, pages.url, records.data, records.version,
            records.updated_at, records.crawled_at, records.source_lastmod
       FROM records LEFT JOIN pages ON pages.id = records.page_id
      WHERE ${where}
      ORDER BY ${order}
      LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`,
    rowParams,
  );
  return {
    rowCount: count.rows[0]?.n ?? 0,
    rows: rows.map((r) => ({
      id: r.id,
      key: r.record_key,
      url: r.url,
      data: r.data,
      version: r.version,
      updatedAt: r.updated_at,
      crawledAt: r.crawled_at,
      sourceLastmod: r.source_lastmod,
    })),
  };
}
