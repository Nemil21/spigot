import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveCrawlKey } from './crawlKey.js';

const SECRET = 's'.repeat(32);
const SITE = '00000000-0000-4000-8000-000000000001';

describe('deriveCrawlKey versions (SP-034 rotation)', () => {
  it('version 1 is the original derivation, so existing sites keep their key', () => {
    const v1 = `ck_${createHmac('sha256', SECRET).update(`spigot-crawl-key:v1:${SITE}`).digest('base64url')}`;
    expect(deriveCrawlKey(SITE, SECRET)).toBe(v1);
    expect(deriveCrawlKey(SITE, SECRET, 1)).toBe(v1);
  });

  it('each version is a different, stable key', () => {
    const keys = [1, 2, 3, 10].map((v) => deriveCrawlKey(SITE, SECRET, v));
    expect(new Set(keys).size).toBe(4);
    expect(deriveCrawlKey(SITE, SECRET, 2)).toBe(keys[1]);
  });

  it('rejects a version below 1 or not an integer', () => {
    for (const v of [0, -1, 1.5, Number.NaN]) {
      expect(() => deriveCrawlKey(SITE, SECRET, v)).toThrow(/bad version/);
    }
  });
});
