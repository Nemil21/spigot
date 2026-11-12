import * as cheerio from 'cheerio';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, parseDemoLayout } from './app.js';
import { createAccessLog } from './accessLog.js';
import { createStore } from './data/store.js';

// DEMO_LAYOUT=v2 (SP-052a): the "redesign" that the drift check must catch.
const store = createStore(0.05);
const quietLog = () => createAccessLog(() => {});
const since = new Date('2030-01-02T03:04:05.678Z');
const v1 = createApp({ store, accessLog: quietLog() });
const v2 = createApp({ store, accessLog: quietLog(), layout: 'v2', layoutSince: since });
const listing = store.listings.find((l) => l.status === 'available')!;
const agent = store.agent(listing.agent_slug)!;

const jsonLd = (html: string) => cheerio.load(html)('script[type="application/ld+json"]').text();

describe('DEMO_LAYOUT', () => {
  it('parses v2 (any case) and defaults to v1', () => {
    expect(parseDemoLayout('v2')).toBe('v2');
    expect(parseDemoLayout(' V2 ')).toBe('v2');
    expect(parseDemoLayout(undefined)).toBe('v1');
    expect(parseDemoLayout('')).toBe('v1');
    expect(parseDemoLayout('v3')).toBe('v1');
  });

  it('v2 renames every listing CSS hook the v1 extractor uses, keeps the data and JSON-LD', async () => {
    const [a, b] = await Promise.all([
      request(v1).get(`/listings/${listing.slug}`).set('Host', 'bluebonnet.test').expect(200),
      request(v2).get(`/listings/${listing.slug}`).set('Host', 'bluebonnet.test').expect(200),
    ]);
    const $1 = cheerio.load(a.text);
    const $2 = cheerio.load(b.text);
    // The v1 selectors (recorded Listing proposal + extract fixtures) match on v1 only.
    for (const sel of [
      'dl.facts dd[data-k=available]',
      'dl.facts dd[data-k=pets]',
      'dl.facts dd[data-k=status]',
      '.agent-card .agent-name',
      '.agent-card .agent-phone',
      '.status-badge',
      '.listing-title',
      '.listing-price',
      '.listing-address',
      '.listing-description',
    ]) {
      expect($1(sel).length, `v1 ${sel}`).toBeGreaterThan(0);
      expect($2(sel).length, `v2 ${sel}`).toBe(0);
    }
    // Same facts under the new names; available_from moved out of the facts list.
    expect($2('.rental-name').text()).toBe(listing.title);
    expect($2('.avail-pill').text().trim()).toBe('Available');
    expect($2('.contact-box .contact-tel').text()).toBe(agent.phone);
    expect($2('dl.specs dd[data-spec=pet-policy]').text()).toBe(listing.pets_allowed);
    expect($2('.move-in time.move-in-date').attr('datetime')).toBe(listing.available_from);
    expect($2('dl.specs').text()).not.toContain(listing.available_from);
    // Structured data is untouched by the redesign.
    expect(jsonLd(b.text)).toBe(jsonLd(a.text));
    // A different body → a different ETag, so a conditional GET sees the change.
    expect(b.headers.etag).not.toBe(a.headers.etag);
  });

  it('v2 leaves the other pages alone', async () => {
    for (const path of ['/', `/agents/${agent.slug}`, '/about']) {
      const [a, b] = await Promise.all([request(v1).get(path), request(v2).get(path)]);
      expect(b.status).toBe(200);
      expect(b.headers.etag, path).toBe(a.headers.etag);
    }
  });

  it('v2 bumps listing lastmod to the layout switch time (a scheduled crawl re-fetches them)', async () => {
    const lastmods = async (app: typeof v1) => {
      const $ = cheerio.load((await request(app).get('/sitemap.xml').expect(200)).text, {
        xml: true,
      });
      return new Map(
        $('url')
          .toArray()
          .map((u) => [new URL($(u).find('loc').text()).pathname, $(u).find('lastmod').text()]),
      );
    };
    const [m1, m2] = await Promise.all([lastmods(v1), lastmods(v2)]);
    expect(m1.get(`/listings/${listing.slug}`)).toBe(listing.updated_at);
    expect(m2.get(`/listings/${listing.slug}`)).toBe('2030-01-02T03:04:05Z');
    expect(m2.get(`/agents/${agent.slug}`)).toBe(m1.get(`/agents/${agent.slug}`));
    // A layout switch older than the listing's own edit keeps the edit's lastmod.
    const old = createApp({ store, accessLog: quietLog(), layout: 'v2', layoutSince: new Date(0) });
    expect((await lastmods(old)).get(`/listings/${listing.slug}`)).toBe(listing.updated_at);
  });
});
