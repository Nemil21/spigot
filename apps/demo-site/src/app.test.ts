import * as cheerio from 'cheerio';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FOOTER_NOTICE, createApp } from './app.js';
import { createAccessLog } from './accessLog.js';
import { createStore } from './data/store.js';
import { isFocusListing } from './data/seed.js';
import { IN_STOCK, SOLD_OUT } from './jsonld.js';

// Small scale keeps the suite fast; the full-scale sitemap count is checked once below.
const store = createStore(0.05);
const quietLog = () => createAccessLog(() => {});
const app = createApp({ store, verifyToken: 'spigot-verify-test-token', accessLog: quietLog() });

const available = store.listings.find((l) => l.status === 'available')!;
const leased = store.listings.find((l) => l.status === 'leased')!;
const agent = store.agents[0]!;
const openHouse = store.openHouses[0]!;
const post = store.blogPosts[0]!;

function jsonLdBlocks(html: string): unknown[] {
  const $ = cheerio.load(html);
  return $('script[type="application/ld+json"]')
    .toArray()
    .map((el) => JSON.parse($(el).text()));
}

// Properties schema.org defines for each type (including inherited ones) that we use.
// Apartment → Accommodation → Place → Thing; Product → Thing; Offer → Intangible → Thing.
const THING = ['@context', '@type', '@id', 'url', 'name', 'description'];
const SCHEMA_PROPS: Record<string, string[]> = {
  Apartment: [...THING, 'numberOfRooms', 'numberOfBedrooms', 'numberOfBathroomsTotal', 'floorSize', 'address', 'containedInPlace'],
  Product: [...THING, 'offers'],
  Offer: [...THING, 'price', 'priceCurrency', 'availability'],
  QuantitativeValue: ['@type', 'value', 'unitCode', 'unitText'],
  PostalAddress: ['@type', 'streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'],
  Place: ['@type', 'name'],
};

/** Every property used is defined on (one of) the node's types; recurse into typed values. */
function validateSchemaOrg(node: Record<string, unknown>, where = '$'): string[] {
  const types = ([] as string[]).concat(node['@type'] as string | string[]);
  const allowed = new Set(types.flatMap((t) => SCHEMA_PROPS[t] ?? []));
  const errors: string[] = [];
  for (const t of types) if (!SCHEMA_PROPS[t]) errors.push(`${where}: unknown type ${t}`);
  for (const [k, v] of Object.entries(node)) {
    if (!allowed.has(k)) errors.push(`${where}.${k} is not a property of ${types.join('/')}`);
    if (v && typeof v === 'object' && !Array.isArray(v)) errors.push(...validateSchemaOrg(v as Record<string, unknown>, `${where}.${k}`));
  }
  return errors;
}

