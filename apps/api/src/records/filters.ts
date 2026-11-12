// Record filters (SP-015; features/05 §Logic 4, features/06 §Filters). REST `field[op]=value`
// and MCP `[{field, op, value}]` parse to the same AST; `filterSql` turns it into SQL with
// parameters only. Field names in SQL always come from the schema allowlist (`ServedField`),
// never from the request, and `fieldExpr` is the one place that spells a field's expression so
// SP-014a's expression indexes match the query exactly.
import { z } from 'zod';
import { parseDate, parseDateTime, parseNumber, type FieldType } from '@spigot/shared';
import { ApiError } from '../http/errors.js';
import { FILTER_OPS, type FilterOp, type ServedField } from './fields.js';

/** `records.updated_at`: always filterable with `gte`, whatever the schema says. */
export const UPDATED_AT = 'updated_at';
export const UPDATED_AT_OPS: readonly FilterOp[] = ['gte'];
export const MAX_IN_VALUES = 50;
export const MAX_FILTERS = 20;
const MAX_STRING_VALUE = 500;

/** Query params on the records / quote / changes endpoints that are not filters. */
export const RESERVED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'sort',
  'limit',
  'cursor',
  'since',
  'include',
  'max_price_micros',
]);

export type FilterScalar = string | number | boolean;

/** One parsed, type-coerced filter. Serializable (SP-017a may hash it for idempotency). */
export interface FilterClause {
  field: string;
  op: FilterOp;
  value: FilterScalar | FilterScalar[];
}

const SQL_OP: Record<Exclude<FilterOp, 'in'>, string> = {
  eq: '=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Field names are snake_case (SP-011's `fieldNameSchema`); anything else never reaches SQL. */
const SAFE_FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** `quote_literal`: wrap in single quotes, double any inside. */
function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The SQL expression for a schema field over `records.data`, e.g.
 * `(CASE WHEN jsonb_typeof(data->'price_usd') = 'number' THEN (data->>'price_usd')::numeric END)`.
 *
 * Total and IMMUTABLE: it never raises, whatever is stored. Numbers and booleans are cast only
 * when the jsonb value already has that type; anything else (a row from an older schema version,
 * an owner's type change, the same field name typed differently in another dataset) is NULL and
 * simply doesn't match. That keeps a bad row from turning a paid query into a 500, and keeps an
 * index over the whole `records` table buildable. Numbers cast to `numeric` (no int4 overflow).
 * Dates and datetimes stay text: SP-011 canonicalizes them to `YYYY-MM-DD` / `toISOString()`
 * (fixed width, so text order is time order), and text → timestamptz isn't IMMUTABLE.
 *
 * SP-014a: build expression indexes with exactly this string (`CREATE INDEX … ON records
 * ((<fieldExpr>))`); any other spelling, even an equivalent one, won't be used by these queries.
 */
export function fieldExpr(field: string, type: FieldType): string {
  if (!SAFE_FIELD_NAME.test(field)) throw new Error(`unsafe field name ${JSON.stringify(field)}`);
  const key = quoteLiteral(field);
  const text = `(data->>${key})`;
  const typed = (jsonType: string, cast: string) =>
    `(CASE WHEN jsonb_typeof(data->${key}) = '${jsonType}' THEN ${text}::${cast} END)`;
  switch (type) {
    case 'integer':
    case 'number':
      return typed('number', 'numeric');
    case 'boolean':
      return typed('boolean', 'boolean');
    case 'string':
    case 'url':
    case 'date':
    case 'datetime':
      return text;
    default:
      throw new Error(`${type} fields are not filterable`);
  }
}

/** Param cast matching `fieldExpr`'s type. */
function paramCast(type: FieldType): string {
  if (type === 'integer' || type === 'number') return 'numeric';
  if (type === 'boolean') return 'boolean';
  return 'text';
}

/** `[{field, ops}]` for the UNSUPPORTED_FILTER hint: what this dataset does accept. */
export function validFilters(fields: readonly ServedField[]): { field: string; ops: FilterOp[] }[] {
  return [
    ...fields
      .filter((f) => f.filterable.length > 0)
      .map((f) => ({ field: f.name, ops: [...f.filterable] })),
    { field: UPDATED_AT, ops: [...UPDATED_AT_OPS] },
  ];
}

function unsupported(fields: readonly ServedField[], message: string): ApiError {
  return new ApiError('UNSUPPORTED_FILTER', message, { validFilters: validFilters(fields) });
}

function badValue(field: string, op: string, why: string): ApiError {
  return new ApiError('VALIDATION_ERROR', `Invalid value for filter ${field}[${op}]: ${why}.`, {
    field,
    op,
  });
}

function coerceScalar(
  type: FieldType | 'updated_at',
  raw: unknown,
  field: string,
  op: FilterOp,
): FilterScalar {
  switch (type) {
    case 'integer': {
      const n = parseNumber(raw);
      if (n === null || !Number.isSafeInteger(n)) throw badValue(field, op, 'expected an integer');
      return n;
    }
    case 'number': {
      const n = parseNumber(raw);
      if (n === null) throw badValue(field, op, 'expected a number');
      return n;
    }
    case 'boolean':
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      throw badValue(field, op, 'expected true or false');
    case 'date': {
      const d = parseDate(raw);
      if (d === null) throw badValue(field, op, 'expected a date (YYYY-MM-DD)');
      return d;
    }
    case 'datetime':
    case 'updated_at': {
      const d = parseDateTime(raw);
      if (d === null) throw badValue(field, op, 'expected an ISO 8601 datetime');
      return d;
    }
    case 'string':
    case 'url':
      if (typeof raw !== 'string') throw badValue(field, op, 'expected a string');
      if (raw.length > MAX_STRING_VALUE)
        throw badValue(field, op, `longer than ${MAX_STRING_VALUE} characters`);
      return raw;
    default:
      throw badValue(field, op, 'field is not filterable');
  }
}

/** Validate one `(field, op, value)` against the allowlist and coerce the value. */
function clause(
  fields: readonly ServedField[],
  field: string,
  op: string,
  raw: unknown,
): FilterClause {
  if (!(FILTER_OPS as readonly string[]).includes(op)) {
    throw unsupported(
      fields,
      `Unsupported filter operator "${op}". Use one of ${FILTER_OPS.join(', ')}.`,
    );
  }
  const fop = op as FilterOp;
  let type: FieldType | 'updated_at';
  if (field === UPDATED_AT) {
    if (!UPDATED_AT_OPS.includes(fop))
      throw unsupported(fields, `updated_at only supports ${UPDATED_AT_OPS.join(', ')}.`);
    type = 'updated_at';
  } else {
    // Hidden fields aren't in `fields` at all, so they fail here exactly like unknown ones.
    const f = fields.find((x) => x.name === field);
    if (!f || f.filterable.length === 0)
      throw unsupported(fields, `Field "${field}" can't be filtered.`);
    if (!f.filterable.includes(fop)) {
      throw unsupported(
        fields,
        `Field "${field}" doesn't support "${op}". Use one of ${f.filterable.join(', ')}.`,
      );
    }
    type = f.type;
  }

  if (fop !== 'in') {
    if (Array.isArray(raw))
      throw badValue(field, op, `"${op}" takes one value (use [in] for a list)`);
    return { field, op: fop, value: coerceScalar(type, raw, field, fop) };
  }
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw];
  if (list.length === 0) throw badValue(field, op, 'needs at least one value');
  if (list.length > MAX_IN_VALUES) throw badValue(field, op, `at most ${MAX_IN_VALUES} values`);
  return { field, op: fop, value: list.map((v) => coerceScalar(type, v, field, fop)) };
}

