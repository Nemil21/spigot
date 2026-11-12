import { describe, expect, test } from 'vitest';
import { ApiError } from '../http/errors.js';
import { servedFields } from './fields.js';
import {
  fieldExpr,
  filterSql,
  MAX_IN_VALUES,
  parseFilterList,
  parseQueryFilters,
  parseSort,
  type FilterClause,
} from './filters.js';

/** The demo Listing schema as SP-012a / SP-014a store it: `agent_phone` hidden. */
const LISTING_FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  {
    name: 'price_usd',
    type: 'integer',
    visible: true,
    filterable: ['eq', 'lt', 'lte', 'gt', 'gte'],
  },
  { name: 'bedrooms', type: 'integer', visible: true, filterable: ['eq', 'gte', 'lte'] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq', 'in'] },
  { name: 'available_from', type: 'date', visible: true, filterable: ['gte', 'lt'] },
  { name: 'pets', type: 'boolean', visible: true, filterable: ['eq'] },
  { name: 'agent_phone', type: 'string', visible: false, pii: true, filterable: ['eq'] },
];
const fields = servedFields(LISTING_FIELDS);

function errorOf(fn: () => unknown): { code: string; status: number } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return { code: e.code, status: e.status };
    throw e;
  }
  throw new Error('expected an ApiError');
}

describe('servedFields', () => {
  test('keeps only visible === true fields and ops valid for the type', () => {
    expect(fields.map((f) => f.name)).toEqual([
      'title',
      'price_usd',
      'bedrooms',
      'city',
      'available_from',
      'pets',
    ]);
    const s = servedFields([
      { name: 'a', type: 'string', visible: 'true', filterable: ['eq'] },
      { name: 'b', type: 'string', filterable: ['eq'] },
      { name: 'c', type: 'string', visible: true, filterable: ['lt', 'in', 'drop'] },
      { name: 'd', type: 'string[]', visible: true, filterable: ['eq'] },
      { name: 'Bad Name', type: 'string', visible: true },
      { name: 'url', type: 'string', visible: true },
      { name: 'e', type: 'string', visible: true },
      { name: 'e', type: 'string', visible: false },
      null,
    ]);
    expect(s).toEqual([
      { name: 'c', type: 'string', visible: true, filterable: ['in'] },
      { name: 'd', type: 'string[]', visible: true, filterable: [] },
    ]);
    expect(servedFields(null)).toEqual([]);
  });
});

