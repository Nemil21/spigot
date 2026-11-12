import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp } from '../../../demo-site/src/app.js';
import { openStore, type Store } from '../../../demo-site/src/data/store.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';
import { createPool } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { cases } from '../security/tenancy/sites.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { clearSiteHooks, onSiteVerified } from './hooks.js';

/**
 * SP-008a integration (ticket §Test plan): the demo site (SP-004a) started in-test, a stub origin
 * without a sitemap, and a closed port, through the real routes, `safeFetch` and Postgres.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}
const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

describe.skipIf(!testDatabaseUrl)('SP-008a sites: connect, verify (Postgres + demo site)', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let dataDir: string;
  let store: Store;
  const servers: Server[] = [];

  /** A demo-site origin whose served verify token can be swapped mid-test. */
  async function demoOrigin(): Promise<{
    origin: string;
    serveToken(t: string | undefined): void;
  }> {
    const quiet = createAccessLog(() => {});
    let current = createApp({ store, accessLog: quiet });
    const { server, origin } = await listen((req, res) => current(req, res));
    servers.push(server);
    return {
      origin,
      serveToken: (t) => {
        current = createApp({ store, accessLog: quiet, verifyToken: t });
      },
    };
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = createPool(db.url, { max: 2, applicationName: 'sites-test' });
    dataDir = await mkdtemp(join(tmpdir(), 'spigot-sites-'));
    store = await openStore({ dataDir, scale: 0.05 });
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, ALLOW_LOCAL_ORIGINS: 'true' }),
      { logStream: new Writable({ write: (_c, _e, cb) => cb() }) },
    );
    await app.ready();
  });
  afterAll(async () => {
    await Promise.all(servers.map(close));
    await app?.close();
    await pool?.end();
    await db?.drop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => app.rateLimiter.reset());
  afterEach(() => clearSiteHooks());

  const agent = () => request(app.server);
  const post = (url: string, cookie: string, body: object = {}) =>
    agent().post(url).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const get = (url: string, cookie: string) => agent().get(url).set('Cookie', cookie);

  async function newPublisher() {
    const res = await post('/api/auth/signup', '', {
      name: 'Bluebonnet',
      email: `p-${randomUUID()}@example.com`,
      password: 'correct horse',
      payoutEmail: 'payouts@example.com',
    });
    expect(res.status).toBe(201);
    return { id: res.body.publisherId as string, cookie: cookiesOf(res) };
  }

  const siteRow = async (id: string) =>
    (await pool.query('SELECT * FROM sites WHERE id = $1', [id])).rows[0];
  const siteCount = async () =>
    (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sites')).rows[0]!.n;
  const auditRows = async (siteId: string, action: string) =>
    (
      await pool.query(
        `SELECT * FROM audit_events WHERE entity = 'sites' AND entity_id = $1 AND action = $2`,
        [siteId, action],
      )
    ).rows;

  it('connecting the demo site returns the keys once; the DB holds only their hashes', async () => {
    const pub = await newPublisher();
    const demo = await demoOrigin();

    const res = await post('/api/sites', pub.cookie, { origin: `${demo.origin}/listings?x=1` });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body;
    expect(body).toMatchObject({
      origin: demo.origin,
      slug: 'site',
      status: 'PENDING_VERIFY',
      sitemapUrl: `${demo.origin}/sitemap.xml`,
      verify: { path: '/.well-known/spigot.txt' },
    });
    expect(body.verify.content).toMatch(/^spigot-verify=[0-9a-f]{32}$/);
    expect(body.gateKey).toMatch(/^gk_/);
    expect(body.crawlKey).toBe(deriveCrawlKey(body.siteId, REQUIRED_ENV.SESSION_SECRET!));
    expect(body.install).toContain(`apiBase: '${APP_ORIGIN}'`);

    const row = await siteRow(body.siteId);
    expect(row).toMatchObject({
      publisher_id: pub.id,
      origin: demo.origin,
      status: 'PENDING_VERIFY',
      gate_key_hash: sha256(body.gateKey),
      crawl_key_hash: crawlKeyHash(body.crawlKey),
      verify_token: body.verify.content,
      policy: {
        SEARCH: 'PASS',
        AI_TRAINING: 'QUOTE',
        AI_AGENT: 'QUOTE',
        SCRAPER_TOOL: 'QUOTE',
        UNKNOWN: 'PASS',
        gated_paths: [],
      },
    });
    const everything = JSON.stringify(
      (await pool.query(`SELECT s.*, a.* FROM sites s, audit_events a`)).rows,
    );
    expect(everything).not.toContain(body.gateKey);
    expect(everything).not.toContain(body.crawlKey);
    const [connected] = await auditRows(body.siteId, 'SITE_CONNECTED');
    expect(connected).toMatchObject({
      actor_type: 'PUBLISHER',
      actor_id: pub.id,
      publisher_id: pub.id,
    });

    // Reads never return the keys again (nor their hashes).
    const one = await get(`/api/sites/${body.siteId}`, pub.cookie);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      id: body.siteId,
      status: 'PENDING_VERIFY',
      verify: body.verify,
    });
    const list = await get('/api/sites', pub.cookie);
    expect(list.body.sites.map((s: { id: string }) => s.id)).toEqual([body.siteId]);
    for (const text of [JSON.stringify(one.body), JSON.stringify(list.body)]) {
      expect(text).not.toContain(body.gateKey);
      expect(text).not.toContain(body.crawlKey);
      expect(text).not.toContain(row.gate_key_hash);
      expect(text).not.toContain(row.crawl_key_hash);
    }

    // The same origin again (any publisher) → 409, no second row.
    const n = await siteCount();
    const again = await post('/api/sites', (await newPublisher()).cookie, { origin: demo.origin });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('STATE_CONFLICT');
    expect(await siteCount()).toBe(n);
  });

  it('verify: 409 until the token is served, then VERIFIED once; repeats and races are no-ops', async () => {
    const pub = await newPublisher();
    const demo = await demoOrigin();
    const fired: string[] = [];
    onSiteVerified((siteId, publisherId) => {
      expect(publisherId).toBe(pub.id);
      fired.push(siteId);
    });

    const { body: site } = await post('/api/sites', pub.cookie, { origin: demo.origin });
    const verify = () => post(`/api/sites/${site.siteId}/verify`, pub.cookie);

    // Not served (404), then the wrong token: 409 STATE_CONFLICT, still PENDING_VERIFY.
    for (const token of [undefined, 'spigot-verify=00000000000000000000000000000000']) {
      demo.serveToken(token);
      const res = await verify();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'STATE_CONFLICT',
        message: 'Token not found at /.well-known/spigot.txt',
      });
      expect((await siteRow(site.siteId)).status).toBe('PENDING_VERIFY');
    }
    expect(await auditRows(site.siteId, 'SITE_VERIFIED')).toHaveLength(0);
    expect(fired).toEqual([]);

    // The demo site's SPIGOT_VERIFY_TOKEN matches → VERIFIED; five concurrent calls, one winner.
    demo.serveToken(site.verify.content);
    const results = await Promise.all(Array.from({ length: 5 }, verify));
    for (const r of results) expect([r.status, r.body]).toEqual([200, { status: 'VERIFIED' }]);
    expect((await siteRow(site.siteId)).status).toBe('VERIFIED');
    expect(await auditRows(site.siteId, 'SITE_VERIFIED')).toHaveLength(1);
    expect(fired).toEqual([site.siteId]);

    // A second verify later is a no-op, even with the token gone from the origin.
    demo.serveToken(undefined);
    const again = await verify();
    expect([again.status, again.body]).toEqual([200, { status: 'VERIFIED' }]);
    expect(await auditRows(site.siteId, 'SITE_VERIFIED')).toHaveLength(1);
    expect(fired).toEqual([site.siteId]);
  });

  it('a stub origin without a sitemap → 400 "Add a sitemap.xml or enter one", no row; an override works', async () => {
    const pub = await newPublisher();
    const { server, origin } = await listen((req, res) => {
      if (req.url === '/robots.txt') return res.writeHead(200).end('User-agent: *\nAllow: /\n');
      if (req.url === '/feeds/pages.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<urlset><url><loc>${origin}/a</loc></url></urlset>`);
      }
      res.writeHead(404).end('not found');
    });
    servers.push(server);

    const n = await siteCount();
    const res = await post('/api/sites', pub.cookie, { origin });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Add a sitemap.xml or enter one',
      details: { field: 'sitemapUrl', reason: 'NO_SITEMAP' },
    });
    expect(await siteCount()).toBe(n);

    const ok = await post('/api/sites', pub.cookie, { origin, sitemapUrl: '/feeds/pages.xml' });
    expect(ok.status).toBe(201);
    expect(ok.body.sitemapUrl).toBe(`${origin}/feeds/pages.xml`);
    expect((await siteRow(ok.body.siteId)).sitemap_url).toBe(`${origin}/feeds/pages.xml`);
  });

  it('an unreachable origin → 502 ORIGIN_ERROR "We couldn\'t reach that site", no row', async () => {
    const pub = await newPublisher();
    const { server, origin } = await listen(() => {});
    await close(server); // the port is now closed: ECONNREFUSED

    const n = await siteCount();
    const res = await post('/api/sites', pub.cookie, { origin });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({
      code: 'ORIGIN_ERROR',
      message: "We couldn't reach that site",
    });
    expect(await siteCount()).toBe(n);
  });

  it("tenancy: another publisher's site id is a 404 on every :id route; lists are scoped", async () => {
    const a = await newPublisher();
    const b = await newPublisher();
    const demo = await demoOrigin();
    const { body: bSite } = await post('/api/sites', b.cookie, {
      origin: demo.origin,
      publisherId: a.id,
    });
    expect(bSite.siteId).toBeDefined();
    // A publisherId smuggled into the body is ignored: the site is B's.
    expect((await siteRow(bSite.siteId)).publisher_id).toBe(b.id);
    demo.serveToken(bSite.verify.content);

    for (const c of cases) {
      const url = c.url.replace(':id', bSite.siteId);
      if (!c.url.includes(':id')) continue;
      const res = c.method === 'GET' ? await get(url, a.cookie) : await post(url, a.cookie);
      expect([c.method, c.url, res.status, res.body.error?.code]).toEqual([
        c.method,
        c.url,
        404,
        'NOT_FOUND',
      ]);
    }
    expect((await siteRow(bSite.siteId)).status).toBe('PENDING_VERIFY');
    expect((await get('/api/sites/not-a-uuid', a.cookie)).status).toBe(404);

    const aList = await get('/api/sites', a.cookie);
    expect(aList.body.sites.map((s: { id: string }) => s.id)).not.toContain(bSite.siteId);

    // Signed out → 401 on every route.
    for (const c of cases) {
      const url = c.url.replace(':id', bSite.siteId);
      const res =
        c.method === 'GET' ? await get(url, '') : await post(url, '', { origin: demo.origin });
      expect([c.url, res.status]).toEqual([c.url, 401]);
    }
  });
});