function capCount(fields: readonly ServedField[], n: number): void {
  if (n > MAX_FILTERS) throw unsupported(fields, `At most ${MAX_FILTERS} filters per call.`);
}

const REST_KEY = /^([A-Za-z0-9_]{1,64})(?:\[([a-z]{1,8})\])?$/;

/**
 * REST: `bedrooms[gte]=3&city=Austin&city[in]=Austin,Dallas`. `query` is Fastify's flat parsed
 * querystring (a value is a string, or an array when the key repeats). Non-filter params
 * (`RESERVED_QUERY_PARAMS`) are ignored. A repeated `[in]` key adds values; any other repeat is
 * rejected rather than silently picking one.
 */
export function parseQueryFilters(
  query: Record<string, unknown>,
  fields: readonly ServedField[],
): FilterClause[] {
  const out: FilterClause[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (RESERVED_QUERY_PARAMS.has(key)) continue;
    const m = REST_KEY.exec(key);
    if (!m)
      throw unsupported(fields, `Unsupported filter "${key.slice(0, 80)}". Use field[op]=value.`);
    const [, field, op = 'eq'] = m;
    const values = Array.isArray(raw)
      ? raw.flatMap((v) => (op === 'in' ? String(v).split(',') : [v]))
      : raw;
    out.push(clause(fields, field!, op, values));
  }
  capCount(fields, out.length);
  return out;
}

const filterListSchema = z
  .array(
    z.object({
      field: z.string().max(100),
      op: z.string().max(10).default('eq'),
      value: z.unknown(),
    }),
  )
  .max(MAX_FILTERS);

/** MCP: `[{ field: 'bedrooms', op: 'gte', value: 3 }]` → the same AST as `parseQueryFilters`. */
export function parseFilterList(list: unknown, fields: readonly ServedField[]): FilterClause[] {
  if (list === undefined || list === null) return [];
  const parsed = filterListSchema.safeParse(list);
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'filters must be a list of {field, op, value} (at most 20).',
    );
  }
  return parsed.data.map((f) => clause(fields, f.field, f.op, f.value));
}

/**
 * SQL conditions for `clauses` over `records`, pushing values onto `params` (placeholders
 * continue from `params.length`). Re-checks every clause against `fields`, so an AST built
 * elsewhere can't smuggle a hidden or unknown field in.
 */
export function filterSql(
  clauses: readonly FilterClause[],
  fields: readonly ServedField[],
  params: unknown[],
): string[] {
  const conds: string[] = [];
  for (const c of clauses) {
    // Round-trip through the validator: same field/op/value rules as the parsers.
    const checked = clause(fields, c.field, c.op, c.value);
    if (checked.field === UPDATED_AT) {
      params.push(checked.value);
      conds.push(`records.updated_at >= $${params.length}::timestamptz`);
      continue;
    }
    const f = fields.find((x) => x.name === checked.field)!;
    const expr = fieldExpr(f.name, f.type);
    const cast = paramCast(f.type);
    params.push(checked.value);
    conds.push(
      checked.op === 'in'
        ? `${expr} = ANY($${params.length}::${cast}[])`
        : `${expr} ${SQL_OP[checked.op]} $${params.length}::${cast}`,
    );
  }
  return conds;
}

export type SortDirection = 'desc' | 'asc';

/**
 * `sort` accepts only `-updated_at` (default) and `updated_at`. Sorting by a data field would
 * leak a hidden field's order, so there is no free sort field.
 */
export function parseSort(sort: unknown): SortDirection {
  if (sort === undefined || sort === null || sort === '' || sort === '-updated_at') return 'desc';
  if (sort === 'updated_at') return 'asc';
  throw new ApiError('VALIDATION_ERROR', 'sort must be "-updated_at" or "updated_at".');
}
