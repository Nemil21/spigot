import { describe, expect, it } from 'vitest';
import {
  MutationError,
  applyEntry,
  nextStamp,
  pageIndex,
  parseFocus,
  parseMutateOptions,
  planMutation,
  planReset,
  type LogEntry,
} from './mutations.js';
import { generateSeed, isFocusListing } from './seed.js';
import type { SiteData } from './types.js';

const NOW = new Date('2026-11-12T10:00:00Z');
const DEMO_FOCUS = 'bedrooms>=3,price_usd<2000,city=Austin';
const opts = (o: Record<string, unknown>) => parseMutateOptions(o, () => 7);

// Scale 1: the real 2,341 listings (74 in the demo focus population), as in the video.
const full = () => generateSeed(1);

function diff(before: SiteData, after: SiteData) {
  const prev = new Map(before.listings.map((l) => [l.slug, l]));
  const price: string[] = [];
  const status: string[] = [];
  const added: string[] = [];
  for (const l of after.listings) {
    const p = prev.get(l.slug);
    if (!p) added.push(l.slug);
    else {
      if (p.price_usd !== l.price_usd) price.push(l.slug);
      if (p.status !== l.status) status.push(l.slug);
    }
  }
  return { price, status, added };
}

describe('planMutation', () => {
  it('--prices 30 --leased 5 --new 3 changes exactly 30 rents, 5 statuses and adds 3, on disjoint listings', () => {
    const before = full();
    const after = full();
    const entry = planMutation(after, opts({ prices: 30, leased: 5, new: 3, seed: 42 }), NOW);
    applyEntry(after, entry);

    const d = diff(before, after);
    expect(d.price).toHaveLength(30);
    expect(d.status).toHaveLength(5);
    expect(d.added).toHaveLength(3);
    expect(after.listings).toHaveLength(2341 + 3);
    const all = [...d.price, ...d.status, ...d.added];
    expect(new Set(all).size).toBe(38); // disjoint
    expect(new Set(d.price)).toEqual(new Set(entry.prices.map((p) => p.slug)));
    expect(new Set(d.status)).toEqual(new Set(entry.leased));
    for (const slug of entry.leased) expect(after.listings.find((l) => l.slug === slug)!.status).toBe('leased');
    for (const l of entry.added) {
      expect(l.status).toBe('available');
      expect(after.listings.filter((x) => x.slug === l.slug)).toHaveLength(1);
      expect(new Set(after.listings.map((x) => x.id)).size).toBe(after.listings.length);
    }
  });

  it('changes rents by 3–8% either way, rounded to $5, and only re-prices or leases available listings', () => {
    const data = full();
    const bySlug = new Map(data.listings.map((l) => [l.slug, l]));
    const entry = planMutation(data, opts({ prices: 30, leased: 5, seed: 3 }), NOW);
    for (const p of entry.prices) {
      const ratio = Math.abs(p.to - p.from) / p.from;
      expect(ratio).toBeGreaterThanOrEqual(0.03);
      expect(ratio).toBeLessThanOrEqual(0.08);
      expect(p.to % 5).toBe(0);
      expect(bySlug.get(p.slug)!.status).toBe('available');
    }
    for (const slug of entry.leased) expect(bySlug.get(slug)!.status).toBe('available');
    expect(entry.prices.some((p) => p.to > p.from)).toBe(true);
    expect(entry.prices.some((p) => p.to < p.from)).toBe(true);
  });

  it('is reproducible: same data + same seed → same slugs; another seed → different ones', () => {
    const a = planMutation(full(), opts({ prices: 30, leased: 5, new: 3, seed: 42 }), NOW);
    const b = planMutation(full(), opts({ prices: 30, leased: 5, new: 3, seed: 42 }), new Date('2026-12-01T00:00:00Z'));
    const c = planMutation(full(), opts({ prices: 30, leased: 5, new: 3, seed: 43 }), NOW);
    const slugs = (e: typeof a) => ({ prices: e.prices, leased: e.leased, added: e.added.map((l) => l.slug) });
    expect(slugs(b)).toEqual(slugs(a));
    expect(slugs(c).prices).not.toEqual(slugs(a).prices);
  });

  it('with --focus, all price changes stay inside the filter and all new listings match it', () => {
    const data = full();
    const focus = parseFocus(DEMO_FOCUS);
    const entry = planMutation(data, opts({ prices: 30, leased: 5, new: 3, seed: 42, focus: DEMO_FOCUS }), NOW);
    const bySlug = new Map(data.listings.map((l) => [l.slug, l]));
    expect(entry.prices).toHaveLength(30);
    for (const p of entry.prices) {
      const l = bySlug.get(p.slug)!;
      expect(focus.matches(l)).toBe(true);
      expect(focus.matches({ ...l, price_usd: p.to })).toBe(true);
      expect(isFocusListing({ ...l, price_usd: p.to })).toBe(true);
    }
    expect(entry.added).toHaveLength(3);
    for (const l of entry.added) expect(isFocusListing(l)).toBe(true);
    applyEntry(data, entry);
    for (const p of entry.prices) expect(focus.matches(data.listings.find((l) => l.slug === p.slug)!)).toBe(true);
  });

  it('fails clearly when the focus population is too small', () => {
    expect(() => planMutation(full(), opts({ prices: 200, seed: 1, focus: DEMO_FOCUS }), NOW)).toThrow(MutationError);
    expect(() => planMutation(full(), opts({ new: 1, seed: 1, focus: 'city=Nowhere' }), NOW)).toThrow(/no listing matches/);
  });

  it('touches only the changed listings and the agent / open-house pages that render them', () => {
    const data = generateSeed(0.05);
    const entry = planMutation(data, opts({ prices: 10, leased: 3, new: 2, seed: 5 }), NOW);
    const expected = new Set<string>();
    for (const p of entry.prices) {
      const l = data.listings.find((x) => x.slug === p.slug)!;
      expected.add(`/listings/${l.slug}`).add(`/agents/${l.agent_slug}`);
      for (const o of data.openHouses) if (o.listing_slug === l.slug) expected.add(`/open-houses/${o.id}`);
    }
    for (const slug of entry.leased) {
      const l = data.listings.find((x) => x.slug === slug)!;
      expected.add(`/listings/${slug}`).add(`/agents/${l.agent_slug}`);
    }
    for (const l of entry.added) expected.add(`/listings/${l.slug}`).add(`/agents/${l.agent_slug}`);
    expect(new Set(entry.touched)).toEqual(expected);

    const before = new Map([...pageIndex(data)].map(([p, r]) => [p, r.updated_at]));
    applyEntry(data, entry);
    for (const [path, page] of pageIndex(data)) {
      if (expected.has(path)) expect(page.updated_at).toBe(entry.at);
      else expect(page.updated_at).toBe(before.get(path));
    }
  });
});

