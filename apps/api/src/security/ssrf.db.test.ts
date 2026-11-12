import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-042: SSRF through the real routes (features/14 §Security checklist: "resolve and block
 * private IP ranges, except the local demo in dev"). `crawl/safeFetch.test.ts` proves the guard
 * itself; this proves every way a publisher can point Spigot at a URL goes through it:
 *
 * - connect (`POST /api/sites`) with a private / loopback / metadata origin → 400, no request made;
 * - a crawl of a site whose origin is loopback (a row that slipped in) → no request made;
 * - with `ALLOW_LOCAL_ORIGINS` (the dev demo), a sitemap on the allowed origin that lists other
 *   private hosts, or a `sitemap_url` on another host → those are never fetched.
 *
 * "Never fetched" is observed, not inferred: every target is a real local listener counting hits.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Listener {
  server: Server;
  port: number;
  hits: string[];
  /** Body per path; anything else 404s. */
  routes: Record<string, string>;
}

async function listen(): Promise<Listener> {
  const l: Listener = { server: undefined as unknown as Server, port: 0, hits: [], routes: {} };
  l.server = createServer((req, res) => {
    l.hits.push(req.url ?? '/');
    const body = l.routes[(req.url ?? '/').split('?')[0]!];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const type = body.startsWith('<?xml')
      ? 'application/xml'
      : body.startsWith('<')
        ? 'text/html'
        : 'text/plain';
    res.writeHead(200, { 'Content-Type': type }).end(body);
  });
  await new Promise<void>((r) => l.server.listen(0, '127.0.0.1', r));
  l.port = (l.server.address() as AddressInfo).port;
  return l;
}

const closeAll = (ls: Listener[]) =>
  Promise.all(ls.map((l) => new Promise<void>((r) => l.server.close(() => r()))));

/** One app with `ALLOW_LOCAL_ORIGINS` as given, a publisher session, and site / crawl helpers. */
function harness(allowLocal: boolean) {
  const h = {
    db: undefined as unknown as TestDatabase,
    app: undefined as unknown as FastifyInstance,
    base: '',
    publisherId: '',
    cookie: '',
  };

  beforeAll(async () => {
    h.db = await createTestDatabase();
    h.app = await buildServer(
      loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: h.db.url,
        ALLOW_LOCAL_ORIGINS: allowLocal ? 'true' : 'false',
      }),
      { logger: false },
    );
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    h.base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    const res = await fetch(`${h.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({
        name: 'SSRF',
        email: `ssrf-${randomUUID()}@example.com`,
        password: 'correct horse battery',
        payoutEmail: 'payouts@example.com',
      }),
    });
    expect(res.status).toBe(201);
    h.publisherId = ((await res.json()) as { publisherId: string }).publisherId;
    h.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';', 1)[0])
      .join('; ');
  });
  afterAll(async () => {
    await h.app?.close();
    await h.db?.drop();
  });
  beforeEach(() => h.app.rateLimiter.reset());

  return {
    h,
    async connect(body: Record<string, string>) {
      const res = await fetch(`${h.base}/api/sites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN, Cookie: h.cookie },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { error?: { code: string } } };
    },
    /** A READY site row at `origin` (as if it had been connected and verified). */
    async site(origin: string, sitemapUrl: string | null = null): Promise<string> {
      const id = randomUUID();
      const s = generateSiteSecrets(id, SECRET);
      await h.app.db.pool.query(
        `INSERT INTO sites (id, publisher_id, origin, slug, sitemap_url, verify_token, crawl_key_hash,
           gate_key_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY')`,
        [
          id,
          h.publisherId,
          origin,
          `s-${id.slice(0, 8)}`,
          sitemapUrl,
          s.verifyToken,
          s.crawlKeyHash,
          s.gateKeyHash,
        ],
      );
      return id;
    },
    /** `POST /api/sites/:id/crawl`, then wait for the in-process run to end. */
    async crawl(siteId: string): Promise<{ status: string; error: string | null }> {
      const res = await fetch(`${h.base}/api/sites/${siteId}/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN, Cookie: h.cookie },
        body: '{}',
      });
      expect(res.status).toBe(202);
      const { crawlRunId } = (await res.json()) as { crawlRunId: string };
      const t0 = Date.now();
      for (;;) {
        const { rows } = await h.app.db.pool.query<{ status: string; error: string | null }>(
          `SELECT status, error FROM crawl_runs WHERE id = $1`,
          [crawlRunId],
        );
        if (TERMINAL.includes(rows[0]!.status)) return rows[0]!;
        if (Date.now() - t0 > 20_000) throw new Error(`crawl ${crawlRunId} did not end`);
        await sleep(50);
      }
    },
  };
}

describe.skipIf(!testDatabaseUrl)(
  'SP-042 SSRF (Postgres, production rules)',
  { timeout: 60_000 },
  () => {
    const t = harness(false);
    let target: Listener;

    beforeAll(async () => {
      target = await listen();
      target.routes = {
        '/robots.txt': 'User-agent: *\nAllow: /\n',
        '/sitemap.xml':
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url></urlset>',
      };
    });
    afterAll(() => closeAll([target]));

    it('connect: loopback, private, metadata and unspecified origins → 400, nothing fetched', async () => {
      const p = target.port;
      const origins = [
        `http://127.0.0.1:${p}`,
        `http://localhost:${p}`, // a hostname resolving to loopback
        `http://[::1]:${p}`,
        `http://[::ffff:127.0.0.1]:${p}`, // IPv4-mapped IPv6
        `http://0.0.0.0:${p}`,
        `http://2130706433:${p}`, // 127.0.0.1 as a decimal integer
        `http://0x7f000001:${p}`,
        'http://169.254.169.254',
        'http://10.0.0.1',
        'http://192.168.1.1',
        'http://172.16.0.1',
        'http://100.64.0.1',
        'http://[fd00:ec2::254]',
      ];
      for (const origin of origins) {
        const r = await t.connect({ origin });
        expect(r.status, `${origin}: ${JSON.stringify(r.body)}`).toBe(400);
      }
      // A public-looking origin whose sitemap URL is private: the sitemap is off-origin, refused.
      const r = await t.connect({
        origin: `http://127.0.0.1:${p}`,
        sitemapUrl: `http://127.0.0.1:${p}/sitemap.xml`,
      });
      expect(r.status).toBe(400);
      expect(target.hits).toEqual([]);
      const { rows } = await t.h.app.db.pool.query(`SELECT origin FROM sites`);
      expect(rows).toEqual([]);
    });

    it('crawl: a site row on a loopback origin is never fetched; the run fails', async () => {
      const siteId = await t.site(`http://127.0.0.1:${target.port}`);
      const run = await t.crawl(siteId);
      expect(run.status).toBe('FAILED');
      expect(target.hits).toEqual([]);
    });
  },
);

