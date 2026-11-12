import { describe, expect, it } from 'vitest';
import { InvalidUrlError, normalizeOnOrigin, normalizeUrl, originOf } from './normalizeUrl.js';

describe('normalizeUrl', () => {
  it.each([
    ['https://Example.COM/a?b=2&a=1#frag', 'https://example.com/a?a=1&b=2'],
    ['http://example.com:80/x', 'http://example.com/x'],
    ['https://example.com:443', 'https://example.com/'],
    ['https://example.com/a/../b/./c', 'https://example.com/b/c'],
    ['https://example.com/p?', 'https://example.com/p'],
    ['https://example.com/p?z=1&a=2&z=0', 'https://example.com/p?a=2&z=1&z=0'],
    ['  https://example.com/q?x=a%20b  ', 'https://example.com/q?x=a+b'],
  ])('%s → %s', (input, out) => {
    expect(normalizeUrl(input)).toBe(out);
  });

  it('is idempotent', () => {
    const once = normalizeUrl('https://ex.com/a?c=3&b=2&a=1#x');
    expect(normalizeUrl(once)).toBe(once);
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('/listings/1?b=1&a=2', 'https://ex.com/sitemap.xml')).toBe(
      'https://ex.com/listings/1?a=2&b=1',
    );
  });

  it.each([
    'not a url',
    'ftp://ex.com/a',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://u:p@ex.com/',
  ])('rejects %s', (input) => {
    expect(() => normalizeUrl(input)).toThrow(InvalidUrlError);
  });

  it('originOf / normalizeOnOrigin', () => {
    expect(originOf('HTTPS://Ex.com:443/a')).toBe('https://ex.com');
    expect(normalizeOnOrigin('/a#b', 'https://ex.com')).toBe('https://ex.com/a');
    expect(normalizeOnOrigin('https://other.com/a', 'https://ex.com')).toBeNull();
    expect(normalizeOnOrigin('http://ex.com/a', 'https://ex.com')).toBeNull();
    expect(normalizeOnOrigin('https://ex.com:8443/a', 'https://ex.com')).toBeNull();
    expect(normalizeOnOrigin('mailto:a@b.c', 'https://ex.com')).toBeNull();
  });
});