describe('planReset', () => {
  it('restores seed content, drops added listings and moves reverted pages’ lastmod forward', () => {
    const data = generateSeed(0.05);
    const log: LogEntry[] = [];
    const m = planMutation(data, opts({ prices: 5, leased: 2, new: 1, seed: 9 }), NOW);
    applyEntry(data, m);
    log.push(m);
    // Reset in the same second as the mutation: lastmod must still move forward.
    const r = planReset(data, log, NOW);
    expect(r.at > m.at).toBe(true);
    expect(r.removed).toEqual([m.added[0]!.slug]);
    expect(r.reverted).toEqual(m.touched.filter((p) => p !== `/listings/${m.added[0]!.slug}`));
    applyEntry(data, r);

    const seed = generateSeed(0.05);
    const strip = (d: SiteData) => d.listings.map(({ updated_at: _u, ...rest }) => rest);
    expect(strip(data)).toEqual(strip(seed));
    for (const [path, page] of pageIndex(data)) {
      expect(page.updated_at).toBe(r.reverted.includes(path) ? r.at : pageIndex(seed).get(path)!.updated_at);
    }

    // A second reset with nothing new keeps the first reset's lastmod (never moves backwards).
    const r2 = planReset(data, [r], new Date('2026-11-13T00:00:00Z'));
    expect(r2.reverted).toEqual([]);
    expect(r2.lastmod).toEqual(r.lastmod);
  });
});

describe('options and focus parsing', () => {
  it('parses CLI strings and JSON numbers alike, and rejects bad input', () => {
    expect(opts({ prices: '30', leased: '5', new: '3', seed: '42' })).toEqual({ prices: 30, leased: 5, new: 3, seed: 42, focus: undefined, ping: false });
    expect(opts({ prices: 1 }).seed).toBe(7);
    expect(opts({ prices: 1, ping: true }).ping).toBe(true);
    expect(() => opts({})).toThrow(/nothing to change/);
    expect(() => opts({ prices: -1 })).toThrow(MutationError);
    expect(() => opts({ prices: 1.5 })).toThrow(MutationError);
    expect(() => opts({ prices: 100_000 })).toThrow(MutationError);
    expect(() => opts({ prices: 1, seed: 'x' })).toThrow(/seed/);
    expect(() => opts({ prices: 1, focus: 'colour=red' })).toThrow(/unknown field/);
    expect(() => opts({ prices: 1, focus: 'city>Austin' })).toThrow(/only supports/);
    expect(() => opts({ prices: 1, focus: 'bedrooms>=many' })).toThrow(/number/);
  });

  it('evaluates every operator', () => {
    const l = generateSeed(0.05).listings[0]!; // a focus listing: Austin, ≥ 3 beds, < $2,000
    expect(parseFocus(DEMO_FOCUS).matches(l)).toBe(true);
    expect(parseFocus('city=austin').matches(l)).toBe(true);
    expect(parseFocus('city!=Austin').matches(l)).toBe(false);
    expect(parseFocus(`price_usd<=${l.price_usd},price_usd>=${l.price_usd},price_usd=${l.price_usd}`).matches(l)).toBe(true);
    expect(parseFocus(`price_usd>${l.price_usd}`).matches(l)).toBe(false);
    expect(parseFocus(`price_usd!=${l.price_usd}`).matches(l)).toBe(false);
  });

  it('nextStamp is ≥ now and strictly after every previous stamp', () => {
    expect(nextStamp(new Date('2026-11-12T10:00:00.900Z'), [])).toBe('2026-11-12T10:00:00Z');
    expect(nextStamp(NOW, ['2026-11-12T10:00:00Z', '2026-11-12T09:00:00Z'])).toBe('2026-11-12T10:00:01Z');
  });
});
