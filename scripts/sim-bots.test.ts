// SP-037 `sim:bots`: the pure pieces, plus the live runner against the real demo site and the
// real spigot-gate (stub Spigot API), in demo mode and out of it.
import { spigotGate } from '@spigot/gate';
import {
  MAX_HIT_BUCKETS,
  gateHitBucketSchema,
  gateHitsSchema,
  gatePolicySchema,
  type GateHitBucket,
  type GateHits,
} from '@spigot/shared/gate';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccessLog } from '../apps/demo-site/src/accessLog.js';
import { createApp } from '../apps/demo-site/src/app.js';
import { createStore } from '../apps/demo-site/src/data/store.js';
import {
  DEFAULT_DECISIONS,
  HUMAN_LABEL,
  MAX_POST_BYTES,
  MIN_POST_GAP_MS,
  OPEN_PATHS,
  buildAgents,
  buildBackfill,
  createScheduler,
  createTally,
  demoModeWarnings,
  fetchDecisions,
  googlebotQuoted,
  mulberry32,
  packBatches,
  parseDuration,
  parseRate,
  payloadBytes,
  postBatches,
  renderTally,
  runLive,
  sitemapPaths,
} from './sim-bots.lib.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const WEEK = parseDuration('7d');
const NOW = Date.parse('2026-11-12T15:37:42.123Z');

describe('arguments', () => {
  it('parses durations and rates', () => {
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(() => parseDuration('7 days')).toThrow(/bad duration/);
    expect(() => parseDuration('0d')).toThrow(/positive/);
    expect(parseRate('2-5', 'x')).toEqual([2, 5]);
    expect(parseRate('60', 'x')).toEqual([60, 60]);
    expect(() => parseRate('5-2', 'x')).toThrow(/MIN > MAX/);
    expect(() => parseRate('fast', 'x')).toThrow(/bad x/);
  });

  it('reads sitemap paths', () => {
    const xml = `<urlset><url><loc>https://a.example/listings/x</loc></url>
      <url><loc> https://a.example/agents/y?p=1&amp;q=2 </loc></url>
      <url><loc>https://a.example/listings/x</loc></url><url><loc>nope</loc></url></urlset>`;
    expect(sitemapPaths(xml)).toEqual(['/listings/x', '/agents/y?p=1&q=2']);
  });
});

describe('agents and scheduling', () => {
  it('names the six bots as the gate does, each at 2–5 req/s, plus humans', () => {
    const agents = buildAgents(mulberry32(1), [2, 5], 60);
    expect(agents.map((a) => [a.label, a.category])).toEqual([
      ['GPTBot', 'AI_TRAINING'],
      ['ClaudeBot', 'AI_TRAINING'],
      ['CCBot', 'AI_TRAINING'],
      ['python-requests', 'SCRAPER_TOOL'],
      ['Scrapy', 'SCRAPER_TOOL'],
      ['Googlebot', 'SEARCH'],
      [HUMAN_LABEL, 'HUMAN'],
    ]);
    for (const a of agents.slice(0, 6)) expect(a.rps).toBeGreaterThanOrEqual(2);
    for (const a of agents.slice(0, 6)) expect(a.rps).toBeLessThanOrEqual(5);
    expect(agents[6]!.rps).toBe(60);
  });

  it('the scheduler fires rate × time requests, fractional rates included', () => {
    const s = createScheduler([2.5, 60, 0]);
    const total = [0, 0, 0];
    for (let i = 0; i < 100; i++) s.take(100).forEach((n, j) => (total[j]! += n));
    expect(total).toEqual([25, 600, 0]);
  });

  it('tallies decisions by bot and renders them', () => {
    const t = createTally(['GPTBot', 'Googlebot']);
    t.record('GPTBot', 'quote');
    t.record('GPTBot', 'ok');
    t.record('GPTBot', 'skipped');
    t.record('Googlebot', 'ok');
    expect(t.get('GPTBot')).toMatchObject({ sent: 2, quote: 1, ok: 1, skipped: 1 });
    expect(googlebotQuoted(t)).toBe(false);
    t.record('Googlebot', 'quote');
    expect(googlebotQuoted(t)).toBe(true);
    expect(renderTally(t.rows(), 'h')).toMatch(/GPTBot\s+2\s+1\s+1\s+0\s+0\s+1/);
  });
});

