import { describe, expect, it } from 'vitest';
import { parsePolicy, PolicyError } from './policy.js';
import { demoPolicyWire } from './fixtures.test-helpers.js';

describe('parsePolicy', () => {
  it('parses the api.md policy and compiles regexes and the key digest', () => {
    const p = parsePolicy(demoPolicyWire());
    expect(p.policyVersion).toBe(3);
    expect(p.gatedPaths.map((r) => r.source)).toEqual([
      '^\\/listings\\/',
      '^\\/agents\\/',
      '^\\/open-houses\\/',
    ]);
    expect(p.crawlKeyDigest).toHaveLength(32);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('accepts the api.md example without the optional siteName / type / records', () => {
    const { siteName: _s, ...wire } = demoPolicyWire({
      prices: [{ dataset: 'listings', perRecordMicros: 1500, display: '$1.50 per 1,000 records' }],
    });
    const p = parsePolicy(wire);
    expect(p.wire.siteName).toBeUndefined();
    expect(p.wire.prices[0]).toEqual({
      dataset: 'listings',
      perRecordMicros: 1500,
      display: '$1.50 per 1,000 records',
    });
  });

  it('treats a missing or empty crawl key as disabled', () => {
    expect(parsePolicy(demoPolicyWire({ crawlKeySha256: '' })).crawlKeyDigest).toBeNull();
    expect(parsePolicy(demoPolicyWire({ crawlKeySha256: undefined })).crawlKeyDigest).toBeNull();
  });

  it.each([
    ['not an object', null],
    ['missing siteId', { ...demoPolicyWire(), siteId: '' }],
    ['bad version', { ...demoPolicyWire(), policyVersion: -1 }],
    ['relative apiBase', { ...demoPolicyWire(), apiBase: '/v1/x' }],
    ['non-http catalog', { ...demoPolicyWire(), catalogUrl: 'javascript:alert(1)' }],
    ['short key hash', { ...demoPolicyWire(), crawlKeySha256: 'abc' }],
    ['invalid regex', { ...demoPolicyWire(), gatedPaths: ['^/listings/('] }],
    ['gatedPaths not array', { ...demoPolicyWire(), gatedPaths: '^/x' }],
    [
      'unknown decision',
      { ...demoPolicyWire(), decisions: { ...demoPolicyWire().decisions, AI_AGENT: 'BLOCK' } },
    ],
    ['missing decision', { ...demoPolicyWire(), decisions: { SEARCH: 'PASS' } }],
    [
      'bad dataset slug',
      { ...demoPolicyWire(), prices: [{ dataset: 'Lis tings', perRecordMicros: 1 }] },
    ],
    [
      'fractional micros',
      { ...demoPolicyWire(), prices: [{ dataset: 'listings', perRecordMicros: 1.5 }] },
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => parsePolicy(input)).toThrow(PolicyError);
  });
});
