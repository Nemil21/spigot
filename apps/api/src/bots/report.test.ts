import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { bucketSizeFor, DEFAULT_RANGE_MS, parseBotsQuery } from './report.js';

const NOW = new Date('2026-11-12T12:00:00Z');

describe('parseBotsQuery (SP-027a)', () => {
  it('defaults to the 7 days ending now, SIM included', () => {
    expect(parseBotsQuery({}, NOW)).toEqual({
      from: new Date(NOW.getTime() - DEFAULT_RANGE_MS),
      to: NOW,
      includeSim: true,
    });
  });
  it('reads from / to / includeSim', () => {
    const r = parseBotsQuery(
      { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z', includeSim: 'false' },
      NOW,
    );
    expect(r).toEqual({
      from: new Date('2026-11-10T00:00:00Z'),
      to: new Date('2026-11-11T00:00:00Z'),
      includeSim: false,
    });
    expect(parseBotsQuery({ includeSim: '0' }, NOW).includeSim).toBe(false);
    expect(parseBotsQuery({ includeSim: '1' }, NOW).includeSim).toBe(true);
  });
  it.each([
    [{ from: 'yesterday' }],
    [{ includeSim: 'maybe' }],
    [{ from: '2026-11-11T00:00:00Z', to: '2026-11-10T00:00:00Z' }],
    [{ from: '2026-01-01T00:00:00Z', to: '2026-11-11T00:00:00Z' }],
  ])('rejects %j with VALIDATION_ERROR', (query) => {
    expect(() => parseBotsQuery(query, NOW)).toThrow(ApiError);
    try {
      parseBotsQuery(query, NOW);
    } catch (e) {
      expect((e as ApiError).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('bucketSizeFor', () => {
  it('picks minute ≤ 3 h, hour ≤ 7 d, else day', () => {
    expect(bucketSizeFor(3 * 3_600_000)).toBe('minute');
    expect(bucketSizeFor(3 * 3_600_000 + 1)).toBe('hour');
    expect(bucketSizeFor(DEFAULT_RANGE_MS)).toBe('hour');
    expect(bucketSizeFor(DEFAULT_RANGE_MS + 1)).toBe('day');
  });
});