describe('demo-mode warnings', () => {
  it('warns without SPIGOT_GATE_DEMO=1, and for a remote target it cannot check', () => {
    expect(demoModeWarnings({ SPIGOT_GATE_DEMO: '1' }, 'http://localhost:4100')).toEqual([]);
    expect(demoModeWarnings({}, 'http://127.0.0.1:4100')[0]).toMatch(/REAL bot traffic, not SIM/);
    expect(demoModeWarnings({ SPIGOT_GATE_DEMO: '0' }, 'http://localhost:4100')).toHaveLength(1);
    const remote = demoModeWarnings({ SPIGOT_GATE_DEMO: '1' }, 'https://bluebonnet.onrender.com');
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatch(/bluebonnet\.onrender\.com is remote/);
  });
});

describe('backfill buckets', () => {
  const agents = buildAgents(mulberry32(7), [2, 5], 60);
  const buckets = buildBackfill({
    agents,
    now: NOW,
    durationMs: WEEK,
    stepMinutes: 10,
    decisions: DEFAULT_DECISIONS,
    rng: mulberry32(8),
  });

  it('covers the past week up to the current minute, all SIM and schema-valid', () => {
    for (const b of buckets) gateHitBucketSchema.parse(b);
    expect(buckets.every((b) => b.isSimulated)).toBe(true);
    const times = buckets.map((b) => Date.parse(b.bucket));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(NOW - WEEK - 60_000);
    expect(Math.max(...times)).toBeLessThan(Date.parse('2026-11-12T15:37:00Z'));
    expect(new Set(times).size).toBe(7 * 24 * 6);
  });

  it('quotes the categories the policy quotes, passes search and humans', () => {
    const decisionsOf = (bot: string) =>
      new Set(buckets.filter((b) => b.botName === bot).map((b) => b.decision));
    expect(decisionsOf('GPTBot')).toEqual(new Set(['QUOTE_402', 'PASS']));
    expect(decisionsOf('python-requests')).toEqual(new Set(['QUOTE_402', 'PASS']));
    expect(decisionsOf('Googlebot')).toEqual(new Set(['PASS']));
    expect(decisionsOf('-')).toEqual(new Set(['PASS']));
    const gpt = buckets.filter((b) => b.botName === 'GPTBot');
    const quoted = gpt.filter((b) => b.decision === 'QUOTE_402').reduce((n, b) => n + b.hits, 0);
    const all = gpt.reduce((n, b) => n + b.hits, 0);
    expect(quoted / all).toBeCloseTo(0.85, 1);
    // ~2–5 req/s over a week, ±30 % jitter.
    expect(all).toBeGreaterThan((2 * 0.7 * WEEK) / 1000);
    expect(all).toBeLessThan((5 * 1.3 * WEEK) / 1000);

    const passAll = buildBackfill({
      agents,
      now: NOW,
      durationMs: 3_600_000,
      stepMinutes: 10,
      decisions: { ...DEFAULT_DECISIONS, AI_TRAINING: 'PASS' },
      rng: mulberry32(8),
    });
    expect(passAll.filter((b) => b.botName === 'GPTBot').every((b) => b.decision === 'PASS')).toBe(
      true,
    );
  });

  it('packs a week into as few posts as fit 1 MB and the bucket cap, under a minute of posting', () => {
    const batches = packBatches(buckets, new Date(NOW).toISOString());
    for (const b of batches) {
      gateHitsSchema.parse(b);
      expect(payloadBytes(b)).toBeLessThanOrEqual(MAX_POST_BYTES);
      expect(b.buckets.length).toBeLessThanOrEqual(MAX_HIT_BUCKETS);
    }
    expect(batches.flatMap((b) => b.buckets)).toEqual(buckets);
    const total = buckets.reduce((n, b) => n + Buffer.byteLength(JSON.stringify(b)) + 1, 0);
    expect(batches.length).toBe(Math.ceil(total / MAX_POST_BYTES));
    // N posts take (N - 1) gaps; leave ample room under 60 s for the posts themselves.
    expect((batches.length - 1) * MIN_POST_GAP_MS).toBeLessThan(30_000);
  });

  it('splits on the bucket cap too', () => {
    const small = packBatches(buckets.slice(0, 25), 'x', MAX_POST_BYTES, 10);
    expect(small.map((b) => b.buckets.length)).toEqual([10, 10, 5]);
  });
});

