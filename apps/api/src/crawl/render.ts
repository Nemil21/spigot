import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import type { Queryable } from '../db/index.js';
import { deriveCrawlKey, sentCrawlKeyVersionSql } from './crawlKey.js';
import { crawlerUserAgent, minGapFor, type CrawlDeps } from './deps.js';
import { writeSnapshot } from './fetchPage.js';
import { hostQueueFor } from './queue.js';
import { safeFetch, SafeFetchError, type SafeResponse } from './safeFetch.js';

/**
 * Playwright render for JS-heavy templates (SP-064; features/03 §Logic 9). P1, off by default
 * (`CRAWL_RENDER=off`): Chromium is heavy on the laptop and on Render, and the demo site is
 * server-rendered.
 *
 * - `looksClientRendered(html)` / `chooseRenderMode(samples)`: a template whose sample pages have
 *   little text and a lot of `<script>` is marked `templates.render = 'browser'`.
 * - `createBrowserRenderer()`: headless Chromium, one page at a time, a fresh context (no
 *   cookies, no storage) per page. Chromium itself never touches the network: its host resolver
 *   maps every name to nothing, and every request it makes is fulfilled from our side. The
 *   document is the body the crawler already fetched; same-origin GET subresources (scripts,
 *   XHR / fetch) go through `safeFetch` (SSRF guard, pinned IP, the same `X-Spigot-Key` and
 *   User-Agent, no cookies) inside the host's polite queue; everything else is aborted.
 *   The snapshot is the rendered DOM (`page.content()`).
 * - `prepareTemplateRender()`: the schema agent calls it for a new template before it reads the
 *   samples (so the model and the APPROVE extraction see rendered pages): it decides the mode
 *   and, for `browser`, renders each of the template's pages not fetched since the switch.
 */

export type RenderMode = 'html' | 'browser';

export const RENDER_HEURISTIC = {
  /** Visible body text below this (characters, whitespace collapsed) counts as "little text". */
  maxTextChars: 200,
  /** Executable script weight must reach this and `scriptToText` × the text. */
  minScriptChars: 1_000,
  scriptToText: 5,
  /** An external `<script src>` counts as this many characters (its size is unknown here). */
  externalScriptChars: 1_500,
} as const;

export interface PageSignals {
  textChars: number;
  scriptChars: number;
}

const DATA_SCRIPT =
  /^(application\/(ld\+)?json|text\/template|text\/x-template|importmap|speculationrules)$/i;

/** Visible text and executable-script weight of a page (JSON-LD and other data blocks excluded). */
export function pageSignals(html: string): PageSignals {
  const $ = cheerio.load(html);
  let scriptChars = 0;
  $('script').each((_, el) => {
    const type = ($(el).attr('type') ?? '').trim();
    if (type && DATA_SCRIPT.test(type)) return;
    scriptChars += $(el).attr('src') ? RENDER_HEURISTIC.externalScriptChars : $(el).text().length;
  });
  $('script, style, noscript, template, head').remove();
  const textChars = $('body').text().replace(/\s+/g, ' ').trim().length;
  return { textChars, scriptChars };
}

/** Little text and much `<script>`: the listing is built in the browser. */
export function looksClientRendered(html: string): boolean {
  const { textChars, scriptChars } = pageSignals(html);
  const h = RENDER_HEURISTIC;
  return (
    textChars < h.maxTextChars &&
    scriptChars >= h.minScriptChars &&
    scriptChars >= h.scriptToText * textChars
  );
}

/** `browser` when more than half of the template's sample pages look client-rendered. */
export function chooseRenderMode(samples: readonly string[]): RenderMode {
  if (!samples.length) return 'html';
  const shells = samples.filter(looksClientRendered).length;
  return shells * 2 > samples.length ? 'browser' : 'html';
}

// --- renderer ----------------------------------------------------------------------------------

export type RenderErrorCode = 'UNAVAILABLE' | 'TIMEOUT' | 'FAILED';

export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RenderError';
  }
}

export interface RenderInput {
  /** The page URL (final URL after the crawler's redirects). */
  url: string;
  /** The document the crawler fetched; served to Chromium as the navigation response. */
  html: Buffer;
  contentType?: string;
  /** Fetches one same-origin GET subresource for the page (the crawler's safeFetch + queue). */
  fetchResource: (url: string, accept: string | undefined) => Promise<SafeResponse>;
}

export interface Renderer {
  /** The rendered DOM as HTML. One render at a time; throws `RenderError`. */
  render(input: RenderInput): Promise<string>;
  close(): Promise<void>;
}

