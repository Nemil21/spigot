import { gateHitsSchema } from '@spigot/shared/gate';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_HIT_KEYS, minuteBucket, startHitFlusher, type HitFlusher } from './flusher.js';
import type { FetchLike, GateLogger } from './refresher.js';

const quiet: GateLogger = { info: () => {}, warn: () => {} };
const T0 = Date.parse('2026-11-11T17:42:31.250Z');

interface Call {
  url: string;
  init: RequestInit;
  body: unknown;
}

function recorder(status: number | (() => number) = 204) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const s = typeof status === 'function' ? status() : status;
    return new Response(null, { status: s });
  };
  return { calls, fetch };
}

let flusher: HitFlusher | undefined;
afterEach(() => flusher?.stop());

function make(fetch: FetchLike, over: Partial<Parameters<typeof startHitFlusher>[0]> = {}) {
  flusher = startHitFlusher({
    apiBase: 'https://spigot.test/',
    gateKey: 'gk_test',
    fetch,
    logger: quiet,
    now: () => T0,
    intervalMs: 3_600_000,
    ...over,
  });
  return flusher;
}

describe('minuteBucket', () => {
  it('floors to the UTC minute without milliseconds', () => {
    expect(minuteBucket(T0)).toBe('2026-11-11T17:42:00Z');
  });
});

describe('startHitFlusher', () => {
  it('aggregates by (minute, category, botName, decision, isSimulated) and posts a schema-valid payload', async () => {
    const { calls, fetch } = recorder();
    const f = make(fetch);
    f.add({
      category: 'AI_TRAINING',
      botName: 'GPTBot',
      decision: 'QUOTE_402',
      bytes: 900,
      isSimulated: false,
    });
    f.add({
      category: 'AI_TRAINING',
      botName: 'GPTBot',
      decision: 'QUOTE_402',
      bytes: 900,
      isSimulated: false,
    });
    f.add({
      category: 'AI_TRAINING',
      botName: 'GPTBot',
      decision: 'QUOTE_402',
      bytes: 900,
      isSimulated: true,
    });
    f.add({ category: 'HUMAN', botName: '-', decision: 'PASS', bytes: 5000, isSimulated: false });
    f.add({
      category: 'HUMAN',
      botName: '-',
      decision: 'PASS',
      bytes: 5000,
      isSimulated: false,
      at: T0 + 60_000,
    });
    f.add({
      category: 'UNKNOWN',
      botName: 'SpigotCrawler',
      decision: 'SPIGOT_CRAWLER',
      bytes: 10,
      isSimulated: false,
    });
    f.add({
      category: 'UNKNOWN',
      botName: 'unclassified',
      decision: 'FAIL_OPEN',
      bytes: 0,
      isSimulated: false,
    });
    expect(f.size).toBe(6);

    await f.flush();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://spigot.test/api/gate/hits');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer gk_test');

    const payload = gateHitsSchema.parse(call.body);
    expect(payload.buckets).toContainEqual({
      bucket: '2026-11-11T17:42:00Z',
      category: 'AI_TRAINING',
      botName: 'GPTBot',
      decision: 'QUOTE_402',
      hits: 2,
      bytes: 1800,
      isSimulated: false,
    });
    expect(payload.buckets).toContainEqual(
      expect.objectContaining({ botName: 'GPTBot', hits: 1, isSimulated: true }),
    );
    expect(payload.buckets.filter((b) => b.category === 'HUMAN').map((b) => b.bucket)).toEqual([
      '2026-11-11T17:42:00Z',
      '2026-11-11T17:43:00Z',
    ]);
    expect(payload.buckets).toContainEqual(
      expect.objectContaining({ decision: 'SPIGOT_CRAWLER', botName: 'SpigotCrawler' }),
    );
    // Humans are one aggregate row: nothing in the payload identifies a person or a page.
    expect(JSON.stringify(payload)).not.toMatch(/listings|127\.0\.0\.1|ip|path/i);

    expect(f.size).toBe(0);
    await f.flush();
    expect(calls).toHaveLength(1); // nothing new → no POST
  });

  it('stays bounded at 10k keys with 50k distinct bot names', async () => {
    const { calls, fetch } = recorder();
    const f = make(fetch);
    for (let i = 0; i < 50_000; i++) {
      f.add({
        category: 'UNKNOWN',
        botName: `bot-${i}`,
        decision: 'PASS',
        bytes: 1,
        isSimulated: false,
      });
    }
    expect(f.size).toBe(MAX_HIT_KEYS);
    expect(f.droppedHits).toBe(40_000);
    // Existing keys still count after the cap.
    f.add({
      category: 'UNKNOWN',
      botName: 'bot-0',
      decision: 'PASS',
      bytes: 1,
      isSimulated: false,
    });
    await f.flush();
    const payload = gateHitsSchema.parse(calls[0]!.body);
    expect(payload.buckets).toHaveLength(MAX_HIT_KEYS);
    expect(payload.buckets.find((b) => b.botName === 'bot-0')!.hits).toBe(2);
  });

  it('retries a failed batch, then drops it after 3 tries', async () => {
    const { calls, fetch } = recorder(500);
    const f = make(fetch);
    f.add({ category: 'HUMAN', botName: '-', decision: 'PASS', bytes: 1, isSimulated: false });
    await f.flush();
    await f.flush();
    // New hits arrive while the batch is being retried; they wait for the next tick.
    f.add({
      category: 'SEARCH',
      botName: 'Googlebot',
      decision: 'PASS',
      bytes: 1,
      isSimulated: false,
    });
    expect(f.size).toBe(2);
    await f.flush();
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => (c.body as { buckets: unknown[] }).buckets.length === 1)).toBe(true);
    expect(f.size).toBe(1); // dropped the human batch; Googlebot still live
    await f.flush();
    expect((calls[3]!.body as { buckets: { botName: string }[] }).buckets[0]!.botName).toBe(
      'Googlebot',
    );
  });

  it('a network error or timeout counts as a failed try and never rejects', async () => {
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      throw new DOMException('timed out', 'TimeoutError');
    };
    const f = make(fetch, { maxTries: 2 });
    f.add({ category: 'HUMAN', botName: '-', decision: 'PASS', bytes: 1, isSimulated: false });
    await expect(f.flush()).resolves.toBeUndefined();
    await f.flush();
    expect(n).toBe(2);
    expect(f.size).toBe(0);
  });

  it('a successful retry clears the batch', async () => {
    let status = 503;
    const { calls, fetch } = recorder(() => status);
    const f = make(fetch);
    f.add({ category: 'HUMAN', botName: '-', decision: 'PASS', bytes: 1, isSimulated: false });
    await f.flush();
    status = 204;
    await f.flush();
    expect(calls).toHaveLength(2);
    expect(f.size).toBe(0);
  });

  it('concurrent flushes share one POST', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const fetch: FetchLike = async () => {
      n++;
      await gate;
      return new Response(null, { status: 204 });
    };
    const f = make(fetch);
    f.add({ category: 'HUMAN', botName: '-', decision: 'PASS', bytes: 1, isSimulated: false });
    const a = f.flush();
    const b = f.flush();
    release();
    await Promise.all([a, b]);
    expect(n).toBe(1);
  });

  it('flushes on its own interval', async () => {
    const { calls, fetch } = recorder();
    const f = make(fetch, { intervalMs: 20 });
    f.add({ category: 'HUMAN', botName: '-', decision: 'PASS', bytes: 1, isSimulated: false });
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
  });
});