/** Fake clock + fetch for the poster: records when each post started and answers from a script. */
function fakeApi(answers: { status: number; retryAfter?: string }[]) {
  let t = 0;
  const posts: { at: number; body: GateHits; auth: string | null }[] = [];
  const fetchFn = (async (_url: URL, init: RequestInit) => {
    posts.push({
      at: t,
      body: JSON.parse(init.body as string) as GateHits,
      auth: new Headers(init.headers).get('authorization'),
    });
    t += 300; // each post takes 300 ms
    const a = answers.shift() ?? { status: 204 };
    const headers = a.retryAfter ? { 'retry-after': a.retryAfter } : undefined;
    const body = a.status >= 400 ? JSON.stringify({ error: { code: 'X', message: 'nope' } }) : null;
    return new Response(body, { status: a.status, headers });
  }) as unknown as typeof fetch;
  return {
    posts,
    opts: {
      apiBase: 'http://api.test',
      gateKey: 'gk_test',
      fetch: fetchFn,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
    },
  };
}

const batch = (n: number): GateHits => ({
  sentAt: '2026-11-12T00:00:00Z',
  buckets: Array.from({ length: n }, (_, i): GateHitBucket => ({
    bucket: new Date(Date.UTC(2026, 10, 11, 0, i)).toISOString(),
    category: 'AI_TRAINING',
    botName: 'GPTBot',
    decision: 'QUOTE_402',
    hits: 2,
    bytes: 0,
    isSimulated: true,
  })),
});

describe('postBatches', () => {
  it('starts posts ≥ 5 s apart, with the gate key as a Bearer token', async () => {
    const api = fakeApi([]);
    const r = await postBatches([batch(1), batch(2), batch(3)], api.opts);
    expect(r).toMatchObject({ posts: 3, buckets: 6, hits: 12, rateLimited: 0 });
    expect(api.posts.map((p) => p.at)).toEqual([0, MIN_POST_GAP_MS, 2 * MIN_POST_GAP_MS]);
    expect(api.posts.every((p) => p.auth === 'Bearer gk_test')).toBe(true);
  });

  it('a 429 waits Retry-After and resends the same batch', async () => {
    const api = fakeApi([{ status: 204 }, { status: 429, retryAfter: '4' }]);
    const r = await postBatches([batch(1), batch(2)], api.opts);
    expect(r).toMatchObject({ posts: 2, buckets: 3, rateLimited: 1 });
    expect(api.posts).toHaveLength(3);
    expect(api.posts[2]!.body).toEqual(api.posts[1]!.body);
    expect(api.posts[2]!.at - api.posts[1]!.at).toBeGreaterThanOrEqual(4_000);
  });

  it('stops on any other error, without echoing the key', async () => {
    const api = fakeApi([{ status: 400 }]);
    await expect(postBatches([batch(1), batch(1)], api.opts)).rejects.toThrow(
      /^POST \/api\/gate\/hits → 400 X nope$/,
    );
    expect(api.posts).toHaveLength(1);
  });

  it('reads the site decisions from the policy, or null', async () => {
    const ok = (async () =>
      Response.json({
        decisions: { ...DEFAULT_DECISIONS, SEARCH: 'QUOTE' },
      })) as unknown as typeof fetch;
    expect(await fetchDecisions('http://api.test', 'gk', ok)).toEqual({
      ...DEFAULT_DECISIONS,
      SEARCH: 'QUOTE',
    });
    const down = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    expect(await fetchDecisions('http://api.test', 'gk', down)).toBeNull();
  });
});

// --- Live: real demo site + real gate + stub Spigot API -------------------------------------

