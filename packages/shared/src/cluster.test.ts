import { describe, expect, it } from 'vitest';
import { clusterUrls, seededSample, urlPath, type ClusterPage } from './cluster.js';

const ORIGIN = 'https://bluebonnet.example.com';
const HOODS = [
  'mueller',
  'cherrywood',
  'zilker',
  'hyde-park',
  'bouldin',
  'east-cesar-chavez',
  'tarrytown',
];
const STREETS = ['aldrich-st', 'manor-rd', 'barton-springs-rd', 'speedway', 's-1st-st'];

/** URL list shaped like the demo site (features/01): 2,341 / 88 / 40 plus unstructured pages. */
function demoSite(opts: { openHouseId?: (i: number) => string } = {}) {
  const pages: ClusterPage[] = [];
  const types = new Map<string, string[]>();
  const add = (path: string, jsonld: string[] = []) => {
    const url = ORIGIN + path;
    pages.push({ id: `p${String(pages.length).padStart(5, '0')}`, url });
    if (jsonld.length) types.set(url, jsonld);
  };
  add('/');
  add('/search');
  add('/about');
  for (let i = 0; i < 2341; i++) {
    const slug = `${(i % 4) + 1}br-${HOODS[i % HOODS.length]}-${100 + i}-${STREETS[i % STREETS.length]}-${i}`;
    add(`/listings/${slug}`, ['Apartment', 'Offer']);
  }
  for (let i = 0; i < 88; i++) add(`/agents/agent-${i}-okafor`);
  for (let i = 0; i < 40; i++)
    add(`/open-houses/${opts.openHouseId ? opts.openHouseId(i) : String(1000 + i)}`);
  for (let i = 0; i < 10; i++) add(`/blog/five-things-to-ask-${i}`);
  return { pages, types };
}

describe('clusterUrls on the demo site', () => {
  it('finds exactly Listing, Agent and Open House; drops /blog/* and /about', () => {
    const { pages, types } = demoSite();
    const t = clusterUrls(pages, types);
    expect(t.map((x) => [x.pathPattern, x.pageCount, x.jsonldTypes])).toEqual([
      ['/listings/:slug', 2341, ['Apartment', 'Offer']],
      ['/agents/:slug', 88, []],
      ['/open-houses/:id', 40, []],
    ]);
    expect(t.map((x) => x.urlPattern)).toEqual([
      '^/listings/[a-z0-9-]+$',
      '^/agents/[a-z0-9-]+$',
      '^/open-houses/[0-9]+$',
    ]);
  });

  it('url_pattern regexes match their own pages and nothing else', () => {
    const { pages, types } = demoSite();
    const t = clusterUrls(pages, types);
    const byId = new Map(pages.map((p) => [p.id, urlPath(p.url)!]));
    for (const tpl of t) {
      const re = new RegExp(tpl.urlPattern);
      const matching = pages
        .filter((p) => re.test(urlPath(p.url)!))
        .map((p) => p.id)
        .sort();
      expect(matching).toEqual(tpl.pageIds);
      expect(tpl.pageIds.every((id) => re.test(byId.get(id)!))).toBe(true);
    }
    for (const path of ['/about', '/blog/five-things-to-ask-0', '/', '/search']) {
      expect(t.some((tpl) => new RegExp(tpl.urlPattern).test(path))).toBe(false);
    }
  });

  it('names prefixed ids like `oh-12` as :id too', () => {
    const { pages, types } = demoSite({ openHouseId: (i) => `oh-${i + 1}` });
    const oh = clusterUrls(pages, types).find((x) => x.pathPattern.startsWith('/open-houses'));
    expect(oh?.pathPattern).toBe('/open-houses/:id');
    expect(oh?.urlPattern).toBe('^/open-houses/[a-z0-9-]+$');
  });

  it('picks 5 sample pages from the template', () => {
    const { pages, types } = demoSite();
    for (const tpl of clusterUrls(pages, types)) {
      expect(tpl.samplePageIds).toHaveLength(5);
      expect(new Set(tpl.samplePageIds).size).toBe(5);
      for (const id of tpl.samplePageIds) expect(tpl.pageIds).toContain(id);
    }
  });
});

