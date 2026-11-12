import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { build402, parsePolicy } from '@spigot/gate';
import { DATASET_UNPUBLISHED_MESSAGE, SITE_PAUSED_MESSAGE } from '@spigot/shared';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { catalog } from '../services/catalog.js';
import { paymentRequired } from '../services/paidRead.js';
import { generateGateKey, sha256Hex } from '../sites/keys.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { CATALOG_PAGE_MAX_BYTES } from '../views/catalog.html.js';

/**
 * SP-033 W13 catalog page against Postgres. The test plan: render + link check from a real 402
 * body. Both 402 producers are used: the gate (`build402` over the real `GET /api/gate/policy`
 * response) and the data API (the keyless `/v1` call once SP-017b's route is there, SP-017a's
 * `paymentRequired` until then). Every URL in their bodies, `Link` headers and the D04 page, plus
 * every link on the catalog page itself, is requested against the app.
 */

const BASE = REQUIRED_ENV.APP_BASE_URL!;

/**
 * Links owned by tickets that may not be merged yet. Each gets its own test, skipped (not passed)
 * while the route is missing, and checked strictly once it's registered.
 */
const PENDING = [
  { ticket: 'SP-017b', label: '/v1 data API', match: (p: string) => /^\/v1\/(?!openapi)/.test(p) },
  { ticket: 'SP-022a', label: '/mcp', match: (p: string) => p === '/mcp' },
  { ticket: 'SP-023', label: '/v1/openapi.yaml', match: (p: string) => p === '/v1/openapi.yaml' },
] as const;

const FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  { name: 'price_usd', type: 'integer', visible: true, filterable: ['lt', 'gte'] },
  { name: 'agent_phone', type: 'string', visible: false, filterable: [] },
];

/** Every http(s) URL in a JSON value. */
function urlsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string' && /^https?:\/\//.test(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => urlsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => urlsIn(x, out));
  return out;
}
const linkHeaderUrls = (links: readonly string[]) =>
  links.map((l) => /^<([^>]+)>/.exec(l)?.[1]).filter((u): u is string => !!u);
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&#38;/g, '&'));