describe('pages', () => {
  it('D01 home shows the search form, featured listings and the footer', async () => {
    const res = await request(app).get('/').expect(200).expect('Content-Type', /text\/html/);
    const $ = cheerio.load(res.text);
    expect($('form.search select[name=beds]')).toHaveLength(1);
    expect($('form.search input[name=max_rent]')).toHaveLength(1);
    expect($('form.search select[name=neighbourhood] option').length).toBeGreaterThan(1);
    expect($('.featured .listing-card').length).toBeGreaterThan(0);
    expect($('footer').text()).toContain(FOOTER_NOTICE);
  });

  it('D01 search filters by min beds, max rent and neighbourhood', async () => {
    const res = await request(app).get('/search').query({ beds: 3, max_rent: 1999 }).expect(200);
    const $ = cheerio.load(res.text);
    const expected = store.listings.filter((l) => l.bedrooms >= 3 && l.price_usd <= 1999).length;
    expect($('.result-count').text()).toContain(`${expected} listing`);
    expect(expected).toBeGreaterThanOrEqual(store.listings.filter(isFocusListing).length);

    const hood = available.neighbourhood;
    const res2 = await request(app).get('/search').query({ neighbourhood: hood }).expect(200);
    const $2 = cheerio.load(res2.text);
    const n = store.listings.filter((l) => l.neighbourhood === hood).length;
    expect($2('.result-count').text()).toContain(`${n} listing`);

    await request(app).get('/search').query({ beds: 'x', max_rent: '-5', page: '0' }).expect(200);
  });

  it('D02 listing page carries valid schema.org Apartment + Offer JSON-LD matching the visible HTML', async () => {
    const res = await request(app).get(`/listings/${available.slug}`).expect(200);
    const blocks = jsonLdBlocks(res.text);
    expect(blocks).toHaveLength(1);
    const ld = blocks[0] as Record<string, any>;
    expect(validateSchemaOrg(ld)).toEqual([]);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toContain('Apartment');
    expect(ld.offers['@type']).toBe('Offer');
    expect(ld.offers.price).toBe(available.price_usd);
    expect(ld.offers.priceCurrency).toBe('USD');
    expect(ld.offers.availability).toBe(IN_STOCK);
    expect(ld.numberOfRooms).toBe(available.bedrooms);
    expect(ld.floorSize).toMatchObject({ '@type': 'QuantitativeValue', value: available.sqft, unitCode: 'FTK' });
    expect(ld.address).toMatchObject({ '@type': 'PostalAddress', streetAddress: available.street_address, addressLocality: available.city });
    expect(ld['@id']).toMatch(new RegExp(`/listings/${available.slug}$`));
    // HTML-only fields never leak into JSON-LD.
    expect(JSON.stringify(ld)).not.toContain(available.available_from);
    expect(JSON.stringify(ld)).not.toMatch(/pets/i);

    const $ = cheerio.load(res.text);
    expect($('dl.facts dd[data-k=available]').text().trim()).toBe(available.available_from);
    expect($('dl.facts dd[data-k=pets]').text().trim()).toBe(available.pets_allowed);
    expect($('dl.facts dd[data-k=bedrooms]').text().trim()).toBe(String(available.bedrooms));
    expect($('.listing-price').text()).toBe(`$${available.price_usd.toLocaleString('en-US')}`);
    expect($('.status-badge').text().trim()).toBe('Available');
    const listingAgent = store.agent(available.agent_slug)!;
    expect($('.agent-card .agent-name').text()).toBe(listingAgent.name);
    expect($('.agent-card .agent-phone').text()).toBe(listingAgent.phone);
  });

  it('D02 a leased listing shows SoldOut in JSON-LD and a "Leased" badge', async () => {
    const res = await request(app).get(`/listings/${leased.slug}`).expect(200);
    const ld = jsonLdBlocks(res.text)[0] as Record<string, any>;
    expect(ld.offers.availability).toBe(SOLD_OUT);
    const $ = cheerio.load(res.text);
    expect($('.status-badge').text().trim()).toBe('Leased');
    expect($('dl.facts dd[data-k=status]').text().trim()).toBe('Leased');
  });

  it('JSON-LD cannot break out of its script tag', async () => {
    const evil = createStore(0.05);
    evil.data.listings[0]!.title = '</script><script>alert(1)</script>';
    const res = await request(createApp({ store: evil, accessLog: quietLog() })).get(`/listings/${evil.data.listings[0]!.slug}`).expect(200);
    expect(res.text).not.toContain('<script>alert(1)');
    expect((jsonLdBlocks(res.text)[0] as { name: string }).name).toBe('</script><script>alert(1)</script>');
  });

  it('D03 agent page has no JSON-LD and stable classes', async () => {
    const res = await request(app).get(`/agents/${agent.slug}`).expect(200);
    expect(jsonLdBlocks(res.text)).toEqual([]);
    const $ = cheerio.load(res.text);
    expect($('h1.agent-name').text()).toBe(agent.name);
    expect($('.agent-phone').first().text()).toBe(agent.phone);
    expect($('dl.facts dd[data-k=brokerage]').text()).toBe(agent.brokerage);
    const active = store.listingsForAgent(agent.slug).filter((l) => l.status === 'available').length;
    expect($('dl.facts dd[data-k=active_listings]').text()).toBe(String(active));
  });

  it('D03 open house page has no JSON-LD and a <time datetime>', async () => {
    const res = await request(app).get(`/open-houses/${openHouse.id}`).expect(200);
    expect(jsonLdBlocks(res.text)).toEqual([]);
    const $ = cheerio.load(res.text);
    expect($('time.oh-start').attr('datetime')).toBe(openHouse.starts_at);
    expect($('time.oh-end').attr('datetime')).toBe(openHouse.ends_at);
    expect($('a.oh-listing').attr('href')).toBe(`/listings/${openHouse.listing_slug}`);
    expect($('a.oh-host').attr('href')).toBe(`/agents/${openHouse.host_agent_slug}`);
  });

  it('serves /about, /blog and all 10 /blog/:slug posts without JSON-LD', async () => {
    await request(app).get('/about').expect(200).expect(/not a real business/i);
    const index = await request(app).get('/blog').expect(200);
    expect(cheerio.load(index.text)('a[href^="/blog/"]')).toHaveLength(10);
    for (const p of store.blogPosts) {
      const res = await request(app).get(`/blog/${p.slug}`).expect(200);
      expect(jsonLdBlocks(res.text)).toEqual([]);
    }
    expect(post.slug).toBeTruthy();
  });

  it('returns a 404 page (with footer) for unknown slugs and ids', async () => {
    for (const p of ['/listings/nope', '/agents/nope', '/open-houses/9999', '/open-houses/1abc', '/blog/nope', '/nope']) {
      const res = await request(app).get(p).expect(404);
      expect(res.text).toContain(FOOTER_NOTICE);
    }
  });

  it('puts the footer notice on every page type', async () => {
    const paths = ['/', '/search', `/listings/${available.slug}`, `/agents/${agent.slug}`, `/open-houses/${openHouse.id}`, '/about', `/blog/${post.slug}`];
    for (const p of paths) {
      const res = await request(app).get(p).expect(200);
      expect(cheerio.load(res.text)('footer .site-notice').text()).toBe(FOOTER_NOTICE);
    }
  });
});