const POLICY = gatePolicySchema.parse({
  siteId: 'site_bluebonnet',
  policyVersion: 1,
  apiBase: 'https://spigot.onrender.com/v1/bluebonnet',
  catalogUrl: 'https://spigot.onrender.com/c/bluebonnet',
  crawlKeySha256: createHash('sha256').update('ck_sim').digest('hex'),
  gatedPaths: ['^/listings/', '^/agents/', '^/open-houses/'],
  decisions: DEFAULT_DECISIONS,
  prices: [{ dataset: 'listings', perRecordMicros: 1500, display: '$1.50 per 1,000 records' }],
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stubApi() {
  const hits: GateHitBucket[] = [];
  const base = await listen(
    createServer((req, res) => {
      if (req.url === '/api/gate/policy')
        return res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(POLICY));
      if (req.url === '/api/gate/hits' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          hits.push(...gateHitsSchema.parse(JSON.parse(body)).buckets);
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(404).end();
    }),
  );
  return { base, hits };
}

async function demoSite(demo: boolean) {
  const api = await stubApi();
  const gate = spigotGate({
    apiBase: api.base,
    gateKey: 'gk_sim',
    demo,
    flushIntervalMs: 60_000,
    logger: { info: () => {}, warn: () => {} },
  });
  cleanups.push(() => gate.stop());
  await gate.refresher.refresh(); // joins the boot fetch
  expect(gate.refresher.current).not.toBeNull();
  const app = createApp({
    store: createStore(0.05),
    gate: (req, res, next) => gate(req, res, next),
    accessLog: createAccessLog(() => {}),
  });
  const target = await listen(createServer(app));
  const pages = sitemapPaths(await (await fetch(`${target}/sitemap.xml`)).text());
  return { target, pages, gate, api };
}

describe('live traffic through the real gate', () => {
  async function run(demo: boolean) {
    const site = await demoSite(demo);
    expect(site.pages.some((p) => p.startsWith('/listings/'))).toBe(true);
    const agents = buildAgents(mulberry32(3), [5, 5], 20);
    const tally = await runLive({
      target: site.target,
      agents,
      pages: site.pages,
      durationMs: 1_500,
      rng: mulberry32(4),
    });
    await site.gate.flusher.flush();
    return { tally, hits: site.api.hits };
  }

  it('demo mode: GPTBot / python-requests get 402, Googlebot and humans 200, all counted SIM', async () => {
    const { tally, hits } = await run(true);
    for (const bot of ['GPTBot', 'ClaudeBot', 'CCBot', 'python-requests', 'Scrapy']) {
      const row = tally.get(bot)!;
      expect(row.quote, bot).toBeGreaterThan(0);
      expect(row.error + row.other, bot).toBe(0);
    }
    for (const label of ['Googlebot', HUMAN_LABEL]) {
      const row = tally.get(label)!;
      expect(row.ok, label).toBe(row.sent);
      expect(row.sent, label).toBeGreaterThan(0);
    }
    const sent = tally.rows().reduce((n, r) => n + r.sent, 0);
    const sim = hits.filter((b) => b.isSimulated);
    expect(sim.reduce((n, b) => n + b.hits, 0)).toBe(sent);
    // The only real hit is the test's own sitemap fetch (no X-Spigot-Sim header).
    expect(hits.filter((b) => !b.isSimulated).reduce((n, b) => n + b.hits, 0)).toBe(1);
    expect(hits.find((b) => b.botName === 'GPTBot' && b.decision === 'QUOTE_402')).toBeDefined();
    expect(hits.find((b) => b.category === 'HUMAN' && b.decision === 'PASS')).toBeDefined();
  });

  it('without SPIGOT_GATE_DEMO=1 the same traffic is counted, but not as SIM', async () => {
    const { tally, hits } = await run(false);
    expect(tally.get('GPTBot')!.quote).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((b) => !b.isSimulated)).toBe(true);
  });

  it('open paths pass for every bot', () => {
    expect(OPEN_PATHS.every((p) => !POLICY.gatedPaths.some((re) => new RegExp(re).test(p)))).toBe(
      true,
    );
  });
});
