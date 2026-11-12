// SP-006b integration: Bluebonnet Rentals + spigot-gate against a stub Spigot API in each
// failure mode. Real HTTP both ways (supertest → app, gate → stub), default 2 s timeout.
import { gatePolicySchema, gateHitsSchema, type GateHitBucket } from '@spigot/shared/gate';
import type { GateLogger } from '@spigot/gate';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccessLog } from './accessLog.js';
import { createApp } from './app.js';
import { createStore } from './data/store.js';
import { gateFromEnv } from './gate.js';

const CRAWL_KEY = 'ck_integration_crawl_key';
const GATE_KEY = 'gk_integration_gate_key';
const HUMAN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const POLICY = gatePolicySchema.parse({
  siteId: 'site_bluebonnet',
  policyVersion: 1,
  apiBase: 'https://spigot.onrender.com/v1/bluebonnet',
  catalogUrl: 'https://spigot.onrender.com/c/bluebonnet',
  crawlKeySha256: createHash('sha256').update(CRAWL_KEY).digest('hex'),
  gatedPaths: ['^/listings/', '^/agents/', '^/open-houses/'],
  decisions: {
    SEARCH: 'PASS',
    AI_TRAINING: 'QUOTE',
    AI_AGENT: 'QUOTE',
    SCRAPER_TOOL: 'QUOTE',
    UNKNOWN: 'PASS',
  },
  prices: [{ dataset: 'listings', perRecordMicros: 1500, display: '$1.50 per 1,000 records' }],
});

type Mode = 'ok' | 'slow' | '500' | 'down';

const store = createStore(0.05);
const listing = store.listings[0]!;
const quiet = { info: () => {}, warn: () => {} };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A stub Spigot API. `down` closes the port so connects are refused. */
async function stubApi(initial: Mode) {
  const state = {
    mode: initial,
    hits: [] as GateHitBucket[][],
    auth: [] as (string | undefined)[],
  };
  const server: Server = createServer((req, res) => {
    state.auth.push(req.headers.authorization);
    if (req.url === '/api/gate/policy') {
      if (state.mode === '500') return res.writeHead(500).end('{"error":"boom"}');
      if (state.mode === 'slow')
        return void setTimeout(() => res.end(JSON.stringify(POLICY)), 10_000).unref();
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(POLICY));
    }
    if (req.url === '/api/gate/hits' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.hits.push(gateHitsSchema.parse(JSON.parse(body)).buckets);
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  if (initial === 'down') await close();
  else cleanups.push(close);
  return { base, state, close };
}

function site(apiBase: string, demo = false, logger: GateLogger = quiet) {
  const gate = gateFromEnv(
    {
      SPIGOT_API_BASE: apiBase,
      SPIGOT_GATE_KEY: GATE_KEY,
      SPIGOT_GATE_DEMO: demo ? '1' : undefined,
    },
    logger,
  )!;
  cleanups.push(() => gate.stop());
  const app = createApp({ store, gate: gate.handler, accessLog: createAccessLog(() => {}) });
  return { app, gate };
}

/**
 * The gate's API timeouts (AbortSignal.timeout) fire when the test says so, not on the clock.
 * `ms` records the timeout each fetch asked for.
 */
function holdTimeouts() {
  const held: AbortController[] = [];
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const c = new AbortController();
    held.push(c);
    return c.signal;
  });
  cleanups.push(() => spy.mockRestore());
  return {
    ms: () => spy.mock.calls.map(([ms]) => ms),
    fire: () => {
      for (const c of held)
        c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    },
  };
}

describe('gateFromEnv', () => {
  it('is off (null) until both SPIGOT_API_BASE and SPIGOT_GATE_KEY are set', () => {
    expect(gateFromEnv({}, quiet)).toBeNull();
    expect(gateFromEnv({ SPIGOT_API_BASE: 'http://x' }, quiet)).toBeNull();
    expect(gateFromEnv({ SPIGOT_GATE_KEY: 'gk' }, quiet)).toBeNull();
  });
});

describe('fail-open: the site never goes down with Spigot', () => {
  // A gate that awaited the policy fetch on the request path would never answer while that
  // fetch is held open, so "served while the fetch is pending" needs no clock.
  async function servesEveryone(app: ReturnType<typeof site>['app'], phase: string) {
    for (const [ua, path] of [
      [HUMAN_UA, `/listings/${listing.slug}`],
      [HUMAN_UA, '/'],
      ['GPTBot/1.2', `/listings/${listing.slug}`],
    ] as const) {
      const res = await request(app).get(path).set('User-Agent', ua);
      expect(res.status, `${phase}: ${ua} ${path}`).toBe(200);
    }
  }

  it.each(['down', 'slow', '500'] as const)(
    'API %s → humans and bots get 200 while the policy fetch is in flight and after it fails',
    async (mode) => {
      const timeouts = holdTimeouts();
      const warnings: string[] = [];
      const api = await stubApi(mode);
      const { app } = site(api.base, false, { info: () => {}, warn: (m) => warnings.push(m) });
      const failed = () => warnings.some((w) => /passing every request/.test(w));

      if (mode === 'slow') {
        // The stub holds the policy request open; the 2 s timeout hasn't fired.
        await expect.poll(() => api.state.auth.length, { timeout: 5_000 }).toBe(1);
        await servesEveryone(app, 'policy fetch in flight');
        expect(warnings).toEqual([]);
        timeouts.fire();
      } else {
        await servesEveryone(app, 'policy fetch starting');
      }
      await expect.poll(failed, { timeout: 5_000 }).toBe(true);
      await servesEveryone(app, 'policy fetch failed');
      expect(timeouts.ms()[0]).toBe(2_000); // the default policy timeout
    },
  );

  it('API dies after the policy loaded → keeps the last good policy; humans still 200', async () => {
    const api = await stubApi('ok');
    const { app } = site(api.base);
    await expect
      .poll(() =>
        request(app)
          .get(`/listings/${listing.slug}`)
          .set('User-Agent', 'GPTBot')
          .then((r) => r.status),
      )
      .toBe(402);
    await api.close();
    const human = await request(app).get(`/listings/${listing.slug}`).set('User-Agent', HUMAN_UA);
    expect(human.status).toBe(200);
    const bot = await request(app).get(`/listings/${listing.slug}`).set('User-Agent', 'GPTBot');
    expect(bot.status).toBe(402);
  });
});

