import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { normalizeOnOrigin, originOf } from './normalizeUrl.js';
import {
  safeFetch,
  SAFE_FETCH_DEFAULTS,
  type SafeFetchOptions,
  type SafeResponse,
} from './safeFetch.js';

/**
 * `readSitemap(site)` (SP-009a1; features/03 §Logic 3.2, §Edge cases): the sitemap or sitemap
 * index at the site's origin, followed recursively to depth 2 (index → index → urlset), every
 * URL normalized, off-origin URLs ignored, capped at 10,000 URLs with `capped: true`.
 *
 * Any sitemap that can't be read (non-2xx, blocked, unparseable) fails the whole read with
 * `SitemapError`: a partial list fed to `upsertPages` would wrongly mark pages removed.
 */

export interface SitemapEntry {
  url: string;
  lastmod: Date | null;
}

export interface SitemapResult {
  entries: SitemapEntry[];
  /** True when the sitemap(s) listed more than `maxUrls` URLs ("first 10,000 pages"). */
  capped: boolean;
  /** Sitemap files read, in order. */
  sitemaps: string[];
}

export interface SiteRef {
  origin: string;
  /** Defaults to `<origin>/sitemap.xml`. */
  sitemap_url?: string | null;
}

export type SitemapErrorCode =
  'NO_SITEMAP' | 'FETCH_FAILED' | 'INVALID_SITEMAP' | 'TOO_MANY_SITEMAPS';

export class SitemapError extends Error {
  constructor(
    readonly code: SitemapErrorCode,
    message: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SitemapError';
  }
}

export interface ReadSitemapOptions extends Pick<
  SafeFetchOptions,
  'allowLocal' | 'resolver' | 'timeoutMs' | 'headers'
> {
  /** Default 10 000. */
  maxUrls?: number;
  /** Nesting below the root sitemap. Default 2. */
  maxDepth?: number;
  /** Sitemap files read per call. Default 100. */
  maxSitemaps?: number;
  /** Injected in tests; defaults to `safeFetch`. */
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeResponse>;
}

export const SITEMAP_DEFAULTS = { maxUrls: 10_000, maxDepth: 2, maxSitemaps: 100 } as const;

function parseLastmod(text: string): Date | null {
  const s = text.trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function decodeBody(res: SafeResponse, maxBytes: number): string {
  const body = res.body;
  // A gzipped sitemap (`sitemap.xml.gz`, served as a file, not Content-Encoding).
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    return gunzipSync(body, { maxOutputLength: maxBytes }).toString('utf8');
  }
  return body.toString('utf8');
}

/** Parse one sitemap document: either child sitemap locs (index) or page entries (urlset). */
export function parseSitemapXml(
  xml: string,
):
  | { kind: 'index'; sitemaps: string[] }
  | { kind: 'urlset'; entries: { loc: string; lastmod: Date | null }[] } {
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first();
  const name = (root.prop('tagName') ?? '').toLowerCase().replace(/^.*:/, '');
  if (name === 'sitemapindex') {
    const sitemaps = root
      .children()
      .filter((_, el) => /(^|:)sitemap$/i.test(el.tagName))
      .map((_, el) =>
        $(el)
          .children()
          .filter((_, c) => /(^|:)loc$/i.test(c.tagName))
          .first()
          .text()
          .trim(),
      )
      .get()
      .filter(Boolean);
    return { kind: 'index', sitemaps };
  }
  if (name === 'urlset') {
    const entries = root
      .children()
      .filter((_, el) => /(^|:)url$/i.test(el.tagName))
      .map((_, el) => {
        const kids = $(el).children();
        const loc = kids
          .filter((_, c) => /(^|:)loc$/i.test(c.tagName))
          .first()
          .text()
          .trim();
        const lastmod = kids
          .filter((_, c) => /(^|:)lastmod$/i.test(c.tagName))
          .first()
          .text();
        return { loc, lastmod: parseLastmod(lastmod) };
      })
      .get()
      .filter((e) => e.loc);
    return { kind: 'urlset', entries };
  }
  throw new Error(`root element <${name || '?'}> is not urlset or sitemapindex`);
}

export async function readSitemap(
  site: SiteRef,
  opts: ReadSitemapOptions = {},
): Promise<SitemapResult> {
  const maxUrls = opts.maxUrls ?? SITEMAP_DEFAULTS.maxUrls;
  const maxDepth = opts.maxDepth ?? SITEMAP_DEFAULTS.maxDepth;
  const maxSitemaps = opts.maxSitemaps ?? SITEMAP_DEFAULTS.maxSitemaps;
  const doFetch = opts.fetch ?? safeFetch;
  const origin = originOf(site.origin);

  const rootUrl = normalizeOnOrigin(site.sitemap_url ?? '/sitemap.xml', origin);
  if (!rootUrl) {
    throw new SitemapError(
      'INVALID_SITEMAP',
      'The sitemap URL must be on the site origin',
      String(site.sitemap_url),
    );
  }

  const seen = new Map<string, SitemapEntry>();
  const visited = new Set<string>();
  const sitemaps: string[] = [];
  let capped = false;

  const read = async (url: string, depth: number): Promise<void> => {
    if (capped || visited.has(url)) return;
    if (visited.size >= maxSitemaps) {
      throw new SitemapError('TOO_MANY_SITEMAPS', `More than ${maxSitemaps} sitemap files`, url);
    }
    visited.add(url);

    let res: SafeResponse;
    try {
      res = await doFetch(url, {
        origin,
        allowLocal: opts.allowLocal,
        resolver: opts.resolver,
        timeoutMs: opts.timeoutMs,
        headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.1', ...opts.headers },
      });
    } catch (err) {
      throw new SitemapError(
        'FETCH_FAILED',
        `Could not fetch ${url}: ${(err as Error).message}`,
        url,
        {
          cause: err,
        },
      );
    }
    if (res.status < 200 || res.status > 299) {
      if (depth === 0 && (res.status === 404 || res.status === 410)) {
        throw new SitemapError('NO_SITEMAP', 'Add a sitemap.xml', url);
      }
      throw new SitemapError('FETCH_FAILED', `${url} answered ${res.status}`, url);
    }
    sitemaps.push(url);

    let doc: ReturnType<typeof parseSitemapXml>;
    try {
      doc = parseSitemapXml(decodeBody(res, SAFE_FETCH_DEFAULTS.maxBytes));
    } catch (err) {
      throw new SitemapError(
        'INVALID_SITEMAP',
        `${url} is not a sitemap: ${(err as Error).message}`,
        url,
        {
          cause: err,
        },
      );
    }

    if (doc.kind === 'index') {
      if (depth >= maxDepth) return; // deeper nesting is ignored
      for (const loc of doc.sitemaps) {
        const child = normalizeOnOrigin(loc, origin);
        if (child) await read(child, depth + 1); // off-origin child sitemaps are ignored
        if (capped) return;
      }
      return;
    }

    for (const { loc, lastmod } of doc.entries) {
      const pageUrl = normalizeOnOrigin(loc, origin);
      if (!pageUrl || seen.has(pageUrl)) continue;
      if (seen.size >= maxUrls) {
        capped = true;
        return;
      }
      seen.set(pageUrl, { url: pageUrl, lastmod });
    }
  };

  await read(rootUrl, 0);
  return { entries: [...seen.values()], capped, sitemaps };
}
