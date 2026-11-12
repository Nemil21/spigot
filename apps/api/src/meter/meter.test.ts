import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { SIM_AUDIT_SAMPLE, simAuditSampled } from './charge.js';
import { autoKey, canonicalJson, checkClientKey, requestHash } from './idempotency.js';
import { priceMicros } from './quote.js';

describe('priceMicros', () => {
  test('n × unit', () => {
    expect(priceMicros(37, 1500)).toBe(55_500);
    expect(priceMicros(0, 1500)).toBe(0);
  });
  test('rejects negative, fractional and overflowing inputs', () => {
    expect(() => priceMicros(-1, 1500)).toThrow(RangeError);
    expect(() => priceMicros(1.5, 1500)).toThrow(RangeError);
    expect(() => priceMicros(1, -1)).toThrow(RangeError);
    expect(() => priceMicros(2 ** 40, 2 ** 20)).toThrow(RangeError);
  });
});

describe('requestHash', () => {
  test('ignores key order at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[2,{"x":2,"y":1}]},"b":1}',
    );
    expect(requestHash({ city: 'Austin', limit: 50 })).toBe(
      requestHash({ limit: 50, city: 'Austin' }),
    );
  });
  test('differs for different requests', () => {
    expect(requestHash({ city: 'Austin' })).not.toBe(requestHash({ city: 'Dallas' }));
  });
});

describe('autoKey', () => {
  const key = randomUUID();
  const h = requestHash({ city: 'Austin' });
  test('is stable within a minute bucket and changes with the next one', () => {
    const t0 = new Date('2026-11-12T10:00:05Z');
    expect(autoKey(key, h, t0)).toBe(autoKey(key, h, new Date('2026-11-12T10:00:59.999Z')));
    expect(autoKey(key, h, t0)).not.toBe(autoKey(key, h, new Date('2026-11-12T10:01:00Z')));
    expect(autoKey(key, h, t0)).toMatch(/^auto:[0-9a-f]{64}$/);
  });
  test('depends on the api key and the request', () => {
    const t = new Date();
    expect(autoKey(key, h, t)).not.toBe(autoKey(randomUUID(), h, t));
    expect(autoKey(key, h, t)).not.toBe(autoKey(key, requestHash({ city: 'Dallas' }), t));
  });
});

describe('checkClientKey', () => {
  test('accepts printable ASCII up to 255 chars', () => {
    expect(checkClientKey('retry-1')).toBe('retry-1');
    expect(checkClientKey('k'.repeat(255))).toHaveLength(255);
  });
  test('rejects empty, long and non-printable keys with 400', () => {
    for (const bad of ['', 'k'.repeat(256), 'a b', 'é', 'a\nb']) {
      expect(() => checkClientKey(bad)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });
});

describe('simAuditSampled', () => {
  test('is deterministic per call id', () => {
    const id = randomUUID();
    expect(simAuditSampled(id)).toBe(simAuditSampled(id));
  });
  test('samples about 1 in 20', () => {
    const n = 20_000;
    let hits = 0;
    for (let i = 0; i < n; i++) if (simAuditSampled(randomUUID())) hits++;
    expect(hits / n).toBeGreaterThan(1 / SIM_AUDIT_SAMPLE - 0.01);
    expect(hits / n).toBeLessThan(1 / SIM_AUDIT_SAMPLE + 0.01);
  });
});
