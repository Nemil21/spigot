import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { benchInputs, benchPolicy } from './bench.js';
import { classify } from './classify.js';
import type { HitInput } from './flusher.js';
import { demoPolicyWire } from './fixtures.test-helpers.js';
import { spigotGate, type SpigotGate } from './middleware.js';
import type { FetchLike } from './refresher.js';
import {
  createSearchVerifier,
  isNonPublicIp,
  normalizeIp,
  verifyIp,
  type DnsResolver,
} from './verifySearch.js';

const GOOGLE_IP = '66.249.66.1';
const GOOGLE_HOST = 'crawl-66-249-66-1.googlebot.com';
const SPOOF_IP = '203.0.113.9';
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A mocked resolver: PTR and A/AAAA tables; anything missing is ENOTFOUND. Counts calls. */
function fakeDns(
  ptr: Record<string, string[] | Error>,
  fwd: Record<string, string[] | Error> = {},
): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  const answer = async (table: Record<string, string[] | Error>, key: string) => {
    const v = table[key];
    if (v instanceof Error) throw v;
    if (!v) throw dnsError('ENOTFOUND');
    return v;
  };
  return {
    calls,
    reverse: (ip) => (calls.push(`reverse ${ip}`), answer(ptr, ip)),
    resolve4: (h) => (calls.push(`resolve4 ${h}`), answer(fwd, h)),
    resolve6: (h) => (calls.push(`resolve6 ${h}`), answer(fwd, h)),
  };
}

const googleDns = () =>
  fakeDns(
    { [GOOGLE_IP]: [GOOGLE_HOST], [SPOOF_IP]: ['host-9.residential.example.net'] },
    { [GOOGLE_HOST]: [GOOGLE_IP] },
  );