describe.skipIf(!testDatabaseUrl)('SP-033 W13 catalog page (Postgres)', { timeout: 60_000 }, () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const tag = randomUUID().slice(0, 8);
  const slug = `bb-${tag}`;
  const gateKey = generateGateKey();
  let siteId: string;
  let datasetId: string;

  const agent = () => request(app.server);
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await app.db.pool.query(sql, params)).rows as T[];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      {
        logger: false,
      },
    );
    await app.ready();

    const [pub] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('Bluebonnet Rentals', $1, $1) RETURNING id`,
      [`pub-${tag}@example.com`],
    );
    const [s] = await q<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, 'v', $4, $5, 'READY') RETURNING id`,
      [pub!.id, `https://${tag}.example.com`, slug, sha256Hex(`ck_${tag}`), sha256Hex(gateKey)],
    );
    siteId = s!.id;
    const [t] = await q<{ id: string }>(
      `INSERT INTO templates (site_id, url_pattern) VALUES ($1, '^/listings/[a-z0-9-]+$') RETURNING id`,
      [siteId],
    );
    const [ds] = await q<{ id: string }>(
      `INSERT INTO datasets (site_id, template_id, slug, type_name, status, record_count)
       VALUES ($1, $2, 'listings', 'Listing', 'LIVE', 2341) RETURNING id`,
      [siteId, t!.id],
    );
    datasetId = ds!.id;
    const [sv] = await q<{ id: string }>(
      `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
      [datasetId, JSON.stringify(FIELDS)],
    );
    await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [datasetId, sv!.id]);
    await q(
      `INSERT INTO crawl_runs (site_id, trigger, status, finished_at)
       VALUES ($1, 'MANUAL', 'SUCCEEDED', now() - interval '2 hours')`,
      [siteId],
    );
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    app.rateLimiter.reset();
    await q(`UPDATE sites SET status = 'READY' WHERE id = $1`, [siteId]);
    await q(`UPDATE datasets SET status = 'LIVE', stale_since = NULL WHERE id = $1`, [datasetId]);
  });

  /** The gate's 402 (JSON body, headers, D04 page) built from the real policy response. */
  async function gate402() {
    const res = await agent().get('/api/gate/policy').set('Authorization', `Bearer ${gateKey}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return build402(parsePolicy(res.body));
  }

  /** The data API's keyless 402: the `/v1` route if SP-017b is merged, else the service. */
  async function api402(): Promise<{ body: unknown; links: string[] }> {
    const res = await agent().get(`/v1/${slug}/datasets/listings/records`);
    if (res.status === 402) {
      const link = res.headers.link as string | string[] | undefined;
      return {
        body: res.body,
        links: ([] as string[]).concat(link ?? []).flatMap((l) => l.split(/,\s*(?=<)/)),
      };
    }
    const r = await paymentRequired({ db: app.db.pool, baseUrl: BASE }, slug, 'listings');
    return { body: r.body, links: r.headers.Link };
  }

  /** Every URL a scraper can reach from a 402, deduplicated, all on our origin. */
  async function allUrls(): Promise<string[]> {
    const g = await gate402();
    const a = await api402();
    const urls = [
      ...urlsIn(g.body),
      ...linkHeaderUrls(g.headers.Link),
      ...hrefs(g.html),
      ...urlsIn(a.body),
      ...linkHeaderUrls(a.links),
    ];
    const catalogPage = await agent().get(`/c/${slug}`);
    urls.push(...hrefs(catalogPage.text));
    for (const u of urls) expect(new URL(u).origin, u).toBe(new URL(BASE).origin);
    return [...new Set(urls)];
  }

  /** A route answered (anything but the "no route" 404 from the not-found handler). */
  async function follow(url: string) {
    const u = new URL(url);
    const res = await agent().get(u.pathname + u.search);
    const noRoute = res.status === 404 && /No route for/.test(res.body?.error?.message ?? '');
    return { res, noRoute };
  }

  it('the 402 bodies point at this page and its terms', async () => {
    const g = await gate402();
    const a = await api402();
    expect(g.body.terms).toBe(`${BASE}/c/${slug}/terms`);
    expect(g.headers.Link).toContain(`<${BASE}/c/${slug}>; rel="payment"`);
    expect(g.html).toContain(`href="${BASE}/c/${slug}"`);
    expect((a.body as { terms: string }).terms).toBe(`${BASE}/c/${slug}/terms`);
    expect(a.links).toContain(`<${BASE}/c/${slug}>; rel="payment"`);
  });

  it('every URL from the 402 bodies and the page resolves (routes this ticket and main own)', async () => {
    const urls = await allUrls();
    const checked: string[] = [];
    for (const url of urls) {
      const path = new URL(url).pathname;
      if (PENDING.some((p) => p.match(path))) continue;
      const { res, noRoute } = await follow(url);
      expect(noRoute, `${url} has no route`).toBe(false);
      if (path.startsWith('/c/')) {
        expect(res.status, url).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.text).toContain('Bluebonnet Rentals');
      } else if (path === '/buyers/topup') {
        // W11 is the SPA: 200 with a built web app, the explicit 503 without (CI's db job).
        expect([200, 503], url).toContain(res.status);
      } else {
        expect(res.status, url).toBeLessThan(500);
      }
      checked.push(path);
    }
    expect(checked).toEqual(
      expect.arrayContaining([`/c/${slug}`, `/c/${slug}/terms`, '/buyers/topup']),
    );
  });

  for (const pending of PENDING) {
    it(`URLs under ${pending.label} resolve (${pending.ticket})`, async (ctx) => {
      const urls = (await allUrls()).filter((u) => pending.match(new URL(u).pathname));
      expect(urls.length).toBeGreaterThan(0);
      const results = await Promise.all(urls.map(async (u) => ({ u, ...(await follow(u)) })));
      if (results.every((r) => r.noRoute)) {
        ctx.skip(`${pending.ticket} not merged: no route for ${pending.label} yet`);
      }
      for (const r of results) {
        expect(r.noRoute, `${r.u} has no route`).toBe(false);
        expect(r.res.status, r.u).toBeLessThan(500);
      }
    });
  }

  it('renders the page: cards, quick start, CTA, links; < 50 KB; no hidden fields', async () => {
    const res = await agent().get(`/c/${slug}`);
    expect(res.status).toBe(200);
    expect(res.headers['vary']).toMatch(/Accept/);
    expect(Buffer.byteLength(res.text)).toBeLessThan(CATALOG_PAGE_MAX_BYTES);
    expect(res.text).toContain('Data sold by the site owner through Spigot');
    expect(res.text).toContain('<h2>Listing</h2>');
    expect(res.text).toContain('2,341');
    expect(res.text).toContain('$1.50 / 1,000 records');
    expect(res.text).toContain('<code>price_usd</code>');
    expect(res.text).toContain('Crawled 2 h ago');
    expect(res.text).not.toContain('agent_phone');
    expect(res.text).toContain(`href="${BASE}/buyers/topup"`);
    expect(res.text).toContain(`href="${BASE}/c/${slug}/terms"`);
    expect(res.text).toContain(`href="${BASE}/v1/openapi.yaml"`);
  });

  it('Accept: application/json returns the catalog JSON (catalog() narrowed to the site)', async () => {
    const res = await agent().get(`/c/${slug}`).set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const all = await catalog(app.db.pool);
    expect(res.body).toEqual({ sites: all.sites.filter((s) => s.slug === slug) });
    expect(res.body.sites[0]).toMatchObject({
      slug,
      name: 'Bluebonnet Rentals',
      datasets: [{ slug: 'listings', type: 'Listing', records: 2341, perRecordMicros: 1500 }],
    });
    // curl's default Accept gets the page.
    const plain = await agent().get(`/c/${slug}`).set('Accept', '*/*');
    expect(plain.headers['content-type']).toMatch(/^text\/html/);
  });

  it('stale dataset: badge with the shared copy', async () => {
    await q(
      `UPDATE datasets SET status = 'LIVE_STALE', stale_since = now() - interval '6 hours' WHERE id = $1`,
      [datasetId],
    );
    const res = await agent().get(`/c/${slug}`);
    expect(res.text).toContain('<span class="badge">Stale</span>');
    expect(res.text).toContain('Last good extract 6 h ago; the site changed layout.');
  });

  it('paused site: shared copy, still listed and sold', async () => {
    await q(`UPDATE sites SET status = 'PAUSED' WHERE id = $1`, [siteId]);
    const res = await agent().get(`/c/${slug}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(SITE_PAUSED_MESSAGE);
    expect(res.text).toContain('<h2>Listing</h2>');
  });

  it('unpublished: shared copy on the page, empty JSON catalog; terms still resolve', async () => {
    await q(`UPDATE datasets SET status = 'UNPUBLISHED' WHERE id = $1`, [datasetId]);
    const res = await agent().get(`/c/${slug}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(DATASET_UNPUBLISHED_MESSAGE);
    const json = await agent().get(`/c/${slug}`).set('Accept', 'application/json');
    expect(json.body).toEqual({ sites: [] });
    expect((await agent().get(`/c/${slug}/terms`)).status).toBe(200);
  });

  it('unknown site: 404 page, or the JSON error envelope', async () => {
    const html = await agent().get('/c/no-such-site');
    expect(html.status).toBe(404);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    const json = await agent().get('/c/no-such-site').set('Accept', 'application/json');
    expect(json.status).toBe(404);
    expect(json.body.error.code).toBe('NOT_FOUND');
    expect((await agent().get('/c/NOT%20a%20slug/terms')).status).toBe(404);
  });

  it('no login: a session or key is never required', async () => {
    const res = await agent().get(`/c/${slug}/terms`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No resale.');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
