import { clusterUrls } from '@spigot/shared';
import { describe, expect, it } from 'vitest';
import { aggregateBuckets, MAX_INT4 } from './hits.js';
import { gatedPathFor } from './policy.js';

describe('gatedPathFor', () => {
  it.each([
    ['^/listings/[a-z0-9-]+$', '^/listings/'],
    ['^/agents/[0-9]+$', '^/agents/'],
    ['^/shop/all/[a-z0-9-]+/reviews$', '^/shop/all/'],
    ['^/open\\-houses/[a-z0-9-]+$', '^/open\\-houses/'],
    ['^/listings/[a-z0-9-]+/$', '^/listings/'],
    // All literal: already exact.
    ['^/about$', '^/about$'],
    ['^/$', '^/$'],
    // First segment is a parameter: a `^/` prefix would gate the whole site, so keep it exact.
    ['^/[a-z0-9-]+$', '^/[a-z0-9-]+$'],
    // Not an anchored path pattern: kept as is.
    ['/listings/.*', '/listings/.*'],
  ])('%s → %s', (pattern, gated) => {
    expect(gatedPathFor(pattern)).toBe(gated);
  });

  it("matches the patterns SP-010's clustering stores", () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://example.com/listings/home-${i}`);
    const [t] = clusterUrls(urls);
    expect(t!.urlPattern).toBe('^/listings/[a-z0-9-]+$');
    const gated = new RegExp(gatedPathFor(t!.urlPattern));
    expect(gatedPathFor(t!.urlPattern)).toBe('^/listings/');
    expect(gated.test('/listings/a-1')).toBe(true);
    expect(gated.test('/robots.txt')).toBe(false);
    expect(gated.test('/')).toBe(false);
  });
});

describe('aggregateBuckets', () => {
  const b = (over: Partial<Parameters<typeof aggregateBuckets>[0][number]> = {}) => ({
    bucket: '2026-11-11T17:42:00Z',
    category: 'AI_TRAINING' as const,
    botName: 'GPTBot',
    decision: 'QUOTE_402' as const,
    hits: 1,
    bytes: 10,
    isSimulated: false,
    ...over,
  });

  it('sums repeated keys within one post (one upsert row per key)', () => {
    const rows = aggregateBuckets([
      b({ hits: 2 }),
      b({ hits: 3, bytes: 5, bucket: '2026-11-11T17:42:00.000Z' }),
    ]);
    expect(rows).toEqual([expect.objectContaining({ hits: 5, bytes: 15 })]);
  });

  it('keeps SIM and real, and other keys, apart', () => {
    const rows = aggregateBuckets([
      b(),
      b({ isSimulated: true }),
      b({ decision: 'PASS' }),
      b({ botName: 'ClaudeBot' }),
      b({ bucket: '2026-11-11T17:43:00Z' }),
    ]);
    expect(rows).toHaveLength(5);
  });

  it('clamps a sum to the int column', () => {
    const [row] = aggregateBuckets([b({ hits: MAX_INT4 }), b({ hits: 5 })]);
    expect(row!.hits).toBe(MAX_INT4);
  });
});
