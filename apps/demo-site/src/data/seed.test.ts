import { describe, expect, it } from 'vitest';
import { FOCUS_EVERY, countsForScale, generateSeed, isFocusListing } from './seed.js';

const full = generateSeed(1);

describe('seed', () => {
  it('has exactly 2,341 listings, 88 agents, 40 open houses and 10 blog posts at scale 1', () => {
    expect(full.listings).toHaveLength(2341);
    expect(full.agents).toHaveLength(88);
    expect(full.openHouses).toHaveLength(40);
    expect(full.blogPosts).toHaveLength(10);
  });

  it('is deterministic: same slugs and same data on every run', () => {
    const again = generateSeed(1);
    expect(again.listings.map((l) => l.slug)).toEqual(full.listings.map((l) => l.slug));
    expect(again.agents.map((a) => a.slug)).toEqual(full.agents.map((a) => a.slug));
    expect(JSON.stringify(again)).toBe(JSON.stringify(full));
  });

  it('pins a few slugs so a faker upgrade that changes output fails loudly', () => {
    expect(full.listings[0]!.slug).toBe('3br-tarrytown-grackle-pass-1');
    expect(full.agents[0]!.slug).toBe('neil-mosciski-fisher');
    expect(full.listings.at(-1)!.slug).toMatch(/-2341$/);
  });

  it('scales counts for CI (0.05 → 117 / 4 / 2)', () => {
    expect(countsForScale(0.05)).toEqual({ listings: 117, agents: 4, openHouses: 2 });
    const small = generateSeed(0.05);
    expect([small.listings.length, small.agents.length, small.openHouses.length]).toEqual([117, 4, 2]);
  });

  it('rejects a non-positive or non-numeric scale', () => {
    expect(() => countsForScale(0)).toThrow(/DEMO_SEED_SCALE/);
    expect(() => countsForScale(Number('abc'))).toThrow(/DEMO_SEED_SCALE/);
  });

  it('has unique slugs and ids, and every reference resolves', () => {
    const listingSlugs = new Set(full.listings.map((l) => l.slug));
    const agentSlugs = new Set(full.agents.map((a) => a.slug));
    expect(listingSlugs.size).toBe(full.listings.length);
    expect(agentSlugs.size).toBe(full.agents.length);
    expect(new Set(full.openHouses.map((o) => o.id)).size).toBe(full.openHouses.length);
    for (const l of full.listings) expect(agentSlugs.has(l.agent_slug)).toBe(true);
    for (const o of full.openHouses) {
      expect(listingSlugs.has(o.listing_slug)).toBe(true);
      expect(agentSlugs.has(o.host_agent_slug)).toBe(true);
    }
    for (const s of [...listingSlugs, ...agentSlugs]) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('uses only fictional 555-01xx phones and @example.com emails', () => {
    for (const a of full.agents) {
      expect(a.phone).toMatch(/^\(512\) 555-01\d\d$/);
      expect(a.email).toMatch(/^[a-z0-9.]+@example\.com$/);
    }
    expect(new Set(full.agents.map((a) => a.phone)).size).toBe(full.agents.length);
    // Grep-style check over all generated data: no other phone-like or email-like strings.
    const blob = JSON.stringify(full);
    const phones = blob.match(/\d{3}[-.\s]\d{4}\b/g) ?? [];
    expect(phones.filter((p) => !/^555-01\d\d$/.test(p))).toEqual([]);
    const emails = blob.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    expect(emails.length).toBe(full.agents.length);
    expect(emails.filter((e) => !e.endsWith('@example.com'))).toEqual([]);
  });

  it('guarantees ≥ 60 listings in the demo query population (Austin, ≥ 3 beds, < $2,000)', () => {
    const focus = full.listings.filter(isFocusListing);
    expect(focus.length).toBeGreaterThanOrEqual(60);
    expect(focus.every((l) => l.status === 'available')).toBe(true);
    // Every FOCUS_EVERY-th listing is in it, so the population is stable across scales.
    full.listings.filter((_, i) => i % FOCUS_EVERY === 0).forEach((l) => expect(isFocusListing(l)).toBe(true));
  });

  it('has some leased listings and sane listing facts', () => {
    expect(full.listings.some((l) => l.status === 'leased')).toBe(true);
    for (const l of full.listings) {
      expect(l.price_usd).toBeGreaterThan(500);
      expect(Number.isInteger(l.price_usd)).toBe(true);
      expect(l.available_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(l.created_at <= l.updated_at).toBe(true);
    }
  });

  it('schedules open houses on weekends for available listings, end after start', () => {
    for (const o of full.openHouses) {
      const listing = full.listings.find((l) => l.slug === o.listing_slug)!;
      expect(listing.status).toBe('available');
      expect(o.starts_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00-06:00$/);
      expect(Date.parse(o.ends_at)).toBeGreaterThan(Date.parse(o.starts_at));
      const weekday = new Date(`${o.starts_at.slice(0, 10)}T12:00:00Z`).getUTCDay();
      expect([0, 6]).toContain(weekday);
    }
  });
});