describe('parseQueryFilters', () => {
  const ok: [Record<string, unknown>, FilterClause[]][] = [
    [{}, []],
    [{ city: 'Austin' }, [{ field: 'city', op: 'eq', value: 'Austin' }]],
    [{ 'city[eq]': 'Austin' }, [{ field: 'city', op: 'eq', value: 'Austin' }]],
    [{ 'bedrooms[gte]': '3' }, [{ field: 'bedrooms', op: 'gte', value: 3 }]],
    [{ 'price_usd[lt]': '2000' }, [{ field: 'price_usd', op: 'lt', value: 2000 }]],
    [{ 'city[in]': 'Austin,Dallas' }, [{ field: 'city', op: 'in', value: ['Austin', 'Dallas'] }]],
    [
      { 'city[in]': ['Austin', 'Waco,Dallas'] },
      [{ field: 'city', op: 'in', value: ['Austin', 'Waco', 'Dallas'] }],
    ],
    [
      { 'available_from[gte]': '2026-11-01' },
      [{ field: 'available_from', op: 'gte', value: '2026-11-01' }],
    ],
    [{ pets: 'true' }, [{ field: 'pets', op: 'eq', value: true }]],
    [
      { 'updated_at[gte]': '2026-11-11T00:00:00-06:00' },
      [{ field: 'updated_at', op: 'gte', value: '2026-11-11T06:00:00.000Z' }],
    ],
    // Non-filter params are ignored.
    [
      { sort: '-updated_at', limit: '50', cursor: 'x', max_price_micros: '1', include: 'record' },
      [],
    ],
  ];
  test.each(ok)('%j', (query, expected) => {
    expect(parseQueryFilters(query, fields)).toEqual(expected);
  });

  const bad: [string, Record<string, unknown>, string][] = [
    ['injection in the value', { 'price_usd[lt]': '1;DROP TABLE records' }, 'VALIDATION_ERROR'],
    ['injection as a field', { "data->>'x' OR 1=1": '1' }, 'UNSUPPORTED_FILTER'],
    ['quoted field', { "price_usd'--": '1' }, 'UNSUPPORTED_FILTER'],
    ['unknown op', { 'price_usd[ne]': '1' }, 'UNSUPPORTED_FILTER'],
    ['op not in the field list', { 'bedrooms[lt]': '3' }, 'UNSUPPORTED_FILTER'],
    ['hidden field', { agent_phone: '512-555-0100' }, 'UNSUPPORTED_FILTER'],
    ['hidden field with op', { 'agent_phone[eq]': '512' }, 'UNSUPPORTED_FILTER'],
    ['visible but not filterable', { title: 'x' }, 'UNSUPPORTED_FILTER'],
    ['unknown field', { garage: '1' }, 'UNSUPPORTED_FILTER'],
    ['updated_at op other than gte', { 'updated_at[lt]': '2026-11-11' }, 'UNSUPPORTED_FILTER'],
    ['nested brackets', { 'price_usd[lt][x]': '1' }, 'UNSUPPORTED_FILTER'],
    ['non-integer', { 'bedrooms[gte]': '2.5' }, 'VALIDATION_ERROR'],
    ['bad date', { 'available_from[gte]': 'soon' }, 'VALIDATION_ERROR'],
    ['bad datetime', { 'updated_at[gte]': 'yesterday' }, 'VALIDATION_ERROR'],
    ['bad boolean', { pets: 'maybe' }, 'VALIDATION_ERROR'],
    ['repeated single-value op', { city: ['Austin', 'Dallas'] }, 'VALIDATION_ERROR'],
    [
      'too many in values',
      { 'city[in]': Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => `c${i}`).join(',') },
      'VALIDATION_ERROR',
    ],
  ];
  test.each(bad)('%s → 400 %s', (_name, query, code) => {
    expect(errorOf(() => parseQueryFilters(query, fields))).toEqual({ code, status: 400 });
  });

  test('UNSUPPORTED_FILTER lists the valid filters and never the hidden field', () => {
    try {
      parseQueryFilters({ agent_phone: '1' }, fields);
      expect.unreachable();
    } catch (e) {
      const details = (e as ApiError).details as { validFilters: { field: string }[] };
      expect(details.validFilters.map((f) => f.field)).toEqual([
        'price_usd',
        'bedrooms',
        'city',
        'available_from',
        'pets',
        'updated_at',
      ]);
      expect(JSON.stringify(e)).not.toContain('agent_phone');
    }
  });

  test('exactly 50 in values is fine', () => {
    const list = Array.from({ length: MAX_IN_VALUES }, (_, i) => `c${i}`);
    expect(parseQueryFilters({ 'city[in]': list.join(',') }, fields)[0]!.value).toEqual(list);
  });
});

describe('parseFilterList (MCP)', () => {
  test('same AST as REST', () => {
    expect(
      parseFilterList(
        [
          { field: 'bedrooms', op: 'gte', value: 3 },
          { field: 'price_usd', op: 'lt', value: '2000' },
          { field: 'city', value: 'Austin' },
          { field: 'city', op: 'in', value: ['Austin', 'Dallas'] },
        ],
        fields,
      ),
    ).toEqual(
      parseQueryFilters(
        {
          'bedrooms[gte]': '3',
          'price_usd[lt]': '2000',
          city: 'Austin',
          'city[in]': 'Austin,Dallas',
        },
        fields,
      ),
    );
    expect(parseFilterList(undefined, fields)).toEqual([]);
  });

  test.each([
    ['not a list', { field: 'city' }, 'VALIDATION_ERROR'],
    [
      'injection as field',
      [{ field: "data->>'x' OR 1=1", op: 'eq', value: 1 }],
      'UNSUPPORTED_FILTER',
    ],
    ['hidden field', [{ field: 'agent_phone', op: 'eq', value: '1' }], 'UNSUPPORTED_FILTER'],
    ['object value', [{ field: 'city', op: 'eq', value: { $ne: 1 } }], 'VALIDATION_ERROR'],
    [
      'too many filters',
      Array.from({ length: 21 }, () => ({ field: 'city', value: 'a' })),
      'VALIDATION_ERROR',
    ],
  ])('%s → 400 %s', (_n, list, code) => {
    expect(errorOf(() => parseFilterList(list, fields))).toEqual({ code, status: 400 });
  });
});

