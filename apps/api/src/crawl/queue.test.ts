import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crawlKeyHash, deriveCrawlKey } from './crawlKey.js';
import { crawlerUserAgent, minGapFor } from './deps.js';
import { parseRetryAfter } from './fetchPage.js';
import { HostQueue, hostQueueFor, resetHostQueues } from './queue.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('HostQueue', () => {
  it('never runs more than 2 at once, even when asked for more', async () => {
    const q = new HostQueue('h', { minGapMs: 0, concurrency: 5 });
    let now = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        q.run(async () => {
          max = Math.max(max, ++now);
          await tick(3);
          now--;
        }),
      ),
    );
    expect(max).toBe(2);
    expect(q.stats()).toMatchObject({ maxActive: 2, started: 20, active: 0 });
  });

  describe('on a fake clock', () => {
    const T0 = 1_000_000;
    beforeEach(() => void vi.useFakeTimers({ now: T0 }));
    afterEach(() => void vi.useRealTimers());

    it('spaces request starts exactly minGapMs apart', async () => {
      const q = new HostQueue('h', { minGapMs: 15 });
      const starts: number[] = [];
      const all = Promise.all(
        Array.from({ length: 6 }, () => q.run(async () => void starts.push(Date.now() - T0))),
      );
      await vi.runAllTimersAsync();
      await all;
      expect(starts).toEqual([0, 15, 30, 45, 60, 75]);
    });

    it('backoffUntil holds every start for the host', async () => {
      const q = new HostQueue('h', { minGapMs: 0 });
      q.backoffUntil(T0 + 40);
      q.backoffUntil(T0 + 5); // never shortens the hold
      let started = 0;
      const done = q.run(async () => void (started = Date.now() - T0));
      await vi.advanceTimersByTimeAsync(39);
      expect(started).toBe(0);
      expect(q.stats().started).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(started).toBe(40);
    });

    it('a back-off that arrives mid-wait pushes the waiting start out', async () => {
      const q = new HostQueue('h', { minGapMs: 20 });
      const starts: number[] = [];
      const all = Promise.all(
        [0, 1].map(() => q.run(async () => void starts.push(Date.now() - T0))),
      );
      await vi.advanceTimersByTimeAsync(10);
      q.backoffUntil(T0 + 50);
      await vi.runAllTimersAsync();
      await all;
      expect(starts).toEqual([0, 50]);
    });
  });

  it('hostQueueFor shares one queue per host and updates its gap', () => {
    resetHostQueues();
    const a = hostQueueFor('Example.test:4100', { minGapMs: 250 });
    const b = hostQueueFor('example.test:4100', { minGapMs: 25 });
    expect(a).toBe(b);
    expect(a.minGapMs).toBe(25);
    expect(hostQueueFor('other.test', { minGapMs: 1 })).not.toBe(a);
    resetHostQueues();
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  it('reads seconds and HTTP dates, caps at 10 minutes, defaults when absent or bad', () => {
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('7', now)).toBe(7_000);
    expect(parseRetryAfter('3600', now)).toBe(600_000);
    expect(parseRetryAfter('Thu, 12 Nov 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Thu, 12 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(undefined, now)).toBe(5_000);
    expect(parseRetryAfter('soon', now)).toBe(5_000);
  });
});

describe('minGapFor', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  it('250 ms by default, 25 ms behind a gate seen in the last 10 minutes, explicit config wins', () => {
    expect(minGapFor({}, null, now)).toBe(250);
    expect(minGapFor({}, new Date(now - 9 * 60_000), now)).toBe(25);
    expect(minGapFor({}, new Date(now - 11 * 60_000), now)).toBe(250);
    expect(minGapFor({ minGapMs: 100 }, new Date(now), now)).toBe(100);
    expect(minGapFor({ minGapMs: 0 }, null, now)).toBe(0);
  });
});

describe('crawl key and user agent', () => {
  it('derives a stable ck_ key per site and secret; the hash is what sites store', () => {
    const secret = 's'.repeat(32);
    const k = deriveCrawlKey('site-1', secret);
    expect(k).toMatch(/^ck_[A-Za-z0-9_-]{43}$/);
    expect(deriveCrawlKey('site-1', secret)).toBe(k);
    expect(deriveCrawlKey('site-2', secret)).not.toBe(k);
    expect(deriveCrawlKey('site-1', 't'.repeat(32))).not.toBe(k);
    expect(crawlKeyHash(k)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds the crawler UA from APP_BASE_URL', () => {
    expect(crawlerUserAgent('https://spigot.example/')).toBe(
      'SpigotCrawler/1.0 (+https://spigot.example/crawler)',
    );
  });
});
