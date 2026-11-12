// SP-064 integration: real headless Chromium against the fixture SPA and its server-rendered
// twin. Needs Postgres and the optional `playwright` package (+ its Chromium); the render CI
// workflow installs both, every other job skips this file.
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { extract } from '@spigot/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { startLeakListener, startSpaSite, type SpaSite } from '../test/render/spaSite.js';
import { crawlKeyHash, deriveCrawlKey } from './crawlKey.js';
import { crawlSite } from './crawlSite.js';
import { crawlerUserAgent, type CrawlDeps } from './deps.js';
import { clearCrawlHooks } from './hooks.js';
import { resetHostQueues } from './queue.js';
import { createBrowserRenderer, prepareTemplateRender, type Renderer } from './render.js';

const SECRET = 'render-test-secret-'.padEnd(40, 'x');

const hasPlaywright = (() => {
  try {
    createRequire(import.meta.url).resolve('playwright');
    return true;
  } catch {
    return false;
  }
})();

// What the schema agent would propose for the listing template (CSS only, no JSON-LD).
const SPEC = {
  recordKey: { from: 'url' },
  fields: [
    { name: 'title', type: 'string', required: true, source: { css: 'h1.title' } },
    { name: 'price', type: 'integer', source: { css: 'p.price' }, transforms: ['money'] },
    { name: 'beds', type: 'integer', source: { css: 'p.beds' }, transforms: ['firstInt'] },
  ],
};

