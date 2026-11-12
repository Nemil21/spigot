import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize, checkRegexPattern, extract, recordHash } from '@spigot/shared';
import { nodeSha256, re2Engine } from './adapters.js';

describe('nodeSha256', () => {
  it('is hex sha256 over UTF-8', () => {
    expect(nodeSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(nodeSha256('é')).toBe(createHash('sha256').update(Buffer.from('é', 'utf8')).digest('hex'));
    const data = { b: 1, a: 'x' };
    expect(recordHash(data, nodeSha256)).toBe(nodeSha256(canonicalize(data)));
  });
});

describe('re2Engine', () => {
  it('returns the first group, or the whole match without one', () => {
    expect(re2Engine.compile('(\\d+)\\s*sq').firstGroup('910 sq ft')).toBe('910');
    expect(re2Engine.compile('\\d+').firstGroup('Unit 12')).toBe('12');
    expect(re2Engine.compile('(\\d+)').firstGroup('none')).toBeNull();
  });

  it('refuses non-RE2 syntax', () => {
    expect(() => re2Engine.compile('(a)\\1')).toThrow();
    expect(() => re2Engine.compile('a(?=b)')).toThrow();
  });

  it('runs in linear time even on a pattern the spec check would reject', () => {
    expect(checkRegexPattern('(a+)+$')).not.toBeNull();
    const re = re2Engine.compile('(a+)+$');
    const t0 = performance.now();
    expect(re.firstGroup('a'.repeat(100_000) + '!')).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('plugs into extract', () => {
    const spec = {
      recordKey: { from: 'url' },
      fields: [{ name: 'sqft', type: 'integer', source: { css: 'dd' }, transforms: ['regex:(\\d+) sq'] }],
    };
    const r = extract('<dd>910 sq ft</dd>', spec, 'https://x.example.com/listings/a', { regex: re2Engine });
    expect(r?.data.sqft).toBe(910);
  });
});
