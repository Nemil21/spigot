import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import {
  filterModelSql,
  orderSql,
  ownerFields,
  parseBrowseQuery,
  type OwnerField,
} from './browse.js';

const FIELDS: OwnerField[] = [
  { name: 'title', type: 'string', visible: true, pii: false },
  { name: 'price_usd', type: 'integer', visible: true, pii: false },
  { name: 'available_on', type: 'date', visible: true, pii: false },
  { name: 'agent_phone', type: 'string', visible: false, pii: true },
];

describe('ownerFields', () => {
  it('keeps hidden fields, flags them, and drops malformed or duplicate entries', () => {
    expect(
      ownerFields([
        { name: 'title', type: 'string', visible: true },
        { name: 'agent_phone', type: 'string', visible: false, pii: true },
        { name: 'shady', type: 'string', visible: 'yes' },
        { name: "x'; DROP TABLE records; --", type: 'string', visible: true },
        { name: 'dup', type: 'string', visible: true },
        { name: 'dup', type: 'integer', visible: true },
        { name: 'url', type: 'url', visible: true },
        null,
      ]),
    ).toEqual([
      { name: 'title', type: 'string', visible: true, pii: false },
      { name: 'agent_phone', type: 'string', visible: false, pii: true },
      { name: 'shady', type: 'string', visible: false, pii: false },
    ]);
    expect(ownerFields('nope')).toEqual([]);
  });
});

describe('parseBrowseQuery', () => {
  it('defaults to the first block of 100', () => {
    expect(parseBrowseQuery({})).toEqual({
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {},
    });
  });

  it.each([
    [{ startRow: '0', endRow: '101' }],
    [{ startRow: '10', endRow: '10' }],
    [{ startRow: '1.5' }],
    [{ startRow: '-1' }],
    [{ sortModel: '[{"colId":"x","sort":"sideways"}]' }],
    [{ sortModel: JSON.stringify(Array(4).fill({ colId: 'key', sort: 'asc' })) }],
    [{ filterModel: '{"a":{"filterType":"set","values":[]}}' }],
    [{ filterModel: '{' }],
  ])('rejects %j with VALIDATION_ERROR', (q) => {
    expect(() => parseBrowseQuery(q)).toThrow(ApiError);
  });
});

describe('SQL builders', () => {
  it('puts every value in params, never in SQL text', () => {
    const params: unknown[] = [];
    const sql = filterModelSql(
      {
        'data.title': { filterType: 'text', type: 'contains', filter: "50%_off'--" },
        'data.price_usd': {
          filterType: 'number',
          operator: 'AND',
          conditions: [
            { filterType: 'number', type: 'greaterThan', filter: 1000 },
            { filterType: 'number', type: 'lessThan', filter: 2000 },
          ],
        },
        'data.available_on': {
          filterType: 'date',
          type: 'inRange',
          dateFrom: '2026-11-01 00:00:00',
          dateTo: '2026-11-30',
        },
        updatedAt: { filterType: 'date', type: 'equals', dateFrom: '2026-11-12' },
      },
      FIELDS,
      params,
    ).join(' AND ');
    expect(sql).not.toContain('50%');
    expect(sql).not.toContain('2026');
    expect(params).toEqual([
      "%50\\%\\_off'--%",
      1000,
      2000,
      '2026-11-01',
      '2026-12-01',
      '2026-11-12T00:00:00Z',
      '2026-11-13T00:00:00Z',
    ]);
  });

  it('rejects unknown columns and a filter type the column does not take', () => {
    expect(() => orderSql([{ colId: 'data.nope', sort: 'asc' }], FIELDS)).toThrow(ApiError);
    expect(() => orderSql([{ colId: '__proto__', sort: 'asc' }], FIELDS)).toThrow(ApiError);
    expect(() =>
      filterModelSql(
        { 'data.price_usd': { filterType: 'text', type: 'contains', filter: '1' } },
        FIELDS,
        [],
      ),
    ).toThrow(ApiError);
    expect(() =>
      filterModelSql(
        { 'data.available_on': { filterType: 'date', type: 'equals', dateFrom: 'soon' } },
        FIELDS,
        [],
      ),
    ).toThrow(ApiError);
  });

  it('orders by the typed field expression with an id tie-break; default newest first', () => {
    expect(orderSql([], FIELDS)).toBe('records.updated_at DESC, records.id ASC');
    expect(orderSql([{ colId: 'data.price_usd', sort: 'desc' }], FIELDS)).toMatch(
      /THEN \(data->>'price_usd'\)::numeric END\) DESC NULLS LAST, records\.id ASC$/,
    );
  });
});
