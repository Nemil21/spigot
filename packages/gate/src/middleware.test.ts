import { gateHitsSchema, type GateHitBucket } from '@spigot/shared/gate';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CRAWL_KEY, demoPolicyWire } from './fixtures.test-helpers.js';
import { prefersHtml, spigotGate, type GateOptions, type SpigotGate } from './middleware.js';
import type { FetchLike } from './refresher.js';

const quiet = { info: () => {}, warn: () => {} };
const PAGE = '<html>a listing page</html>';

let server: Server | undefined;
let gate: SpigotGate | undefined;
afterEach(async () => {
  gate?.stop();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A stub Spigot API: serves the policy (or fails) and records hit posts. */
function stubApi(policy: () => Response | Promise<Response>) {
  const posts: GateHitBucket[][] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith('/api/gate/policy')) return policy();
    posts.push(gateHitsSchema.parse(JSON.parse(String(init.body))).buckets);
    return new Response(null, { status: 204 });
  };
  return { posts, fetch };
}

async function start(over: Partial<GateOptions>, fetch: FetchLike) {
  gate = spigotGate({
    apiBase: 'https://spigot.test',
    gateKey: 'gk_test',
    fetch,
    logger: quiet,
    policyIntervalMs: 3_600_000,
    flushIntervalMs: 3_600_000,
    ...over,
  });
  await gate.refresher.refresh();
  const g = gate;
  server = createServer((req: IncomingMessage & { path?: string }, res) => {
    g(req, res, () => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('content-length', Buffer.byteLength(PAGE));
      res.end(PAGE);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const okPolicy = () => new Response(JSON.stringify(demoPolicyWire()), { status: 200 });

describe('prefersHtml', () => {
  it.each([
    [undefined, false],
    ['*/*', false],
    ['application/json', false],
    ['text/html', true],
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', true],
    ['application/json, text/html;q=0.5', false],
    ['text/*', true],
    ['text/html;q=0.2, */*;q=0.1', true],
  ])('%s → %s', (accept, html) => {
    expect(prefersHtml(accept)).toBe(html);
  });
});

describe('spigotGate on a plain node:http server', () => {
  it('402 JSON for GPTBot, D04 HTML when Accept prefers html, PASS for browsers', async () => {
    const { fetch } = stubApi(okPolicy);
    const base = await start({}, fetch);

    const bot = await globalThis.fetch(`${base}/listings/x`, {
      headers: { 'user-agent': 'GPTBot/1.2' },
    });
    expect(bot.status).toBe(402);
    expect(bot.headers.get('content-type')).toMatch(/application\/json/);
    expect(bot.headers.get('cache-control')).toBe('no-store');
    expect(bot.headers.get('link')).toContain('rel="payment"');
    const body = await bot.json();
    expect(body.datasets[0].perRecordMicros).toBe(1500);
    expect(body.datasets[0].endpoint).toBe(
      'https://spigot.onrender.com/v1/bluebonnet/datasets/listings/records',
    );

    const html = await globalThis.fetch(`${base}/listings/x`, {
      headers: { 'user-agent': 'GPTBot/1.2', accept: 'text/html' },
    });
    expect(html.status).toBe(402);
    expect(await html.text()).toContain('402 Payment Required');

    const human = await globalThis.fetch(`${base}/listings/x?ref=1`, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      },
    });
    expect(human.status).toBe(200);
    expect(await human.text()).toBe(PAGE);
  });

  it('HEAD gets the 402 headers without a body', async () => {
    const { fetch } = stubApi(okPolicy);
    const base = await start({}, fetch);
    const res = await globalThis.fetch(`${base}/listings/x`, {
      method: 'HEAD',
      headers: { 'user-agent': 'curl/8.4' },
    });
    expect(res.status).toBe(402);
    expect(await res.text()).toBe('');
  });

  it('no policy yet → passes everything and counts nothing', async () => {
    const { fetch, posts } = stubApi(() => new Response('down', { status: 500 }));
    const base = await start({}, fetch);
    const res = await globalThis.fetch(`${base}/listings/x`, {
      headers: { 'user-agent': 'GPTBot' },
    });
    expect(res.status).toBe(200);
    await gate!.flusher.flush();
    expect(posts).toHaveLength(0);
  });

  it('an exception in classify → PASS, counted as FAIL_OPEN', async () => {
    const { fetch, posts } = stubApi(okPolicy);
    const base = await start(
      {
        classify: () => {
          throw new Error('injected');
        },
      },
      fetch,
    );
    const res = await globalThis.fetch(`${base}/listings/x`, {
      headers: { 'user-agent': 'GPTBot' },
    });
    expect(res.status).toBe(200);
    await gate!.flusher.flush();
    expect(posts[0]).toEqual([
      expect.objectContaining({
        decision: 'FAIL_OPEN',
        category: 'UNKNOWN',
        hits: 1,
        isSimulated: false,
      }),
    ]);
  });

  it('counts the crawler as SPIGOT_CRAWLER, never 402, with response bytes', async () => {
    const { fetch, posts } = stubApi(okPolicy);
    const base = await start({}, fetch);
    const res = await globalThis.fetch(`${base}/listings/x`, {
      headers: { 'user-agent': 'SpigotBot/1.0 python-requests/2.32', 'x-spigot-key': CRAWL_KEY },
    });
    expect(res.status).toBe(200);
    await res.text();
    await expect.poll(() => gate!.flusher.size).toBe(1);
    await gate!.flusher.flush();
    expect(posts[0]).toEqual([
      expect.objectContaining({
        decision: 'SPIGOT_CRAWLER',
        botName: 'SpigotCrawler',
        hits: 1,
        bytes: Buffer.byteLength(PAGE),
      }),
    ]);
  });

  it('X-Spigot-Sim marks counts simulated only in demo mode', async () => {
    for (const demo of [false, true]) {
      const { fetch, posts } = stubApi(okPolicy);
      const base = await start({ demo }, fetch);
      await globalThis.fetch(`${base}/listings/x`, {
        headers: { 'user-agent': 'GPTBot', 'x-spigot-sim': '1' },
      });
      await gate!.flusher.flush();
      expect(posts[0]![0]!.isSimulated).toBe(demo);
      gate!.stop();
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  it('402 hits carry an avoided-bytes estimate from gated pages served', async () => {
    const { fetch, posts } = stubApi(okPolicy);
    const base = await start({}, fetch);
    const human = await globalThis.fetch(`${base}/listings/y`, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/133.0' },
    });
    await human.text();
    await expect.poll(() => gate!.flusher.size).toBe(1);
    await globalThis.fetch(`${base}/listings/x`, { headers: { 'user-agent': 'ClaudeBot' } });
    await gate!.flusher.flush();
    const quote = posts[0]!.find((b) => b.decision === 'QUOTE_402')!;
    expect(quote).toMatchObject({
      category: 'AI_TRAINING',
      botName: 'ClaudeBot',
      bytes: Buffer.byteLength(PAGE),
    });
    expect(posts[0]!.find((b) => b.category === 'HUMAN')).toMatchObject({
      botName: '-',
      decision: 'PASS',
    });
  });
});