describe('with a live policy', () => {
  async function ready(demo = false) {
    const api = await stubApi('ok');
    const s = site(api.base, demo);
    await expect
      .poll(() =>
        request(s.app)
          .get('/listings/x')
          .set('User-Agent', 'GPTBot')
          .then((r) => r.status),
      )
      .toBe(402);
    return { api, ...s };
  }

  it('sends the gate key as a Bearer token', async () => {
    const { api } = await ready();
    expect(api.state.auth[0]).toBe(`Bearer ${GATE_KEY}`);
  });

  it('curl -A GPTBot /listings/x → 402 JSON with price and API link; Accept: text/html → D04', async () => {
    const { app } = await ready();
    const json = await request(app).get('/listings/x').set('User-Agent', 'GPTBot');
    expect(json.status).toBe(402);
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    expect(json.headers['cache-control']).toBe('no-store');
    expect(json.headers['spigot-price']).toBe('listings; per-record-micros=1500');
    expect(json.headers.link).toContain(
      '<https://spigot.onrender.com/v1/bluebonnet/datasets/listings>; rel="alternate"',
    );
    expect(json.body.error.code).toBe('PAYMENT_REQUIRED');
    expect(json.body.error.message).toContain('$1.50 per 1,000');
    expect(json.body.datasets[0]).toMatchObject({
      slug: 'listings',
      perRecordMicros: 1500,
      endpoint: 'https://spigot.onrender.com/v1/bluebonnet/datasets/listings/records',
    });

    const html = await request(app)
      .get('/listings/x')
      .set('User-Agent', 'GPTBot')
      .set('Accept', 'text/html');
    expect(html.status).toBe(402);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.text).toContain('402 Payment Required');
    expect(html.text).toContain('https://spigot.onrender.com/c/bluebonnet');
  });

  it('never 403; search bots, humans and ungated paths pass', async () => {
    const { app } = await ready();
    expect(
      (
        await request(app)
          .get(`/listings/${listing.slug}`)
          .set(
            'User-Agent',
            'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          )
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(`/listings/${listing.slug}`).set('User-Agent', HUMAN_UA)).status,
    ).toBe(200);
    expect((await request(app).get('/robots.txt').set('User-Agent', 'GPTBot')).status).toBe(200);
    expect(
      (await request(app).get('/sitemap.xml').set('User-Agent', 'python-requests/2.32')).status,
    ).toBe(200);
  });

  it('admin stays before the gate: the CLI is never 402', async () => {
    const api = await stubApi('ok');
    const gate = gateFromEnv({ SPIGOT_API_BASE: api.base, SPIGOT_GATE_KEY: GATE_KEY }, quiet)!;
    cleanups.push(() => gate.stop());
    const app = createApp({
      store,
      gate: gate.handler,
      adminToken: 'admintok',
      accessLog: createAccessLog(() => {}),
    });
    await expect
      .poll(() =>
        request(app)
          .get('/listings/x')
          .set('User-Agent', 'node-fetch')
          .then((r) => r.status),
      )
      .toBe(402);
    const res = await request(app)
      .get('/admin/state')
      .set('User-Agent', 'node-fetch')
      .set('Authorization', 'Bearer admintok');
    expect(res.status).not.toBe(402);
  });

  it('our crawler (valid X-Spigot-Key) is never 402 and is flushed as decision=SPIGOT_CRAWLER', async () => {
    const { api, app, gate } = await ready();
    for (const ua of ['SpigotBot/1.0', 'python-requests/2.32', 'GPTBot']) {
      const res = await request(app)
        .get(`/listings/${listing.slug}`)
        .set('User-Agent', ua)
        .set('X-Spigot-Key', CRAWL_KEY);
      expect(res.status).toBe(200);
    }
    const wrong = await request(app)
      .get(`/listings/${listing.slug}`)
      .set('User-Agent', 'python-requests/2.32')
      .set('X-Spigot-Key', 'ck_wrong');
    expect(wrong.status).toBe(402);

    await gate.flush();
    const buckets = api.state.hits.flat();
    const crawler = buckets.find((b) => b.decision === 'SPIGOT_CRAWLER')!;
    expect(crawler).toMatchObject({ botName: 'SpigotCrawler', hits: 3, isSimulated: false });
    expect(crawler.bytes).toBeGreaterThan(0);
    expect(
      buckets.find((b) => b.decision === 'QUOTE_402' && b.botName === 'python-requests'),
    ).toBeDefined();
  });

  it('SPIGOT_GATE_DEMO=1 + X-Spigot-Sim: 1 → counted with isSimulated=true', async () => {
    const { api, app, gate } = await ready(true);
    await request(app).get('/listings/x').set('User-Agent', 'ClaudeBot').set('X-Spigot-Sim', '1');
    await request(app).get('/listings/x').set('User-Agent', 'ClaudeBot');
    await gate.flush();
    const claude = api.state.hits.flat().filter((b) => b.botName === 'ClaudeBot');
    expect(claude.map((b) => [b.isSimulated, b.hits]).sort()).toEqual([
      [false, 1],
      [true, 1],
    ]);
  });
});