describe('sitemap, robots, verification', () => {
  function sitemapEntries(xml: string) {
    const $ = cheerio.load(xml, { xml: true });
    return $('url')
      .toArray()
      .map((u) => ({ loc: $(u).find('loc').text(), lastmod: $(u).find('lastmod').text() }));
  }

  it('lists every listing, agent, open house and blog page with lastmod from updated_at', async () => {
    const res = await request(app).get('/sitemap.xml').set('Host', 'bluebonnet.test').expect(200).expect('Content-Type', /xml/);
    const entries = sitemapEntries(res.text);
    const byLoc = new Map(entries.map((e) => [e.loc, e.lastmod]));
    for (const l of store.listings) expect(byLoc.get(`http://bluebonnet.test/listings/${l.slug}`)).toBe(l.updated_at);
    for (const a of store.agents) expect(byLoc.get(`http://bluebonnet.test/agents/${a.slug}`)).toBe(a.updated_at);
    for (const o of store.openHouses) expect(byLoc.get(`http://bluebonnet.test/open-houses/${o.id}`)).toBe(o.updated_at);
    for (const p of store.blogPosts) expect(byLoc.get(`http://bluebonnet.test/blog/${p.slug}`)).toBe(p.updated_at);
    expect(entries.every((e) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.lastmod))).toBe(true);
    expect(byLoc.size).toBe(entries.length);
  });

  it('at full scale has 2,341 + 88 + 40 + 10 entity URLs (+ /, /about, /blog)', async () => {
    const big = createApp({ store: createStore(1), accessLog: quietLog() });
    const entries = sitemapEntries((await request(big).get('/sitemap.xml').expect(200)).text);
    const count = (prefix: string) => entries.filter((e) => new URL(e.loc).pathname.startsWith(prefix)).length;
    expect([count('/listings/'), count('/agents/'), count('/open-houses/'), count('/blog/')]).toEqual([2341, 88, 40, 10]);
    expect(entries).toHaveLength(2341 + 88 + 40 + 10 + 3);
  });

  it('uses the forwarded proto behind a proxy', async () => {
    const res = await request(app).get('/sitemap.xml').set('Host', 'bluebonnet.onrender.test').set('X-Forwarded-Proto', 'https');
    expect(res.text).toContain('<loc>https://bluebonnet.onrender.test/</loc>');
  });

  it('serves robots.txt pointing at the sitemap', async () => {
    const res = await request(app).get('/robots.txt').set('Host', 'bluebonnet.test').expect(200).expect('Content-Type', /text\/plain/);
    expect(res.text).toContain('Sitemap: http://bluebonnet.test/sitemap.xml');
  });

  it('serves the verification token, and 404s when unset', async () => {
    const res = await request(app).get('/.well-known/spigot.txt').expect(200).expect('Content-Type', /text\/plain/);
    expect(res.text.trim()).toBe('spigot-verify-test-token');
    await request(createApp({ store, accessLog: quietLog() })).get('/.well-known/spigot.txt').expect(404);
  });
});