describe.skipIf(!testDatabaseUrl || !hasPlaywright)('Playwright render (SP-064)', () => {
  let pools: TwoPools;
  let db: Db;
  let renderer: Renderer;
  let deps: CrawlDeps;
  let spa: SpaSite;
  let ssr: SpaSite;
  let leak: Awaited<ReturnType<typeof startLeakListener>>;

  const newSite = async (origin: string) => {
    const pub = await pools.a.query<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
      [`p-${origin}@x.test`],
    );
    const site = await pools.a.query<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, 'v', 'pending', 'g', 'VERIFIED') RETURNING id`,
      [pub.rows[0]!.id, origin],
    );
    const id = site.rows[0]!.id;
    await pools.a.query('UPDATE sites SET crawl_key_hash = $2 WHERE id = $1', [
      id,
      crawlKeyHash(deriveCrawlKey(id, SECRET)),
    ]);
    return id;
  };

  /** Discovery crawl, then the template row the schema agent would save (all pages, 3 samples). */
  const crawlAndTemplate = async (origin: string) => {
    const siteId = await newSite(origin);
    await crawlSite({ siteId, trigger: 'CONNECT' }, deps);
    const pages = await pools.a.query<{ id: string }>('SELECT id FROM pages WHERE site_id = $1', [
      siteId,
    ]);
    const ids = pages.rows.map((r) => r.id);
    const t = await pools.a.query<{ id: string }>(
      `INSERT INTO templates (site_id, url_pattern, page_count, sample_page_ids)
       VALUES ($1, '^/listings/[a-z0-9-]+$', $2, $3::uuid[]) RETURNING id`,
      [siteId, ids.length, ids],
    );
    await pools.a.query('UPDATE pages SET template_id = $2 WHERE id = ANY($1::uuid[])', [
      ids,
      t.rows[0]!.id,
    ]);
    return { siteId, templateId: t.rows[0]!.id };
  };

  const records = async (siteId: string) => {
    const { rows } = await pools.a.query<{ url: string; html_gz: Buffer }>(
      `SELECT p.url, snap.html_gz FROM pages p
         JOIN LATERAL (SELECT html_gz FROM snapshots s WHERE s.page_id = p.id ORDER BY s.id DESC LIMIT 1) snap ON true
        WHERE p.site_id = $1`,
      [siteId],
    );
    return rows
      .map((r) => {
        const rec = extract(gunzipSync(r.html_gz).toString('utf8'), SPEC, r.url);
        return rec && { key: rec.recordKey, ...rec.data };
      })
      .sort((a, b) => String(a?.key).localeCompare(String(b?.key)));
  };

  const renderMode = async (templateId: string) =>
    (
      await pools.a.query<{ render: string }>('SELECT render FROM templates WHERE id = $1', [
        templateId,
      ])
    ).rows[0]!.render;

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
    leak = await startLeakListener();
    renderer = createBrowserRenderer({
      userAgent: crawlerUserAgent('http://spigot.test'),
      timeoutMs: 15_000,
    });
  });
  afterAll(async () => {
    await renderer?.close();
    await leak?.close();
    await pools?.close();
  });
  beforeEach(async () => {
    await pools.a.query(
      'TRUNCATE snapshots, crawl_runs, pages, templates, sites, publishers CASCADE',
    );
    resetHostQueues();
    clearCrawlHooks();
    await spa?.close();
    await ssr?.close();
    spa = await startSpaSite('spa', { leakUrl: leak.url });
    ssr = await startSpaSite('ssr');
    deps = {
      db,
      crawlSecret: SECRET,
      allowLocal: true,
      appBaseUrl: 'http://spigot.test',
      minGapMs: 0,
      sleep: async () => {},
      renderer,
    };
  });

  it('a fixture SPA page yields the same records as its server-rendered twin', async () => {
    const a = await crawlAndTemplate(spa.origin);
    const b = await crawlAndTemplate(ssr.origin);
    // Before rendering, the SPA snapshots are shells: no records.
    expect((await records(a.siteId)).filter(Boolean)).toEqual([]);

    expect(await prepareTemplateRender(deps, a.templateId)).toEqual({
      mode: 'browser',
      rendered: 3,
      failed: 0,
    });
    expect(await prepareTemplateRender(deps, b.templateId)).toEqual({
      mode: 'html',
      rendered: 0,
      failed: 0,
    });
    expect(await renderMode(a.templateId)).toBe('browser');
    expect(await renderMode(b.templateId)).toBe('html');

    const fromSpa = await records(a.siteId);
    expect(fromSpa).toHaveLength(3);
    expect(fromSpa[0]).toMatchObject({
      key: 'garden-flat-2',
      title: 'Garden flat by the park',
      price: 2400,
      beds: 2,
    });
    expect(fromSpa).toEqual(await records(b.siteId));

    // Idempotent: a second pass finds rendered snapshots and renders nothing.
    expect(await prepareTemplateRender(deps, a.templateId)).toEqual({
      mode: 'browser',
      rendered: 0,
      failed: 0,
    });
  }, 60_000);

  it('renders with the crawl key, no cookies, and never leaves the origin', async () => {
    const a = await crawlAndTemplate(spa.origin);
    spa.seen.length = 0;
    await prepareTemplateRender(deps, a.templateId);

    const key = deriveCrawlKey(a.siteId, SECRET);
    const paths = spa.seen.map((s) => s.path);
    expect(paths).toContain('/app.js');
    expect(paths.filter((p) => p.startsWith('/api/listings/'))).toHaveLength(3);
    for (const s of spa.seen) {
      expect(s.headers['x-spigot-key']).toBe(key);
      expect(s.headers['user-agent']).toBe(crawlerUserAgent('http://spigot.test'));
      expect(s.headers.cookie).toBeUndefined(); // the server set cookies, the script set one
    }
    expect(leak.hits()).toBe(0);
  }, 60_000);

  it('fetchPage renders browser-template pages on later crawls and picks up data changes', async () => {
    const a = await crawlAndTemplate(spa.origin);
    await prepareTemplateRender(deps, a.templateId);
    spa.data.find((l) => l.slug === 'sunny-loft-1')!.price = 1999;
    spa.seen.length = 0;

    const run = await crawlSite({ siteId: a.siteId, trigger: 'MANUAL' }, deps);
    expect(run).toBeTruthy();
    const loft = (await records(a.siteId)).find((r) => r?.key === 'sunny-loft-1');
    expect(loft).toMatchObject({ price: 1999 });
    // The shell's ETag says nothing about the data: never a conditional request.
    for (const s of spa.seen) expect(s.headers['if-none-match']).toBeUndefined();
  }, 60_000);

  it('without a renderer, browser-template pages fail and keep their rendered snapshot', async () => {
    const a = await crawlAndTemplate(spa.origin);
    await prepareTemplateRender(deps, a.templateId);
    const before = await records(a.siteId);

    const { renderer: _off, ...noRender } = deps;
    await crawlSite({ siteId: a.siteId, trigger: 'MANUAL' }, noRender);
    const runs = await pools.a.query<{ pages_failed: number }>(
      `SELECT pages_failed FROM crawl_runs WHERE site_id = $1 AND trigger = 'MANUAL'`,
      [a.siteId],
    );
    expect(runs.rows[0]!.pages_failed).toBe(3);
    expect(await records(a.siteId)).toEqual(before);
    // And prepare with rendering off leaves the mode alone.
    expect(await prepareTemplateRender(noRender, a.templateId)).toMatchObject({
      mode: 'browser',
      rendered: 0,
    });
  }, 60_000);
});
