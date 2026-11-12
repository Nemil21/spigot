import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessLog, type AccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp } from '../../../demo-site/src/app.js';
import { openStore } from '../../../demo-site/src/data/store.js';
import { createDb, type Db } from '../db/index.js';
import { drainNotifications, twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { crawlKeyHash, deriveCrawlKey } from './crawlKey.js';
import { crawlSite, startCrawl } from './crawlSite.js';
import type { CrawlDeps } from './deps.js';
import { clearCrawlHooks, onDiscoveryDone, onPageChanged, onRunFinished } from './hooks.js';
import { resetHostQueues } from './queue.js';
import { safeFetch } from './safeFetch.js';

const SECRET = 'crawl-test-secret-'.padEnd(40, 'x');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}
const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

describe.skipIf(!testDatabaseUrl)('crawlSite / fetchPage', () => {
  let pools: TwoPools;
  let db: Db;
  let deps: CrawlDeps;
  let sleeps: number[];

  const newSite = async (origin: string, status = 'VERIFIED') => {
    const pub = await pools.a.query<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ('P', $1, 'p@x.test') RETURNING id`,
      [`p-${origin}@x.test`],
    );
    const site = await pools.a.query<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, 'v', 'pending', 'g', $3) RETURNING id`,
      [pub.rows[0]!.id, origin, status],
    );
    const id = site.rows[0]!.id;
    await pools.a.query('UPDATE sites SET crawl_key_hash = $2 WHERE id = $1', [
      id,
      crawlKeyHash(deriveCrawlKey(id, SECRET)),
    ]);
    return id;
  };
  const siteStatus = async (id: string) =>
    (await pools.a.query<{ status: string }>('SELECT status FROM sites WHERE id = $1', [id]))
      .rows[0]!.status;
  const runRow = async (id: string) =>
    (await pools.a.query('SELECT * FROM crawl_runs WHERE id = $1', [id])).rows[0]!;
  const snapshotCounts = async (siteId: string) =>
    (
      await pools.a.query<{ n: number }>(
        `SELECT count(s.id)::int AS n FROM pages p LEFT JOIN snapshots s ON s.page_id = p.id
          WHERE p.site_id = $1 GROUP BY p.id`,
        [siteId],
      )
    ).rows.map((r) => r.n);

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
  });
  afterAll(async () => {
    await pools?.close();
  });
  beforeEach(async () => {
    await pools.a.query('TRUNCATE snapshots, crawl_runs, pages, sites, publishers CASCADE');
    resetHostQueues();
    clearCrawlHooks();
    sleeps = [];
    deps = {
      db,
      crawlSecret: SECRET,
      allowLocal: true,
      appBaseUrl: 'http://spigot.test',
      minGapMs: 0,
      sleep: async (ms) => void sleeps.push(ms),
      progressEvery: 25,
    };
  });
  afterEach(() => clearCrawlHooks());

  // -------------------------------------------------------------------------------------------
  describe('against the demo site (DEMO_SEED_SCALE=0.05)', () => {
    let server: Server;
    let origin: string;
    let log: AccessLog;
    let dataDir: string;
    const seen: { ua: string; key: string | undefined; inm: string | undefined }[] = [];

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'spigot-crawl-'));
      const store = await openStore({ dataDir, scale: 0.05 });
      log = createAccessLog(() => {});
      const app = createApp({ store, accessLog: log });
      server = createServer((req, res) => {
        seen.push({
          ua: String(req.headers['user-agent']),
          key: req.headers['x-spigot-key'] as string | undefined,
          inm: req.headers['if-none-match'] as string | undefined,
        });
        app(req, res);
      });
      origin = await listen(server);
    });
    afterAll(async () => {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    });
    beforeEach(() => {
      log.reset();
      seen.length = 0;
    });

    const sitemapCount = async () => {
      const xml = (await safeFetch(`${origin}/sitemap.xml`, { allowLocal: true })).body.toString();
      return (xml.match(/<loc>/g) ?? []).length;
    };

    it('crawls every sitemap page politely, then hands the site to discovery', async () => {
      const siteId = await newSite(origin);
      const order: string[] = [];
      const changed = new Set<string>();
      onPageChanged((pageId) => void changed.add(pageId));
      onRunFinished((runId) => void order.push(`finished:${runId}`));
      onDiscoveryDone(async (sId, runId) => {
        // After commit: the site is already PROPOSING and the run SUCCEEDED.
        order.push(`discovery:${runId}:${await siteStatus(sId)}:${(await runRow(runId)).status}`);
      });
      const total = await sitemapCount();
      expect(total).toBeGreaterThan(100);
      seen.length = 0;
      log.reset();
      const notes: unknown[] = [];
      const listener = await pools.b.connect();
      let result;
      try {
        await listener.query('LISTEN crawl_progress');
        listener.on('notification', (n) => {
          if (n.channel === 'crawl_progress') notes.push(JSON.parse(n.payload!));
        });
        result = await crawlSite({ siteId, trigger: 'CONNECT' }, { ...deps, minGapMs: 2 });
        await drainNotifications(listener, pools.a);
      } finally {
        listener.release();
      }

      expect(result).toMatchObject({ status: 'SUCCEEDED', created: true, discovery: true });
      expect(result.counters).toEqual({
        pages_total: total,
        pages_fetched: total,
        pages_not_modified: 0,
        pages_failed: 0,
      });
      const run = await runRow(result.runId);
      expect(run.workflow_run_id).toBe(`inproc:${result.runId}`);
      expect(run.ai_calls).toBe(0);
      expect(run.finished_at).toBeInstanceOf(Date);
      const pages = await pools.a.query('SELECT count(*)::int AS n FROM pages WHERE site_id = $1', [
        siteId,
      ]);
      expect(pages.rows[0].n).toBe(total);
      expect(await snapshotCounts(siteId)).toEqual(Array(total).fill(1));
      expect(changed.size).toBe(total);

      expect(await siteStatus(siteId)).toBe('PROPOSING');
      expect(order).toEqual([
        `finished:${result.runId}`,
        `discovery:${result.runId}:PROPOSING:SUCCEEDED`,
      ]);

      // ≤ 2 concurrent requests to the origin, from the demo site's own gauge.
      expect(log.stats().maxInFlight).toBeLessThanOrEqual(2);
      // Every request is identified as our crawler with the site's key.
      const key = deriveCrawlKey(siteId, SECRET);
      expect(
        seen.every(
          (s) => s.ua === 'SpigotCrawler/1.0 (+http://spigot.test/crawler)' && s.key === key,
        ),
      ).toBe(true);

      // Progress every 25 pages, then the final status.
      expect(notes.length).toBe(Math.floor(total / 25) + 1);
      expect(notes.at(-1)).toMatchObject({ runId: result.runId, status: 'SUCCEEDED' });

      // A stored snapshot is the gzipped body.
      const snap = await pools.a.query<{ html_gz: Buffer; content_hash: string; bytes: number }>(
        `SELECT s.html_gz, s.content_hash, s.bytes FROM snapshots s JOIN pages p ON p.id = s.page_id
          WHERE p.site_id = $1 LIMIT 1`,
        [siteId],
      );
      const html = gunzipSync(snap.rows[0]!.html_gz);
      expect(sha256(html)).toBe(snap.rows[0]!.content_hash);
      expect(html.length).toBe(snap.rows[0]!.bytes);
      expect(html.toString()).toContain('<html');

      // A second crawl with no changes fetches 0 bodies (lastmod-skipped).
      log.reset();
      seen.length = 0;
      const again = await crawlSite({ siteId, trigger: 'SCHEDULE' }, deps);
      expect(again).toMatchObject({ status: 'SUCCEEDED', discovery: false });
      expect(again.counters).toEqual({
        pages_total: 0,
        pages_fetched: 0,
        pages_not_modified: 0,
        pages_failed: 0,
      });
      expect(seen.length).toBe(1); // the sitemap only

      // MANUAL re-checks everything: all 304, still one snapshot each.
      const manual = await crawlSite({ siteId, trigger: 'MANUAL' }, deps);
      expect(manual.counters).toEqual({
        pages_total: total,
        pages_fetched: 0,
        pages_not_modified: total,
        pages_failed: 0,
      });
      expect(seen.length).toBe(2 + total); // two sitemap reads, then one conditional GET per page
      expect(seen.slice(2).every((s) => s.inm)).toBe(true);
      expect(await snapshotCounts(siteId)).toEqual(Array(total).fill(1));
      expect(await siteStatus(siteId)).toBe('PROPOSING'); // not a discovery run any more
    }, 30_000); // a real crawl over HTTP: ~2 s alone, past the 5 s default under parallel load

    it('two crawlSite calls at once → one run; the second returns its id', async () => {
      const siteId = await newSite(origin);
      const [a, b] = await Promise.all([
        startCrawl({ siteId, trigger: 'MANUAL' }, deps),
        startCrawl({ siteId, trigger: 'MANUAL' }, { ...deps, db: createDb(pools.b) }),
      ]);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.runId).toBe(b.runId);
      const [ra, rb] = await Promise.all([a.done, b.done]);
      expect(ra.status).toBe('SUCCEEDED');
      expect(rb.status).toBe('SUCCEEDED');
      const runs = await pools.a.query(
        'SELECT count(*)::int AS n FROM crawl_runs WHERE site_id = $1',
        [siteId],
      );
      expect(runs.rows[0].n).toBe(1);
      // Once it's over, a new call starts a new run.
      const next = await startCrawl({ siteId, trigger: 'MANUAL' }, deps);
      expect(next.created).toBe(true);
      expect(next.runId).not.toBe(a.runId);
      await next.done;
    });

    it('a killed run is resumed: same hashes, never more than 2 snapshots per page', async () => {
      const siteId = await newSite(origin);
      const kill = new AbortController();
      let fetched = 0;
      const unsubscribe = onPageChanged(() => {
        if (++fetched === 40) kill.abort();
      });
      const first = await crawlSite(
        { siteId, trigger: 'CONNECT' },
        { ...deps, signal: kill.signal },
      );
      unsubscribe();
      expect(first.aborted).toBe(true);
      expect((await runRow(first.runId)).status).toBe('RUNNING'); // dead, as after a crash
      const partial = (await runRow(first.runId)).pages_fetched as number;
      expect(partial).toBeGreaterThanOrEqual(40);

      // A healthy run isn't stolen…
      const join = await startCrawl(
        { siteId, trigger: 'CONNECT' },
        { ...deps, staleRunMs: 60_000 },
      );
      expect(join).toMatchObject({ runId: first.runId, created: false, resumed: false });
      // …but an orphaned one is adopted and finished.
      const resumed = await crawlSite({ siteId, trigger: 'CONNECT' }, { ...deps, staleRunMs: 0 });
      expect(resumed).toMatchObject({
        runId: first.runId,
        created: false,
        resumed: true,
        status: 'SUCCEEDED',
      });
      expect(await join.done).toMatchObject({ runId: first.runId, status: 'SUCCEEDED' });
      const total = await sitemapCount();
      expect(resumed.counters).toMatchObject({
        pages_total: total,
        pages_fetched: total,
        pages_failed: 0,
      });
      expect(await siteStatus(siteId)).toBe('PROPOSING');

      // Hashes equal a direct fetch of each page; one snapshot each.
      const rows = (
        await pools.a.query<{ url: string; content_hash: string }>(
          'SELECT url, content_hash FROM pages WHERE site_id = $1 ORDER BY url LIMIT 30',
          [siteId],
        )
      ).rows;
      for (const r of rows) {
        expect(sha256((await safeFetch(r.url, { allowLocal: true })).body)).toBe(r.content_hash);
      }
      expect(await snapshotCounts(siteId)).toEqual(Array(total).fill(1));

      // Re-running fetchPage on everything (MANUAL, no ETag help) writes no extra snapshot.
      await pools.a.query('UPDATE pages SET etag = NULL WHERE site_id = $1', [siteId]);
      const rerun = await crawlSite({ siteId, trigger: 'MANUAL' }, deps);
      expect(rerun.counters.pages_fetched).toBe(total);
      expect(await snapshotCounts(siteId)).toEqual(Array(total).fill(1));
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('against a stub origin', () => {
    let server: Server;
    let origin: string;
    /** path → handler state */
    let routes: Record<
      string,
      (hit: number) => { status: number; body?: string; headers?: Record<string, string> }
    >;
    let hits: Record<string, number>;
    let paths: string[];

    beforeAll(async () => {
      server = createServer((req, res) => {
        const path = req.url!.split('?')[0]!;
        if (path === '/sitemap.xml') {
          res.writeHead(200, { 'content-type': 'application/xml' });
          res.end(
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
              .map((p) => `<url><loc>${origin}${p}</loc></url>`)
              .join('')}</urlset>`,
          );
          return;
        }
        hits[path] = (hits[path] ?? 0) + 1;
        const route = routes[path] ?? (() => ({ status: 200, body: `<html>${path}</html>` }));
        const r = route(hits[path]!);
        res.writeHead(r.status, { 'content-type': 'text/html', ...r.headers });
        res.end(r.body ?? '');
      });
      origin = await listen(server);
    });
    afterAll(async () => {
      await close(server);
    });
    beforeEach(() => {
      routes = {};
      hits = {};
      paths = Array.from({ length: 20 }, (_, i) => `/p${String(i).padStart(2, '0')}`);
    });

    it('429/503: honours Retry-After, then 3 in a row pause the run and a READY site', async () => {
      const siteId = await newSite(origin, 'READY');
      paths = ['/a', '/b', '/c', '/d'];
      routes['/a'] = (n) =>
        n === 1 ? { status: 503, headers: { 'retry-after': '0' } } : { status: 200, body: 'a' };
      routes['/b'] = () => ({ status: 429, headers: { 'retry-after': '0' } });
      routes['/c'] = () => ({ status: 429, headers: { 'retry-after': '0' } });
      routes['/d'] = () => ({ status: 429, headers: { 'retry-after': '0' } });
      const finished: string[] = [];
      onRunFinished((id) => void finished.push(id));

      const r = await crawlSite({ siteId, trigger: 'MANUAL' }, { ...deps, pageWorkers: 1 });
      expect(r.status).toBe('PAUSED');
      expect(r.counters.pages_fetched).toBe(1); // /a after its 503
      const run = await runRow(r.runId);
      expect(run.error).toMatch(/3 times in a row/);
      expect(run.finished_at).toBeInstanceOf(Date);
      expect(await siteStatus(siteId)).toBe('PAUSED');
      expect(hits['/a']).toBe(2);
      expect(hits['/d']).toBeUndefined(); // nothing more was requested after the pause
      expect(finished).toEqual([]); // paused, not finished
    });

    it('a paused discovery run leaves a VERIFIED site alone (no VERIFIED → PAUSED edge)', async () => {
      const siteId = await newSite(origin, 'VERIFIED');
      paths = ['/a'];
      routes['/a'] = () => ({ status: 429, headers: { 'retry-after': '0' } });
      const r = await crawlSite({ siteId, trigger: 'CONNECT' }, deps);
      expect(r.status).toBe('PAUSED');
      expect(await siteStatus(siteId)).toBe('VERIFIED');
    });

    it('network errors and 5xx retry after 1 s, 4 s, 16 s, then count as failed', async () => {
      const siteId = await newSite(origin);
      paths = ['/ok', '/flaky', '/down'];
      routes['/flaky'] = (n) => (n < 3 ? { status: 500 } : { status: 200, body: 'flaky' });
      routes['/down'] = () => ({ status: 502 });
      const r = await crawlSite({ siteId, trigger: 'CONNECT' }, { ...deps, pageWorkers: 1 });
      expect(hits['/flaky']).toBe(3);
      expect(hits['/down']).toBe(4);
      expect(sleeps).toEqual([1000, 4000, 16000, 1000, 4000]); // /down, then /flaky (url order)
      expect(r).toMatchObject({ status: 'PARTIAL' });
      expect(r.counters).toMatchObject({ pages_total: 3, pages_fetched: 2, pages_failed: 1 });
      // 2/3 fetched < 90%: no discovery hand-off.
      expect(r.discovery).toBe(false);
      expect(await siteStatus(siteId)).toBe('VERIFIED');
    });

    it('a refused connection retries too', async () => {
      const siteId = await newSite(origin);
      paths = ['/x'];
      let calls = 0;
      const r = await crawlSite(
        { siteId, trigger: 'CONNECT' },
        {
          ...deps,
          fetch: async (url, opts) => {
            if (url.endsWith('/x') && ++calls < 3) {
              const { SafeFetchError } = await import('./safeFetch.js');
              throw new SafeFetchError('NETWORK', 'ECONNRESET', url);
            }
            return safeFetch(url, opts);
          },
        },
      );
      expect(r.status).toBe('SUCCEEDED');
      expect(sleeps).toEqual([1000, 4000]);
    });

    it('404/410 twice → removed_at and onPageChanged', async () => {
      const siteId = await newSite(origin, 'PROPOSING');
      paths = ['/gone', '/live'];
      routes['/gone'] = (n) =>
        n === 1 ? { status: 200, body: 'once' } : { status: n === 2 ? 404 : 410 };
      const changed: string[] = [];
      onPageChanged((id) => void changed.push(id));
      const pageId = async (p: string) =>
        (
          await pools.a.query('SELECT id, removed_at, last_status FROM pages WHERE url = $1', [
            `${origin}${p}`,
          ])
        ).rows[0];

      await crawlSite({ siteId, trigger: 'CONNECT' }, deps);
      const gone = await pageId('/gone');
      expect(changed).toContain(gone.id);
      changed.length = 0;

      const second = await crawlSite({ siteId, trigger: 'MANUAL' }, deps);
      expect(second.status).toBe('SUCCEEDED');
      expect(await pageId('/gone')).toMatchObject({ removed_at: null, last_status: 404 });
      expect(changed).toEqual([]);

      // Even a non-MANUAL crawl re-checks a page that answered 404.
      await crawlSite({ siteId, trigger: 'SCHEDULE' }, deps);
      const after = await pageId('/gone');
      expect(after.removed_at).toBeInstanceOf(Date);
      expect(after.last_status).toBe(410);
      expect(changed).toEqual([after.id]);
      // The earlier snapshot is kept. While the sitemap still lists it, upsertPages (SP-009a1)
      // clears removed_at, so each crawl re-checks it: it stays removed, or comes back on a 200.
      expect(await snapshotCounts(siteId)).toEqual([1, 1]);
      await crawlSite({ siteId, trigger: 'SCHEDULE' }, deps);
      expect(hits['/gone']).toBe(4);
      expect((await pageId('/gone')).removed_at).toBeInstanceOf(Date);
      // Dropped from the sitemap too: never fetched again.
      paths = ['/live'];
      await crawlSite({ siteId, trigger: 'MANUAL' }, deps);
      expect(hits['/gone']).toBe(4);
    });

    it('a page dropped from the sitemap fires onPageChanged', async () => {
      const siteId = await newSite(origin, 'PROPOSING');
      paths = ['/a', '/b'];
      await crawlSite({ siteId, trigger: 'CONNECT' }, deps);
      const changed: string[] = [];
      onPageChanged((id) => void changed.push(id));
      paths = ['/a'];
      await crawlSite({ siteId, trigger: 'SCHEDULE' }, deps);
      const b = await pools.a.query('SELECT id FROM pages WHERE url = $1', [`${origin}/b`]);
      expect(changed).toEqual([b.rows[0].id]);
    });

    it('keeps only the newest 2 snapshots; an unchanged body adds none and fires no hook', async () => {
      const siteId = await newSite(origin, 'PROPOSING');
      paths = ['/v'];
      let version = 1;
      routes['/v'] = () => ({
        status: 200,
        body: `<html>v${version}</html>`,
        headers: { etag: `"v${version}"` },
      });
      const changed: string[] = [];
      onPageChanged((id) => void changed.push(id));

      for (version = 1; version <= 4; version++)
        await crawlSite({ siteId, trigger: 'MANUAL' }, deps);
      version = 4;
      await pools.a.query('UPDATE pages SET etag = NULL'); // force a 200 with the same body
      await crawlSite({ siteId, trigger: 'MANUAL' }, deps);

      const snaps = await pools.a.query<{ html_gz: Buffer }>(
        'SELECT html_gz FROM snapshots ORDER BY id',
      );
      expect(snaps.rows.map((s) => gunzipSync(s.html_gz).toString())).toEqual([
        '<html>v3</html>',
        '<html>v4</html>',
      ]);
      expect(changed.length).toBe(4);
      const page = (await pools.a.query('SELECT etag, content_hash, last_status FROM pages'))
        .rows[0];
      expect(page).toMatchObject({
        etag: '"v4"',
        last_status: 200,
        content_hash: sha256(Buffer.from('<html>v4</html>')),
      });
    });

    it('PARTIAL discovery with 95% fetched still moves the site to PROPOSING; 50% does not', async () => {
      const discovered: string[] = [];
      onDiscoveryDone((siteId) => void discovered.push(siteId));

      const s95 = await newSite(origin);
      routes['/p00'] = () => ({ status: 403 });
      const r95 = await crawlSite({ siteId: s95, trigger: 'CONNECT' }, deps);
      expect(r95).toMatchObject({ status: 'PARTIAL', discovery: true });
      expect(r95.counters).toMatchObject({ pages_total: 20, pages_fetched: 19, pages_failed: 1 });
      expect(await siteStatus(s95)).toBe('PROPOSING');
      expect(discovered).toEqual([s95]);

      await pools.a.query('TRUNCATE snapshots, crawl_runs, pages, sites, publishers CASCADE');
      const s50 = await newSite(origin);
      for (let i = 0; i < 10; i++)
        routes[`/p${String(i).padStart(2, '0')}`] = () => ({ status: 403 });
      const r50 = await crawlSite({ siteId: s50, trigger: 'CONNECT' }, deps);
      expect(r50).toMatchObject({ status: 'PARTIAL', discovery: false });
      expect(await siteStatus(s50)).toBe('VERIFIED');
      expect(discovered).toEqual([s95]);
    });

    it('no sitemap → run FAILED, onRunFinished fires, no discovery', async () => {
      const siteId = await newSite('http://127.0.0.1:1'); // nothing listens on port 1
      const finished: string[] = [];
      onRunFinished((id) => void finished.push(id));
      const r = await crawlSite({ siteId, trigger: 'CONNECT' }, deps);
      expect(r).toMatchObject({ status: 'FAILED', discovery: false });
      expect((await runRow(r.runId)).error).toMatch(/sitemap/i);
      expect(finished).toEqual([r.runId]);
      expect(await siteStatus(siteId)).toBe('VERIFIED');
    });

    it('rejects APPROVE and unknown sites', async () => {
      const siteId = await newSite(origin);
      await expect(startCrawl({ siteId, trigger: 'APPROVE' as never }, deps)).rejects.toThrow(
        /not a crawl trigger/,
      );
      await expect(
        startCrawl({ siteId: '00000000-0000-0000-0000-000000000000', trigger: 'MANUAL' }, deps),
      ).rejects.toThrow(/not found/);
    });
  });
});
