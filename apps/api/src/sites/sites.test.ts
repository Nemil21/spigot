import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';
import {
  SAFE_FETCH_DEFAULTS,
  SafeFetchError,
  type SafeFetchOptions,
  type SafeResponse,
} from '../crawl/safeFetch.js';
import { readSitemap } from '../crawl/sitemap.js';
import { ApiError } from '../http/errors.js';
import { generateSiteSecrets, sha256Hex, verifyBodyMatches } from './keys.js';
import {
  baseSlug,
  installSnippet,
  MAX_ROBOTS_SITEMAPS,
  MESSAGES,
  normalizeOrigin,
  pickSlug,
  probeOrigin,
  sitemapsFromRobots,
} from './sites.js';

const SECRET = 's'.repeat(40);
const ORIGIN = 'https://bluebonnet.example.com';
const URLSET =
  '<?xml version="1.0"?><urlset><url><loc>https://bluebonnet.example.com/a</loc></url></urlset>';

describe('normalizeOrigin', () => {
  it('adds https, lowercases the host, drops path / query / default port', () => {
    expect(normalizeOrigin('Bluebonnet.Example.com/listings?x=1#y')).toBe(ORIGIN);
    expect(normalizeOrigin('https://bluebonnet.example.com:443/')).toBe(ORIGIN);
    expect(normalizeOrigin('  http://localhost:4100/  ')).toBe('http://localhost:4100');
  });
  it('rejects other schemes, credentials and garbage with 400 VALIDATION_ERROR', () => {
    for (const bad of ['ftp://x.com', 'https://u:p@x.com', 'http://', 'https://exa mple.com']) {
      expect(() => normalizeOrigin(bad), bad).toThrowError(ApiError);
      try {
        normalizeOrigin(bad);
      } catch (e) {
        expect((e as ApiError).code).toBe('VALIDATION_ERROR');
      }
    }
  });
});

describe('slug', () => {
  it('takes the first host label', () => {
    expect(baseSlug('https://bluebonnet-rentals.onrender.com')).toBe('bluebonnet-rentals');
    expect(baseSlug('https://www.Example.co.uk')).toBe('example');
    expect(baseSlug('http://localhost:4100')).toBe('localhost');
  });
  it('IPs, digit-led, short and reserved labels get a safe form', () => {
    expect(baseSlug('http://127.0.0.1:4100')).toBe('site');
    expect(baseSlug('http://[::1]:4100')).toBe('site');
    expect(baseSlug('https://42.example.com')).toBe('site-42');
    expect(baseSlug('https://ab.io')).toBe('ab-site');
    expect(baseSlug('https://catalog.example.com')).toBe('catalog-site');
    expect(baseSlug('https://xn--bcher-kva.example')).toMatch(/^[a-z][a-z0-9-]{2,}$/);
  });
  it('pickSlug finds the smallest free suffix', () => {
    expect(pickSlug('a', [])).toBe('a');
    expect(pickSlug('a', ['a', 'a-2', 'a-4'])).toBe('a-3');
  });
});

describe('keys', () => {
  it('generates gk_/ck_/verify values; stores only SHA-256 hex', () => {
    const s = generateSiteSecrets('00000000-0000-4000-8000-000000000001', SECRET);
    expect(s.gateKey).toMatch(/^gk_[A-Za-z0-9_-]{43}$/);
    expect(s.crawlKey).toBe(deriveCrawlKey('00000000-0000-4000-8000-000000000001', SECRET));
    expect(s.verifyToken).toMatch(/^spigot-verify=[0-9a-f]{32}$/);
    expect(s.gateKeyHash).toBe(sha256Hex(s.gateKey));
    expect(s.crawlKeyHash).toBe(crawlKeyHash(s.crawlKey));
    expect(s.gateKeyHash).toMatch(/^[0-9a-f]{64}$/);
    const t = generateSiteSecrets('00000000-0000-4000-8000-000000000001', SECRET);
    expect(t.gateKey).not.toBe(s.gateKey);
    expect(t.verifyToken).not.toBe(s.verifyToken);
  });
  it('verifyBodyMatches: whole file or one line, exact', () => {
    const tok = 'spigot-verify=abc';
    expect(verifyBodyMatches(`${tok}\n`, tok)).toBe(true);
    expect(verifyBodyMatches(`\uFEFF# hi\r\n  ${tok}  \r\nother\n`, tok)).toBe(true);
    expect(verifyBodyMatches(`${tok}x\n`, tok)).toBe(false);
    expect(verifyBodyMatches(`x ${tok}`, tok)).toBe(false);
    expect(verifyBodyMatches('', '')).toBe(false);
  });
  it('install snippet names the API base', () => {
    expect(installSnippet('https://spigot.onrender.com/')).toContain(
      "apiBase: 'https://spigot.onrender.com'",
    );
  });
});