describe('filterSql', () => {
  test('parameters only; field names from the allowlist', () => {
    const params: unknown[] = ['ds'];
    const clauses = parseQueryFilters(
      {
        'price_usd[lt]': '2000',
        'city[in]': 'Austin,Dallas',
        'updated_at[gte]': '2026-11-11T00:00:00Z',
        pets: 'false',
      },
      fields,
    );
    expect(filterSql(clauses, fields, params)).toEqual([
      `(CASE WHEN jsonb_typeof(data->'price_usd') = 'number' THEN (data->>'price_usd')::numeric END) < $2::numeric`,
      `(data->>'city') = ANY($3::text[])`,
      'records.updated_at >= $4::timestamptz',
      `(CASE WHEN jsonb_typeof(data->'pets') = 'boolean' THEN (data->>'pets')::boolean END) = $5::boolean`,
    ]);
    expect(params).toEqual(['ds', 2000, ['Austin', 'Dallas'], '2026-11-11T00:00:00.000Z', false]);
  });

  test('re-validates a hand-built AST (a hidden field can never reach SQL)', () => {
    expect(
      errorOf(() => filterSql([{ field: 'agent_phone', op: 'eq', value: 'x' }], fields, [])),
    ).toEqual({
      code: 'UNSUPPORTED_FILTER',
      status: 400,
    });
    expect(
      errorOf(() => filterSql([{ field: "x' OR 1=1 --", op: 'eq', value: 'x' }], fields, [])),
    ).toEqual({ code: 'UNSUPPORTED_FILTER', status: 400 });
  });
});

describe('fieldExpr', () => {
  test.each([
    [
      'price_usd',
      'integer',
      `(CASE WHEN jsonb_typeof(data->'price_usd') = 'number' THEN (data->>'price_usd')::numeric END)`,
    ],
    [
      'rating',
      'number',
      `(CASE WHEN jsonb_typeof(data->'rating') = 'number' THEN (data->>'rating')::numeric END)`,
    ],
    ['city', 'string', `(data->>'city')`],
    ['available_from', 'date', `(data->>'available_from')`],
    [
      'pets',
      'boolean',
      `(CASE WHEN jsonb_typeof(data->'pets') = 'boolean' THEN (data->>'pets')::boolean END)`,
    ],
  ] as const)('%s %s', (name, type, expr) => {
    expect(fieldExpr(name, type)).toBe(expr);
  });

  test('refuses anything but a snake_case name', () => {
    expect(() => fieldExpr("x'); DROP TABLE records; --", 'string')).toThrow(/unsafe field name/);
    expect(() => fieldExpr('Price', 'integer')).toThrow(/unsafe field name/);
    expect(() => fieldExpr('tags', 'string[]')).toThrow(/not filterable/);
  });
});

describe('parseSort', () => {
  test.each([
    [undefined, 'desc'],
    ['', 'desc'],
    ['-updated_at', 'desc'],
    ['updated_at', 'asc'],
  ])('%j → %s', (sort, dir) => expect(parseSort(sort)).toBe(dir));

  test.each([
    'agent_phone',
    '-agent_phone',
    'price_usd',
    'price_usd;--',
    'updated_at desc',
    ['updated_at'],
  ])('%j → 400', (sort) =>
    expect(errorOf(() => parseSort(sort))).toEqual({ code: 'VALIDATION_ERROR', status: 400 }),
  );
});