// Just the slice of Playwright's API we use: `playwright` is an optional dependency, installed
// only where rendering runs (and in the render CI job), so its types aren't available here.
interface PwRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
  headers(): Record<string, string>;
}
interface PwRoute {
  request(): PwRequest;
  abort(errorCode?: string): Promise<void>;
  fulfill(r: {
    status: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }): Promise<void>;
}
interface PwPage {
  goto(url: string, o: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'networkidle', o: { timeout: number }): Promise<void>;
  content(): Promise<string>;
  mainFrame(): unknown;
}
interface PwContext {
  route(url: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(o: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
export interface PlaywrightLike {
  chromium: { launch(o: Record<string, unknown>): Promise<PwBrowser> };
}

/** `import('playwright')`, or `UNAVAILABLE` with the install hint. */
export async function loadPlaywright(): Promise<PlaywrightLike> {
  const name = 'playwright'; // not a literal import: TS must not resolve the optional package
  try {
    return (await import(name)) as PlaywrightLike;
  } catch (err) {
    throw new RenderError(
      'UNAVAILABLE',
      'CRAWL_RENDER=browser needs Playwright: npm install playwright && npx playwright install --only-shell chromium',
      { cause: err },
    );
  }
}

export interface BrowserRendererOptions {
  userAgent: string;
  /** Whole render (navigation + network idle). Default 20 s. */
  timeoutMs?: number;
  /** Test seam. */
  loadPlaywright?: () => Promise<PlaywrightLike>;
}

const SKIPPED_RESOURCES = new Set([
  'image',
  'media',
  'font',
  'stylesheet',
  'eventsource',
  'websocket',
  'manifest',
  'other',
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'set-cookie',
  'connection',
]);

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

export function createBrowserRenderer(opts: BrowserRendererOptions): Renderer {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let browser: Promise<PwBrowser> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const launch = () =>
    (browser ??= (opts.loadPlaywright ?? loadPlaywright)()
      .then((pw) =>
        pw.chromium.launch({
          headless: true,
          // Chromium resolves no host itself: every request is fulfilled (or aborted) by us.
          args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking'],
        }),
      )
      .catch((err: unknown) => {
        browser = undefined;
        if (err instanceof RenderError) throw err;
        throw new RenderError(
          'UNAVAILABLE',
          `could not launch Chromium: ${(err as Error).message}`,
          { cause: err },
        );
      }));

  const renderOne = async (input: RenderInput): Promise<string> => {
    const b = await launch();
    const context = await b.newContext({
      userAgent: opts.userAgent,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    try {
      let documentServed = false;
      await context.route('**/*', async (route) => {
        const req = route.request();
        try {
          if (req.isNavigationRequest()) {
            // The page itself, once; any later navigation (JS redirect, iframe) is refused.
            if (documentServed || req.url() !== input.url) return route.abort('blockedbyclient');
            documentServed = true;
            return route.fulfill({
              status: 200,
              headers: { 'content-type': input.contentType ?? 'text/html; charset=utf-8' },
              body: input.html,
            });
          }
          if (
            req.method() !== 'GET' ||
            SKIPPED_RESOURCES.has(req.resourceType()) ||
            !sameOrigin(req.url(), input.url)
          ) {
            return route.abort('blockedbyclient');
          }
          const res = await input.fetchResource(req.url(), req.headers()['accept']);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (!DROPPED_RESPONSE_HEADERS.has(k)) headers[k] = v;
          }
          return route.fulfill({ status: res.status, headers, body: res.body });
        } catch {
          return route.abort('failed').catch(() => {});
        }
      });
      const page = await context.newPage();
      const started = Date.now();
      try {
        await page.goto(input.url, { waitUntil: 'load', timeout: timeoutMs });
        const left = Math.max(1, timeoutMs - (Date.now() - started));
        await page.waitForLoadState('networkidle', { timeout: left });
      } catch (err) {
        const name = (err as Error).name;
        throw new RenderError(
          name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED',
          `render of ${input.url} failed: ${(err as Error).message.split('\n')[0]}`,
          { cause: err },
        );
      }
      return await page.content();
    } finally {
      await context.close().catch(() => {});
    }
  };

  return {
    // Concurrency 1: each render waits for the previous one.
    render(input) {
      const next = chain.then(() => renderOne(input));
      chain = next.catch(() => {});
      return next;
    },
    async close() {
      const b = browser;
      browser = undefined;
      await chain;
      if (b) await (await b.catch(() => undefined))?.close().catch(() => {});
    },
  };
}

// --- crawler side ------------------------------------------------------------------------------

/** What the crawler needs to render one page of an origin: the polite, keyed subresource fetch. */
export function resourceFetcher(
  deps: CrawlDeps,
  site: { origin: string; headers: Record<string, string>; lastGateSeenAt: Date | null },
): RenderInput['fetchResource'] {
  const queue = hostQueueFor(new URL(site.origin).host, {
    minGapMs: minGapFor(deps, site.lastGateSeenAt),
    sleep: deps.sleep,
  });
  const doFetch = deps.fetch ?? safeFetch;
  return (url, accept) =>
    queue.run(() =>
      doFetch(url, {
        origin: site.origin,
        headers: { ...site.headers, accept: accept ?? '*/*' },
        allowLocal: deps.allowLocal,
        resolver: deps.resolver,
      }),
    );
}

export interface PrepareRenderResult {
  mode: RenderMode;
  /** Pages whose snapshot is now the rendered DOM. */
  rendered: number;
  /** Pages that could not be fetched or rendered (they keep their old snapshot). */
  failed: number;
}

interface TemplateRow {
  site_id: string;
  render: RenderMode;
  sample_page_ids: string[] | null;
  origin: string;
  crawl_key_version: number;
  last_gate_seen_at: Date | null;
}

const newestSnapshotHtml = async (q: Queryable, pageIds: readonly string[]) => {
  const { rows } = await q.query<{ id: string; url: string; html_gz: Buffer | null }>(
    `SELECT p.id, p.url, snap.html_gz FROM pages p
       LEFT JOIN LATERAL (
         SELECT s.html_gz FROM snapshots s
          WHERE s.page_id = p.id AND s.http_status = 200 AND s.html_gz IS NOT NULL
          ORDER BY s.id DESC LIMIT 1
       ) snap ON true
      WHERE p.id = ANY($1::uuid[]) AND p.removed_at IS NULL`,
    [pageIds],
  );
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    html: r.html_gz ? gunzipSync(r.html_gz).toString('utf8') : null,
  }));
};

/**
 * Decide a template's render mode from its sample snapshots and, for `browser`, render each of its
 * live pages that hasn't been fetched since the switch (`render_since`), one at a time. Idempotent:
 * a re-run (or a resumed one) renders only the pages still missing. Without `deps.renderer` nothing
 * changes (rendering is off).
 */
export async function prepareTemplateRender(
  deps: CrawlDeps,
  templateId: string,
): Promise<PrepareRenderResult> {
  const { db, renderer } = deps;
  const { rows } = await db.pool.query<TemplateRow>(
    `SELECT t.site_id, t.render, t.sample_page_ids, s.origin, s.last_gate_seen_at,
            ${sentCrawlKeyVersionSql('s')} AS crawl_key_version
       FROM templates t JOIN sites s ON s.id = t.site_id
      WHERE t.id = $1`,
    [templateId],
  );
  const t = rows[0];
  if (!t) throw new Error(`prepareTemplateRender: template ${templateId} not found`);
  if (!renderer) return { mode: t.render, rendered: 0, failed: 0 };

  if (t.render !== 'browser') {
    const samples = await newestSnapshotHtml(db.pool, t.sample_page_ids ?? []);
    const mode = chooseRenderMode(samples.flatMap((s) => (s.html === null ? [] : [s.html])));
    if (mode === 'html') return { mode, rendered: 0, failed: 0 };
    await db.pool.query(
      `UPDATE templates SET render = 'browser', render_since = now(), updated_at = now() WHERE id = $1`,
      [templateId],
    );
  }

  const headers: Record<string, string> = {
    'x-spigot-key': deriveCrawlKey(t.site_id, deps.crawlSecret, t.crawl_key_version),
    'user-agent': crawlerUserAgent(deps.appBaseUrl),
  };
  const fetchResource = resourceFetcher(deps, {
    origin: t.origin,
    headers,
    lastGateSeenAt: t.last_gate_seen_at,
  });
  // Rendered since the switch: fetched at / after `render_since` with a 200 (by us or fetchPage).
  const todo = await db.pool.query<{ id: string; url: string }>(
    `SELECT p.id, p.url FROM pages p JOIN templates t ON t.id = p.template_id
      WHERE p.template_id = $1 AND p.removed_at IS NULL
        AND NOT (p.last_status = 200 AND p.fetched_at >= t.render_since)
      ORDER BY p.id`,
    [templateId],
  );
  let rendered = 0;
  let failed = 0;
  for (const page of todo.rows) {
    if (deps.signal?.aborted) break;
    const id = page.id;
    try {
      const doc = await fetchResource(page.url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1');
      if (doc.status !== 200) {
        failed++;
        continue;
      }
      const html = await renderer.render({
        url: doc.url,
        html: doc.body,
        contentType: doc.headers['content-type'],
        fetchResource,
      });
      await db.tx((tx) => writeSnapshot(tx, id, Buffer.from(html, 'utf8'), null));
      rendered++;
    } catch (err) {
      if (!(err instanceof RenderError || err instanceof SafeFetchError)) throw err;
      failed++;
    }
  }
  return { mode: 'browser', rendered, failed };
}
