import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize, recordHash } from './canonical.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('canonicalize', () => {
  it('sorts keys recursively and drops whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('normalizes numbers, dates, strings and missing values', () => {
    expect(canonicalize({ n: -0, f: 1.0, e: 1e2, inf: Infinity, nan: NaN })).toBe(
      '{"e":100,"f":1,"inf":null,"n":0,"nan":null}',
    );
    expect(canonicalize({ d: new Date('2026-12-06T13:00:00-06:00') })).toBe(
      '{"d":"2026-12-06T19:00:00.000Z"}',
    );
    // "é" composed vs decomposed
    expect(canonicalize('é')).toBe(canonicalize('é'));
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('keeps array order', () => {
    expect(canonicalize(['b', 'a'])).not.toBe(canonicalize(['a', 'b']));
  });
});

describe('recordHash', () => {
  const data = { price_usd: 2150, bedrooms: 2, available_from: '2026-12-15', pets_allowed: true };

  it('is the hex sha256 of the canonical JSON', () => {
    expect(recordHash(data, sha256)).toBe(sha256(canonicalize(data)));
    expect(recordHash(data, sha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('key order or whitespace changes give the same hash', () => {
    const reordered = JSON.parse(`{
      "pets_allowed" : true,
      "available_from":   "2026-12-15",
      "bedrooms": 2.0,
      "price_usd":2150
    }`) as unknown;
    expect(recordHash(reordered, sha256)).toBe(recordHash(data, sha256));
  });

  it('a value change gives a different hash', () => {
    expect(recordHash({ ...data, price_usd: 2195 }, sha256)).not.toBe(recordHash(data, sha256));
  });
});