describe('probeOrigin', () => {
  const res = (url: string, status: number, body = ''): SafeResponse => ({
    url,
    status,
    headers: {},
    body: Buffer.from(body),
    redirects: [],
    address: '203.0.113.9',
  });
  const deps = (routes: Record<string, SafeResponse | Error>, seen: SafeFetchOptions[] = []) => ({
    allowLocal: false,
    appBaseUrl: 'https://spigot.test',
    fetch: async (url: string, opts: SafeFetchOptions) => {
      seen.push(opts);
      const r = routes[url];
      if (!r) return res(url, 404);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return [(e as ApiError).code, (e as ApiError).message];
    }
    return null;
  };

  it('finds /sitemap.xml with a 5 s timeout, the origin pinned, and the crawler UA', async () => {
    const seen: SafeFetchOptions[] = [];
    const r = await probeOrigin(
      ORIGIN,
      undefined,
      deps({ [`${ORIGIN}/sitemap.xml`]: res('', 200, URLSET) }, seen),
    );
    expect(r.sitemapUrl).toBe(`${ORIGIN}/sitemap.xml`);
    for (const o of seen) {
      expect(o.timeoutMs).toBe(5000);
      expect(o.origin).toBe(ORIGIN);
      expect(o.headers?.['user-agent']).toMatch(/^SpigotCrawler\/1\.0/);
    }
  });
  it('tries at most MAX_ROBOTS_SITEMAPS robots.txt Sitemap: lines (no fetch fan-out)', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Sitemap: /bad-${i}.xml`).join('\n');
    const urls: string[] = [];
    const d = deps({
      [`${ORIGIN}/robots.txt`]: res('', 200, `User-agent: *\n${lines}\n`),
      [`${ORIGIN}/bad-0.xml`]: res('', 200, '<html>not a sitemap</html>'),
    });
    const fetch = d.fetch;
    d.fetch = async (url, opts) => {
      urls.push(url);
      return fetch(url, opts);
    };
    expect(await codeOf(probeOrigin(ORIGIN, undefined, d))).toEqual([
      'VALIDATION_ERROR',
      MESSAGES.noSitemap,
    ]);
    expect(urls).toEqual([
      `${ORIGIN}/robots.txt`,
      ...Array.from({ length: MAX_ROBOTS_SITEMAPS }, (_, i) => `${ORIGIN}/bad-${i}.xml`),
      `${ORIGIN}/sitemap.xml`,
    ]);
    expect(MAX_ROBOTS_SITEMAPS).toBe(3);
  });
  it('gzipped sitemaps: same decompressed-size cap as the crawler (readSitemap)', async () => {
    const gz = (xml: string) => ({
      ...res('', 200),
      body: gzipSync(Buffer.from(xml)),
    });
    const filler = `<!--${'x'.repeat(SAFE_FETCH_DEFAULTS.maxBytes)}-->`;
    for (const [xml, accepted] of [
      [URLSET, true],
      [URLSET.replace('<urlset>', `<urlset>${filler}`), false],
    ] as const) {
      const d = deps({ [`${ORIGIN}/sitemap.xml`]: gz(xml) });
      const probe = await codeOf(probeOrigin(ORIGIN, undefined, d));
      expect(probe, `probe accepted=${accepted}`).toEqual(
        accepted ? null : ['VALIDATION_ERROR', MESSAGES.noSitemap],
      );
      const crawl = await readSitemap({ origin: ORIGIN }, { fetch: d.fetch }).then(
        () => true,
        () => false,
      );
      expect(crawl, `crawler accepted=${accepted}`).toBe(accepted);
    }
  });
  it('prefers a robots.txt Sitemap: line on the origin, ignores off-origin ones', async () => {
    const robots = `User-agent: *\nSitemap: https://evil.test/s.xml\nsitemap:  /maps/index.xml\n`;
    const r = await probeOrigin(
      ORIGIN,
      undefined,
      deps({
        [`${ORIGIN}/robots.txt`]: res('', 200, robots),
        [`${ORIGIN}/maps/index.xml`]: res(
          '',
          200,
          '<sitemapindex><sitemap><loc>/x</loc></sitemap></sitemapindex>',
        ),
      }),
    );
    expect(r.sitemapUrl).toBe(`${ORIGIN}/maps/index.xml`);
    expect(sitemapsFromRobots(robots, ORIGIN)).toEqual([`${ORIGIN}/maps/index.xml`]);
  });
  it('uses an explicit sitemapUrl override and never falls back past it', async () => {
    const ok = await probeOrigin(
      ORIGIN,
      '/feeds/sm.xml',
      deps({ [`${ORIGIN}/feeds/sm.xml`]: res('', 200, URLSET) }),
    );
    expect(ok.sitemapUrl).toBe(`${ORIGIN}/feeds/sm.xml`);
    const routes = { [`${ORIGIN}/sitemap.xml`]: res('', 200, URLSET) };
    expect(await codeOf(probeOrigin(ORIGIN, '/nope.xml', deps(routes)))).toEqual([
      'VALIDATION_ERROR',
      MESSAGES.noSitemap,
    ]);
    expect((await codeOf(probeOrigin(ORIGIN, 'https://other.test/s.xml', deps(routes))))?.[0]).toBe(
      'VALIDATION_ERROR',
    );
  });
  it('no sitemap (404, HTML, empty) → 400 "Add a sitemap.xml or enter one"', async () => {
    for (const body of [null, '<html>hi</html>', '']) {
      const routes = body === null ? {} : { [`${ORIGIN}/sitemap.xml`]: res('', 200, body) };
      expect(await codeOf(probeOrigin(ORIGIN, undefined, deps(routes)))).toEqual([
        'VALIDATION_ERROR',
        MESSAGES.noSitemap,
      ]);
    }
  });
  it('network-class failures → 502 ORIGIN_ERROR "We couldn\'t reach that site"', async () => {
    for (const code of ['DNS_FAILED', 'NETWORK', 'TIMEOUT', 'TOO_MANY_REDIRECTS'] as const) {
      const routes = { [`${ORIGIN}/robots.txt`]: new SafeFetchError(code, 'x', ORIGIN) };
      expect(await codeOf(probeOrigin(ORIGIN, undefined, deps(routes)))).toEqual([
        'ORIGIN_ERROR',
        MESSAGES.unreachable,
      ]);
    }
  });
  it('blocked address → 400, not "unreachable"; off-origin redirect names the target', async () => {
    const blocked = {
      [`${ORIGIN}/robots.txt`]: new SafeFetchError('BLOCKED_ADDRESS', 'x', ORIGIN),
    };
    expect(await codeOf(probeOrigin(ORIGIN, undefined, deps(blocked)))).toEqual([
      'VALIDATION_ERROR',
      MESSAGES.blocked,
    ]);
    const off = {
      [`${ORIGIN}/robots.txt`]: new SafeFetchError(
        'OFF_ORIGIN',
        'x',
        'https://www.bluebonnet.example.com/robots.txt',
      ),
    };
    const [code, msg] = (await codeOf(probeOrigin(ORIGIN, undefined, deps(off))))!;
    expect(code).toBe('VALIDATION_ERROR');
    expect(msg).toContain('https://www.bluebonnet.example.com');
  });
});