describe('ETag', () => {
  it.each(['/', '/search?beds=3', `/listings/${available.slug}`, `/agents/${agent.slug}`, `/open-houses/${openHouse.id}`, '/about', `/blog/${post.slug}`, '/sitemap.xml', '/robots.txt'])(
    '%s has a strong ETag and answers 304 to If-None-Match',
    async (p) => {
      // Fixed Host: supertest picks a new port per request, and sitemap/robots embed the origin.
      const get = () => request(app).get(p).set('Host', 'bluebonnet.test');
      const first = await get().expect(200);
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^"[A-Za-z0-9_-]{32}"$/);
      const again = await get().expect(200);
      expect(again.headers.etag).toBe(etag); // stable across renders
      const cached = await get().set('If-None-Match', etag).expect(304);
      expect(cached.text ?? '').toBe('');
      await get().set('If-None-Match', '"something-else"').expect(200);
    },
  );

  it('changes when the page data changes', async () => {
    const s = createStore(0.05);
    const a = createApp({ store: s, accessLog: quietLog() });
    const slug = s.data.listings[1]!.slug;
    const before = (await request(a).get(`/listings/${slug}`)).headers.etag;
    s.data.listings[1]!.price_usd += 50;
    const after = (await request(a).get(`/listings/${slug}`)).headers.etag;
    expect(after).not.toBe(before);
  });

  it('supports HEAD with the same ETag', async () => {
    const get = await request(app).get('/about');
    const head = await request(app).head('/about').expect(200);
    expect(head.headers.etag).toBe(get.headers.etag);
  });
});

describe('gate mount point and access log', () => {
  it('runs the gate before every route (and the default gate is a no-op)', async () => {
    const seen: string[] = [];
    const gate: RequestHandler = (req, res, next) => {
      seen.push(req.path);
      if (req.get('user-agent') === 'BadBot') {
        res.status(402).type('text/plain').send('pay');
        return;
      }
      next();
    };
    const gated = createApp({ store, gate, accessLog: quietLog() });
    await request(gated).get(`/listings/${available.slug}`).set('User-Agent', 'BadBot').expect(402);
    await request(gated).get('/sitemap.xml').set('User-Agent', 'BadBot').expect(402);
    await request(gated).get(`/listings/${available.slug}`).set('User-Agent', 'Mozilla/5.0').expect(200);
    expect(seen).toEqual([`/listings/${available.slug}`, '/sitemap.xml', `/listings/${available.slug}`]);
  });

  it('logs method, path, UA, status and in-flight count as one JSON line per request', async () => {
    const lines: string[] = [];
    const a = createApp({ store, accessLog: createAccessLog((l) => lines.push(l)) });
    await request(a).get('/about?x=1').set('User-Agent', 'TestBot/1.0').expect(200);
    await request(a).get('/nope').set('User-Agent', 'TestBot/1.0').expect(404);
    const [ok, missing] = lines.map((l) => JSON.parse(l));
    expect(ok).toMatchObject({ method: 'GET', path: '/about', status: 200, ua: 'TestBot/1.0', inflight: 1 });
    expect(missing).toMatchObject({ path: '/nope', status: 404 });
  });

  it('counts concurrent requests in the gauge', async () => {
    const log = quietLog();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let arrived = 0;
    const slowGate: RequestHandler = (_req, _res, next) => {
      arrived += 1;
      void hold.then(() => next());
    };
    const a = createApp({ store, gate: slowGate, accessLog: log });
    const server = a.listen(0);
    try {
      const pending = [1, 2, 3].map(() => request(server).get('/about'));
      const all = Promise.all(pending.map((p) => p.then((r) => r.status)));
      while (arrived < 3) await new Promise((r) => setTimeout(r, 5));
      expect(log.stats().inFlight).toBe(3);
      release();
      expect(await all).toEqual([200, 200, 200]);
      expect(log.stats()).toMatchObject({ inFlight: 0, maxInFlight: 3, total: 3 });
      log.reset();
      expect(log.stats()).toMatchObject({ maxInFlight: 0, total: 0 });
    } finally {
      server.close();
    }
  });

  it('/healthz reports counts', async () => {
    const res = await request(app).get('/healthz').expect(200);
    expect(res.body).toEqual({ ok: true, counts: { listings: 117, agents: 4, openHouses: 2, blogPosts: 10 } });
  });
});
