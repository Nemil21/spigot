import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { fromApiError, paidSummary } from './results.js';
import { requestIds } from './server.js';
import { idempotencyKeyFor, loadToolModules, type Caller } from './tools.js';
import { matchCatalog } from './tools/catalog.js';

const caller = (over: Partial<Caller> = {}): Caller => ({
  buyerId: 'b',
  apiKeyId: 'k',
  scopes: ['read'],
  sessionId: '6b0c5f3e-8f0a-4a57-9a43-7d1c1c3b9d10',
  requestId: 7,
  ...over,
});

describe('idempotencyKeyFor', () => {
  it("prefers the agent's key", () => {
    expect(idempotencyKeyFor(caller(), 'mine')).toBe('mine');
  });
  it('uses mcp:<session>:<jsonrpc id> inside a session', () => {
    expect(idempotencyKeyFor(caller())).toBe('mcp:6b0c5f3e-8f0a-4a57-9a43-7d1c1c3b9d10:7');
    expect(idempotencyKeyFor(caller({ requestId: 'abc-1' }))).toMatch(/:abc-1$/);
  });
  it('hashes an id that is not short printable ASCII', () => {
    const key = idempotencyKeyFor(caller({ requestId: 'ünïcode id' }))!;
    expect(key).toMatch(/^mcp:[0-9a-f-]{36}:h[0-9a-f]{64}$/);
    expect(key.length).toBeLessThanOrEqual(255);
  });
  it('leaves a session-less call to the auto key', () => {
    expect(idempotencyKeyFor(caller({ sessionId: undefined }))).toBeUndefined();
  });
});

describe('paidSummary', () => {
  const base = { noun: 'listings', balanceMicros: 19_940_000, replay: false };
  it('reads like the spec', () => {
    expect(paidSummary({ ...base, count: 37, chargedMicros: 55_500 })).toBe(
      '37 listings, charged $0.0555, balance $19.94.',
    );
  });
  it('never says charged for a replay or an empty result', () => {
    expect(paidSummary({ ...base, count: 37, chargedMicros: 0, replay: true })).toBe(
      '37 listings, a repeat of an earlier call, not charged again, balance $19.94.',
    );
    expect(paidSummary({ ...base, count: 0, chargedMicros: 0 })).toBe(
      '0 listings, nothing charged, balance $19.94.',
    );
    expect(paidSummary({ ...base, count: 1, chargedMicros: 1_500 })).toMatch(/^1 listing, /);
  });
});

describe('fromApiError', () => {
  it('lists the valid filters for an unsupported one', () => {
    const r = fromApiError(
      new ApiError('UNSUPPORTED_FILTER', 'Field "sqft" can\'t be filtered.', {
        validFilters: [
          { field: 'bedrooms', ops: ['eq', 'gte'] },
          { field: 'updated_at', ops: ['gte'] },
        ],
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({
      type: 'text',
      text: 'Field "sqft" can\'t be filtered. Valid filters: bedrooms (eq, gte); updated_at (gte).',
    });
  });
});

describe('requestIds', () => {
  it('keeps requests, skips notifications and responses, and tells 1 from "1"', () => {
    expect(
      requestIds([
        { jsonrpc: '2.0', id: 1, method: 'tools/call' },
        { jsonrpc: '2.0', id: '1', method: 'tools/call' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 3, result: {} },
      ]),
    ).toEqual(['number:1', 'string:1']);
  });
});

describe('matchCatalog', () => {
  const sites = [
    {
      slug: 'bluebonnet',
      name: 'Bluebonnet Rentals',
      datasets: [
        { slug: 'listings', type: 'Listing' },
        { slug: 'agents', type: 'Agent' },
      ],
    },
  ] as Parameters<typeof matchCatalog>[0];
  it('matches every word against site and dataset names', () => {
    expect(matchCatalog(sites, undefined)).toEqual(sites);
    expect(matchCatalog(sites, 'rentals listing')[0]!.datasets.map((d) => d.slug)).toEqual([
      'listings',
    ]);
    expect(matchCatalog(sites, 'boats')).toEqual([]);
  });
});

describe('tool registry', () => {
  it('loads every tool file in mcp/tools', async () => {
    const modules = await loadToolModules();
    expect(modules.length).toBeGreaterThanOrEqual(2);
    for (const m of modules) expect(typeof m).toBe('function');
  });
});