describe('verifyIp (reverse + forward-confirm)', () => {
  it('genuine Googlebot verifies', async () => {
    expect(await verifyIp(googleDns(), GOOGLE_IP, ['googlebot.com', 'google.com'])).toBe(
      'VERIFIED',
    );
  });

  it.each([
    ['PTR outside the allowed domains', { [SPOOF_IP]: ['x.residential.example.net'] }, {}],
    ['no PTR record', {}, {}],
    ['suffix trick: evilgooglebot.com', { [SPOOF_IP]: ['crawl.evilgooglebot.com'] }, {}],
    [
      'allowed-looking PTR that does not forward-confirm',
      { [SPOOF_IP]: ['fake.googlebot.com'] },
      { 'fake.googlebot.com': ['1.1.1.1'] },
    ],
    ['allowed-looking PTR with no A record', { [SPOOF_IP]: ['fake.googlebot.com'] }, {}],
  ])('fails: %s', async (_name, ptr, fwd) => {
    expect(await verifyIp(fakeDns(ptr, fwd), SPOOF_IP, ['googlebot.com'])).toBe('FAILED');
  });

  it('accepts a trailing dot and mixed case in the PTR', async () => {
    const dns = fakeDns(
      { [GOOGLE_IP]: ['Crawl.GoogleBot.com.'] },
      { 'Crawl.GoogleBot.com.': [GOOGLE_IP] },
    );
    expect(await verifyIp(dns, GOOGLE_IP, ['googlebot.com'])).toBe('VERIFIED');
  });

  it('IPv6 uses AAAA', async () => {
    const ip = '2001:4860:4801:1::1';
    const dns = fakeDns({ [ip]: ['crawl.googlebot.com'] }, { 'crawl.googlebot.com': [ip] });
    expect(await verifyIp(dns, ip, ['googlebot.com'])).toBe('VERIFIED');
    expect(dns.calls).toContain('resolve6 crawl.googlebot.com');
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED'])(
    'transient %s → RETRY, not FAILED',
    async (code) => {
      expect(
        await verifyIp(fakeDns({ [GOOGLE_IP]: dnsError(code) }), GOOGLE_IP, ['googlebot.com']),
      ).toBe('RETRY');
      const fwdErr = fakeDns({ [GOOGLE_IP]: [GOOGLE_HOST] }, { [GOOGLE_HOST]: dnsError(code) });
      expect(await verifyIp(fwdErr, GOOGLE_IP, ['googlebot.com'])).toBe('RETRY');
    },
  );

  it.each([
    ['Bingbot', 'msnbot-1.search.msn.com', ['search.msn.com']],
    ['Applebot', '17-58-1.applebot.apple.com', ['applebot.apple.com']],
    ['YandexBot', 'spider-1.yandex.com', ['yandex.ru', 'yandex.net', 'yandex.com']],
  ])('%s domains', async (_bot, host, domains) => {
    const dns = fakeDns({ [GOOGLE_IP]: [host] }, { [host]: [GOOGLE_IP] });
    expect(await verifyIp(dns, GOOGLE_IP, domains)).toBe('VERIFIED');
  });
});

describe('createSearchVerifier', () => {
  it('first check is PENDING and starts one lookup; later checks read the cache', async () => {
    const dns = googleDns();
    const v = createSearchVerifier({ resolver: dns });
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING');
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING'); // in flight: no second lookup
    expect(v.check(GOOGLE_IP, 'Googlebot')).toBe('PENDING');
    await v.idle();
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('FAILED');
    expect(v.check(GOOGLE_IP, 'Googlebot')).toBe('VERIFIED');
    expect(dns.calls.filter((c) => c.startsWith('reverse'))).toEqual([
      `reverse ${SPOOF_IP}`,
      `reverse ${GOOGLE_IP}`,
    ]);
  });

  it('check never awaits DNS: it returns synchronously while the resolver hangs', () => {
    const hang: DnsResolver = {
      reverse: () => new Promise(() => {}),
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
    };
    const v = createSearchVerifier({ resolver: hang });
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING');
  });

  it('verdicts expire after 24 h and are re-verified', async () => {
    let t = 0;
    const dns = googleDns();
    const v = createSearchVerifier({ resolver: dns, now: () => t });
    v.check(SPOOF_IP, 'Googlebot');
    await v.idle();
    t += 24 * 60 * 60 * 1000 - 1;
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('FAILED');
    t += 1;
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING');
    await v.idle();
    expect(dns.calls.filter((c) => c === `reverse ${SPOOF_IP}`)).toHaveLength(2);
  });

  it('a transient error keeps the IP passing and retries after retryMs', async () => {
    let t = 0;
    let fail = true;
    const dns = googleDns();
    const flaky: DnsResolver = {
      ...dns,
      reverse: (ip) => (fail ? Promise.reject(dnsError('ETIMEOUT')) : dns.reverse(ip)),
    };
    const v = createSearchVerifier({ resolver: flaky, now: () => t, retryMs: 1000 });
    v.check(SPOOF_IP, 'Googlebot');
    await v.idle();
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING');
    fail = false;
    t = 1000;
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING');
    await v.idle();
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('FAILED');
  });

  it('a throwing resolver never rejects out of the verifier', async () => {
    const boom: DnsResolver = {
      reverse: () => {
        throw new Error('sync boom');
      },
      resolve4: async () => [],
      resolve6: async () => [],
    };
    const v = createSearchVerifier({ resolver: boom });
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING');
    await v.idle();
    expect(v.check(SPOOF_IP, 'Googlebot')).toBe('PENDING'); // RETRY, not FAILED
  });

  it('the cache is a bounded LRU', async () => {
    const v = createSearchVerifier({ resolver: fakeDns({}), maxEntries: 3, maxConcurrent: 100 });
    for (const ip of ['1.1.1.1', '1.1.1.2', '1.1.1.3']) v.check(ip, 'Googlebot');
    await v.idle();
    expect(v.check('1.1.1.1', 'Googlebot')).toBe('FAILED'); // touch: now most recent
    v.check('1.1.1.4', 'Googlebot');
    await v.idle();
    expect(v.size).toBe(3);
    expect(v.check('1.1.1.1', 'Googlebot')).toBe('FAILED');
    expect(v.check('1.1.1.2', 'Googlebot')).toBe('PENDING'); // evicted, lookup restarted
  });

  it('bounded concurrency: beyond maxConcurrent an IP passes and is tried on a later hit', async () => {
    const dns = fakeDns({});
    const v = createSearchVerifier({ resolver: dns, maxConcurrent: 2 });
    for (const ip of ['1.1.1.1', '1.1.1.2', '1.1.1.3']) v.check(ip, 'Googlebot');
    expect(dns.calls).toHaveLength(2);
    await v.idle();
    expect(v.check('1.1.1.3', 'Googlebot')).toBe('PENDING');
    await v.idle();
    expect(v.check('1.1.1.3', 'Googlebot')).toBe('FAILED');
  });

  it('cached per bot and IP; non-SEARCH names and non-public IPs are never looked up', async () => {
    const dns = googleDns();
    const v = createSearchVerifier({ resolver: dns });
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '::1', 'fd00::1', '']) {
      expect(v.check(ip, 'Googlebot')).toBe('PENDING');
    }
    expect(v.check(GOOGLE_IP, 'GPTBot')).toBe('PENDING');
    expect(dns.calls).toEqual([]);
    v.check(`::ffff:${GOOGLE_IP}`, 'Googlebot');
    await v.idle();
    expect(v.check(GOOGLE_IP, 'Googlebot')).toBe('VERIFIED');
    expect(v.check(GOOGLE_IP, 'Bingbot')).toBe('PENDING'); // a separate (bot, IP) entry
  });

  it('ip helpers', () => {
    expect(normalizeIp('::ffff:66.249.66.1')).toBe('66.249.66.1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(isNonPublicIp('100.64.0.1')).toBe(true);
    expect(isNonPublicIp('169.254.1.1')).toBe(true);
    expect(isNonPublicIp('fe80::1')).toBe(true);
    expect(isNonPublicIp('not-an-ip')).toBe(true);
    expect(isNonPublicIp(GOOGLE_IP)).toBe(false);
    expect(isNonPublicIp('2001:4860::1')).toBe(false);
  });
});