describe('deterministic samples', () => {
  it('same input (in any order) gives the same sample ids', () => {
    const { pages, types } = demoSite();
    const a = clusterUrls(pages, types);
    const b = clusterUrls([...pages].reverse(), new Map([...types].reverse()));
    expect(b).toEqual(a);
    expect(clusterUrls(pages, types)).toEqual(a);
  });

  it('a different seed picks different samples', () => {
    const { pages, types } = demoSite();
    const a = clusterUrls(pages, types)[0]!.samplePageIds;
    const b = clusterUrls(pages, types, { seed: 'other' })[0]!.samplePageIds;
    expect(b).not.toEqual(a);
  });

  it('samples are not just the first ids', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id${String(i).padStart(3, '0')}`);
    const s = seededSample(ids, 5, 'x');
    expect(s).not.toEqual(ids.slice(0, 5));
    expect(seededSample(ids, 5, 'x')).toEqual(s);
    expect(seededSample(ids.slice(0, 3), 5, 'x')).toHaveLength(3);
  });
});

describe('grouping rules', () => {
  const range = <T>(n: number, f: (i: number) => T): T[] =>
    Array.from({ length: n }, (_, i) => f(i));

  it('a segment with < 20 distinct values stays literal, so its 1-page groups are dropped', () => {
    const urls = range(19, (i) => `/news/story-${i}`);
    expect(clusterUrls(urls)).toEqual([]);
    expect(clusterUrls([...urls, '/news/story-19'])).toMatchObject([
      { pathPattern: '/news/:slug', pageCount: 20 },
    ]);
  });

  it('drops groups with fewer than 10 pages', () => {
    const urls = range(25, (i) => `/a/x-${i}`);
    expect(clusterUrls(urls.slice(0, 20), {}, { minPages: 21 })).toEqual([]);
    expect(clusterUrls(urls, {}, { paramMinDistinct: 5 })).toHaveLength(1);
  });

  it('splits a URL group by JSON-LD @type when mixed, dropping the small part', () => {
    const urls = range(60, (i) => `https://s.example/items/widget-${i}`);
    const types: Record<string, string[]> = {};
    urls.forEach((u, i) => (types[u] = i < 30 ? ['Product'] : i < 55 ? ['Event'] : ['Place']));
    const t = clusterUrls(urls, types);
    expect(t.map((x) => [x.pathPattern, x.jsonldTypes, x.pageCount])).toEqual([
      ['/items/:slug', ['Product'], 30],
      ['/items/:slug', ['Event'], 25],
    ]);
    expect(new Set([...t[0]!.samplePageIds, ...t[1]!.samplePageIds]).size).toBe(10);
  });

  it('orders equal-sized type splits the same way for any input order', () => {
    const urls = range(40, (i) => `/items/widget-${i}`);
    const types = Object.fromEntries(urls.map((u, i) => [u, i % 2 ? ['Product'] : ['Event']]));
    const a = clusterUrls(urls, types);
    expect(a.map((x) => x.jsonldTypes)).toEqual([['Event'], ['Product']]);
    expect(clusterUrls([...urls].reverse(), types)).toEqual(a);
  });

  it('JSON-LD type order and duplicates do not split a group', () => {
    const urls = range(20, (i) => `/l/${i}`);
    const types = Object.fromEntries(
      urls.map((u, i) => [u, i % 2 ? ['Offer', 'Apartment', 'Offer'] : ['Apartment', 'Offer']]),
    );
    expect(clusterUrls(urls, types)).toMatchObject([
      { pageCount: 20, jsonldTypes: ['Apartment', 'Offer'] },
    ]);
  });

  it('ignores query, fragment and trailing slash; de-duplicates page ids', () => {
    const pages = range(20, (i) => ({
      id: `p${i}`,
      url: `https://s.example/agents/agent-${i}-lee/?ref=x#top`,
    }));
    const t = clusterUrls([...pages, pages[0]!]);
    expect(t).toMatchObject([
      { pathPattern: '/agents/:slug', pageCount: 20, urlPattern: '^/agents/[a-z0-9-]+$' },
    ]);
  });

  it('handles nested params and keeps literal siblings separate', () => {
    const urls = [
      ...range(30, (i) => `/shop/${1000 + i}/reviews/${i}`),
      ...range(12, () => '/shop/all').map((u, i) => `${u}?page=${i}`),
    ];
    const t = clusterUrls(urls, {}, { minPages: 10 });
    // `/shop/all` has 12 URLs but one path, so it is one page id per URL string here.
    expect(t.map((x) => x.pathPattern)).toEqual(['/shop/:id/reviews/:id2', '/shop/all']);
    expect(t[0]!.urlPattern).toBe('^/shop/[0-9]+/reviews/[0-9]+$');
  });

  it('escapes regex metacharacters in literal segments', () => {
    const urls = range(20, (i) => `/a.b/${i}`);
    expect(clusterUrls(urls)[0]!.urlPattern).toBe('^/a\\.b/[0-9]+$');
  });

  it('skips unparseable URLs', () => {
    expect(clusterUrls([{ id: 'x', url: 'http://[bad' }])).toEqual([]);
  });
});
