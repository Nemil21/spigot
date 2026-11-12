import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { SafeFetchError, type SafeFetchOptions, type SafeResponse } from './safeFetch.js';
import { parseSitemapXml, readSitemap, SitemapError } from './sitemap.js';

const ORIGIN = 'https://site.test';

const urlset = (urls: { loc: string; lastmod?: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map(
      (u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`,
    )
    .join('')}</urlset>`;

const index = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join('')}</sitemapindex>`;

/** A stub fetch serving `files` (URL → body | status); records what was requested. */
function stubFetch(files: Record<string, string | Buffer | number>) {
  return vi.fn(async (url: string, _opts: SafeFetchOptions): Promise<SafeResponse> => {
    const f = files[url];
    const status = typeof f === 'number' ? f : f === undefined ? 404 : 200;
    const body = typeof f === 'string' ? Buffer.from(f) : Buffer.isBuffer(f) ? f : Buffer.alloc(0);
    return { url, status, headers: {}, body, redirects: [], address: '93.184.216.34' };
  });
}

describe('readSitemap', () => {
  it('sitemap index with two child sitemaps → all URLs; off-origin URLs ignored', async () => {
    const fetch = stubFetch({
      [`${ORIGIN}/sitemap.xml`]: index([
        `${ORIGIN}/sitemap-listings.xml`,
        `${ORIGIN}/sitemap-agents.xml`,
        'http://169.254.169.254/sitemap.xml', // off-origin child: never fetched
      ]),
      [`${ORIGIN}/sitemap-listings.xml`]: urlset([
        { loc: `${ORIGIN}/listings/1`, lastmod: '2026-11-01' },
        { loc: `${ORIGIN}/listings/2?b=1&amp;a=2#top`, lastmod: '2026-11-02T10:00:00+05:30' },
        { loc: 'https://evil.test/listings/3' },
        { loc: 'http://site.test/listings/4' }, // other scheme = other origin
      ]),
      [`${ORIGIN}/sitemap-agents.xml`]: urlset([
        { loc: `${ORIGIN}/agents/a` },
        { loc: `${ORIGIN}/listings/1` }, // duplicate
        { loc: '/agents/relative', lastmod: 'garbage' },
      ]),
    });
    const res = await readSitemap({ origin: ORIGIN }, { fetch });
    expect(res.capped).toBe(false);
    expect(res.entries).toEqual([
      { url: `${ORIGIN}/listings/1`, lastmod: new Date('2026-11-01T00:00:00Z') },
      { url: `${ORIGIN}/listings/2?a=2&b=1`, lastmod: new Date('2026-11-02T04:30:00Z') },
      { url: `${ORIGIN}/agents/a`, lastmod: null },
      { url: `${ORIGIN}/agents/relative`, lastmod: null },
    ]);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      `${ORIGIN}/sitemap.xml`,
      `${ORIGIN}/sitemap-listings.xml`,
      `${ORIGIN}/sitemap-agents.xml`,
    ]);
    // Every fetch is pinned to the site origin.
    expect(fetch.mock.calls.every((c) => c[1].origin === ORIGIN)).toBe(true);
  });

  it('caps at 10,000 URLs with a flag', async () => {
    const many = (from: number, n: number) =>
      urlset(Array.from({ length: n }, (_, i) => ({ loc: `${ORIGIN}/p/${from + i}` })));
    const fetch = stubFetch({
      [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/a.xml`, `${ORIGIN}/b.xml`, `${ORIGIN}/c.xml`]),
      [`${ORIGIN}/a.xml`]: many(0, 6000),
      [`${ORIGIN}/b.xml`]: many(6000, 6000),
      [`${ORIGIN}/c.xml`]: many(12000, 10),
    });
    const res = await readSitemap({ origin: ORIGIN }, { fetch });
    expect(res.capped).toBe(true);
    expect(res.entries).toHaveLength(10_000);
    expect(res.entries.at(-1)!.url).toBe(`${ORIGIN}/p/9999`);
    expect(fetch).toHaveBeenCalledTimes(3); // stops once capped: c.xml is never read

    const exact = await readSitemap(
      { origin: ORIGIN },
      { fetch: stubFetch({ [`${ORIGIN}/sitemap.xml`]: many(0, 10_000) }) },
    );
    expect(exact.capped).toBe(false);
    expect(exact.entries).toHaveLength(10_000);
  });

  it('recurses to depth 2 and ignores deeper indexes; survives loops', async () => {
    const fetch = stubFetch({
      [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/d1.xml`, `${ORIGIN}/sitemap.xml`]),
      [`${ORIGIN}/d1.xml`]: index([`${ORIGIN}/d2.xml`, `${ORIGIN}/d2-index.xml`]),
      [`${ORIGIN}/d2.xml`]: urlset([{ loc: `${ORIGIN}/deep` }]),
      [`${ORIGIN}/d2-index.xml`]: index([`${ORIGIN}/d3.xml`]),
      [`${ORIGIN}/d3.xml`]: urlset([{ loc: `${ORIGIN}/too-deep` }]),
    });
    const res = await readSitemap({ origin: ORIGIN }, { fetch });
    expect(res.entries.map((e) => e.url)).toEqual([`${ORIGIN}/deep`]);
    expect(fetch.mock.calls.map((c) => c[0])).not.toContain(`${ORIGIN}/d3.xml`);
  });

  it('uses sites.sitemap_url when set, and refuses one off the origin', async () => {
    const fetch = stubFetch({
      [`${ORIGIN}/maps/main.xml.gz`]: gzipSync(urlset([{ loc: `${ORIGIN}/x` }])),
    });
    const res = await readSitemap(
      { origin: ORIGIN, sitemap_url: `${ORIGIN}/maps/main.xml.gz` },
      { fetch },
    );
    expect(res.entries.map((e) => e.url)).toEqual([`${ORIGIN}/x`]);

    const never = stubFetch({});
    await expect(
      readSitemap(
        { origin: ORIGIN, sitemap_url: 'http://169.254.169.254/latest/meta-data/' },
        { fetch: never },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SITEMAP' });
    expect(never).not.toHaveBeenCalled();
  });

  it('fails the whole read on a missing root, a broken child or a non-sitemap', async () => {
    await expect(readSitemap({ origin: ORIGIN }, { fetch: stubFetch({}) })).rejects.toMatchObject({
      code: 'NO_SITEMAP',
      message: 'Add a sitemap.xml',
    });
    const brokenChild = stubFetch({
      [`${ORIGIN}/sitemap.xml`]: index([`${ORIGIN}/a.xml`, `${ORIGIN}/b.xml`]),
      [`${ORIGIN}/a.xml`]: urlset([{ loc: `${ORIGIN}/1` }]),
      [`${ORIGIN}/b.xml`]: 503,
    });
    await expect(readSitemap({ origin: ORIGIN }, { fetch: brokenChild })).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    });
    await expect(
      readSitemap(
        { origin: ORIGIN },
        { fetch: stubFetch({ [`${ORIGIN}/sitemap.xml`]: '<html><body>hi</body></html>' }) },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SITEMAP' });
    const blocked = vi.fn(async (url: string): Promise<SafeResponse> => {
      throw new SafeFetchError('BLOCKED_ADDRESS', 'address not allowed', url);
    });
    const err = await readSitemap({ origin: ORIGIN }, { fetch: blocked }).catch((e) => e);
    expect(err).toBeInstanceOf(SitemapError);
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.cause.code).toBe('BLOCKED_ADDRESS');
  });

  it('never fetches a site whose origin is 169.254.169.254 (real safeFetch)', async () => {
    const err = await readSitemap({ origin: 'http://169.254.169.254' }, { allowLocal: true }).catch(
      (e) => e,
    );
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.cause.code).toBe('BLOCKED_ADDRESS');
  });

  it('reads a sitemap index from a local origin through safeFetch (allowLocal)', async () => {
    let base = '';
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/xml');
      if (req.url === '/sitemap.xml') return res.end(index([`${base}/a.xml`, `${base}/b.xml`]));
      if (req.url === '/a.xml') return res.end(urlset([{ loc: `${base}/1` }]));
      if (req.url === '/b.xml')
        return res.end(urlset([{ loc: `${base}/2` }, { loc: 'https://elsewhere.test/3' }]));
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await readSitemap({ origin: base }, { allowLocal: true });
      expect(res.entries.map((e) => e.url)).toEqual([`${base}/1`, `${base}/2`]);
      await expect(readSitemap({ origin: base })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('parseSitemapXml', () => {
  it('handles prefixed namespaces and ignores extension elements', () => {
    const xml = `<?xml version="1.0"?><s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="x"><s:url><s:loc> https://a.test/1 </s:loc><image:image><image:loc>https://a.test/i.png</image:loc></image:image></s:url></s:urlset>`;
    expect(parseSitemapXml(xml)).toEqual({
      kind: 'urlset',
      entries: [{ loc: 'https://a.test/1', lastmod: null }],
    });
  });

  it('does not expand external entities', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE u [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset><url><loc>https://a.test/&x;</loc></url></urlset>`;
    const doc = parseSitemapXml(xml);
    expect(JSON.stringify(doc)).not.toContain('root:');
  });
});