describe('spigotGate with search verification', () => {
  let server: Server | undefined;
  let gate: SpigotGate | undefined;
  afterEach(async () => {
    gate?.stop();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    gate = undefined;
  });

  const quiet = { info: () => {}, warn: () => {} };

  async function start(resolver: DnsResolver, demo = false) {
    const hits: HitInput[] = [];
    const fetch: FetchLike = async (url) =>
      url.endsWith('/api/gate/policy')
        ? new Response(JSON.stringify(demoPolicyWire()), { status: 200 })
        : new Response(null, { status: 204 });
    gate = spigotGate({
      apiBase: 'https://spigot.test',
      gateKey: 'gk_test',
      fetch,
      logger: quiet,
      demo,
      policyIntervalMs: 3_600_000,
      flushIntervalMs: 3_600_000,
      verifySearch: { resolver },
    });
    await gate.refresher.refresh();
    const add = gate.flusher.add.bind(gate.flusher);
    gate.flusher.add = (h: HitInput) => (hits.push(h), add(h));
    const g = gate;
    // Express sets req.ip from the proxy header; this stub does the same from X-Test-Ip.
    server = createServer((req: IncomingMessage & { ip?: string }, res) => {
      req.ip = String(req.headers['x-test-ip']);
      g(req, res, () => res.end('page'));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const get = (ip: string, path = '/listings/x', extra: Record<string, string> = {}) =>
      globalThis.fetch(`${base}${path}`, {
        headers: { 'user-agent': GOOGLEBOT_UA, 'x-test-ip': ip, ...extra },
      });
    return { get, hits };
  }

  it('spoofed Googlebot passes first, then gets 402 once verification fails', async () => {
    const { get, hits } = await start(googleDns());
    expect((await get(SPOOF_IP)).status).toBe(200);
    await gate!.verifier!.idle();
    const res = await get(SPOOF_IP);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: expect.anything() });
    expect(hits.at(-1)).toMatchObject({
      category: 'SCRAPER_TOOL',
      botName: 'Googlebot (unverified)',
      decision: 'QUOTE_402',
    });
    // Ungated paths still pass for the reclassified IP; browsers from that IP are untouched.
    expect((await get(SPOOF_IP, '/robots.txt')).status).toBe(200);
    expect(
      (await get(SPOOF_IP, '/listings/x', { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605' }))
        .status,
    ).toBe(200);
  });

  it('genuine Googlebot (mocked resolver) stays PASS', async () => {
    const { get, hits } = await start(googleDns());
    expect((await get(GOOGLE_IP)).status).toBe(200);
    await gate!.verifier!.idle();
    expect((await get(GOOGLE_IP)).status).toBe(200);
    expect((await get(`::ffff:${GOOGLE_IP}`)).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(hits.every((h) => h.category === 'SEARCH' && h.botName === 'Googlebot')).toBe(true);
  });

  it('SIM-flagged demo traffic is never verified', async () => {
    const dns = googleDns();
    const { get } = await start(dns, true);
    expect((await get(SPOOF_IP, '/listings/x', { 'x-spigot-sim': '1' })).status).toBe(200);
    await gate!.verifier!.idle();
    expect((await get(SPOOF_IP, '/listings/x', { 'x-spigot-sim': '1' })).status).toBe(200);
    expect(dns.calls).toEqual([]);
  });

  it('a hung resolver never delays the response', async () => {
    const hang: DnsResolver = {
      reverse: () => new Promise(() => {}),
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
    };
    const { get } = await start(hang);
    const t0 = performance.now();
    expect((await get(SPOOF_IP)).status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('verifySearch: false disables it', () => {
    gate = spigotGate({
      apiBase: 'https://spigot.test',
      gateKey: 'gk_test',
      fetch: async () => new Response(null, { status: 503 }),
      logger: quiet,
      verifySearch: false,
    });
    expect(gate.verifier).toBeNull();
  });
});

describe('bench with the verifier on the path (SP-051: bench unchanged)', () => {
  it('classify + verifier.check over 10k mixed requests: p50 < 1 ms', async () => {
    const policy = benchPolicy();
    const v = createSearchVerifier({ resolver: fakeDns({}), maxConcurrent: 1_000_000 });
    const inputs = benchInputs(10_000).map((i) => ({
      ...i,
      ip: `66.249.${i.ip.split('.')[2]}.${i.ip.split('.')[3]}`,
    }));
    const step = (i: (typeof inputs)[number]) => {
      const r = classify(i, policy);
      if (r.category === 'SEARCH') v.check(i.ip, r.botName);
    };
    for (const i of inputs) step(i); // warm up, and fill the cache
    await v.idle();
    const times = new Float64Array(inputs.length);
    inputs.forEach((i, n) => {
      const t0 = performance.now();
      step(i);
      times[n] = performance.now() - t0;
    });
    times.sort();
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(1);
  });
});