describe.skipIf(!testDatabaseUrl)(
  'SP-042 SSRF (Postgres, ALLOW_LOCAL_ORIGINS dev demo)',
  { timeout: 60_000 },
  () => {
    const t = harness(true);
    let origin: Listener;
    let other: Listener;

    beforeAll(async () => {
      origin = await listen();
      other = await listen();
      const o = `http://127.0.0.1:${origin.port}`;
      const x = `http://127.0.0.1:${other.port}`;
      origin.routes = {
        '/robots.txt': 'User-agent: *\nAllow: /\n',
        '/sitemap.xml':
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          [
            `${o}/page/1`,
            `${x}/secret`, // another private host (another port is another origin)
            `http://localhost:${other.port}/secret-by-name`,
            `http://[::1]:${other.port}/secret-v6`,
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.1/internal',
          ]
            .map((u) => `<url><loc>${u}</loc></url>`)
            .join('') +
          '</urlset>',
        '/page/1': '<html><head><title>One</title></head><body>One</body></html>',
      };
      other.routes = { '/sitemap.xml': origin.routes['/sitemap.xml']!, '/secret': 'secret' };
    });
    afterAll(() => closeAll([origin, other]));

    it('sitemap URLs on other (private) hosts are never fetched; on-origin pages are', async () => {
      const siteId = await t.site(`http://127.0.0.1:${origin.port}`);
      await t.crawl(siteId);
      // The crawl really ran against the allowed origin…
      expect(origin.hits).toEqual(expect.arrayContaining(['/sitemap.xml', '/page/1']));
      // …and nothing else was touched.
      expect(other.hits).toEqual([]);
      const { rows } = await t.h.app.db.pool.query<{ url: string }>(
        `SELECT url FROM pages WHERE site_id = $1`,
        [siteId],
      );
      for (const { url } of rows)
        expect(url.startsWith(`http://127.0.0.1:${origin.port}/`), url).toBe(true);
    });

    it('a sitemap_url on another host is refused, not fetched', async () => {
      const siteId = await t.site(
        `http://localhost:${origin.port}`,
        `http://127.0.0.1:${other.port}/sitemap.xml`,
      );
      const run = await t.crawl(siteId);
      expect(run.status).toBe('FAILED');
      expect(other.hits).toEqual([]);
    });

    it('even in dev, metadata and link-local origins are refused at connect', async () => {
      for (const o of ['http://169.254.169.254', 'http://[fe80::1]', 'http://0.0.0.0']) {
        const r = await t.connect({ origin: o });
        expect(r.status, `${o}: ${JSON.stringify(r.body)}`).toBe(400);
      }
    });
  },
);
