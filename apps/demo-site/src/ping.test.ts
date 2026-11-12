import { describe, expect, it, vi } from 'vitest';
import { MAX_PING_URLS, PingError, pingConfigFromEnv, pingSpigot, pingUrls } from './ping.js';

const config = { apiBase: 'http://spigot.test', siteId: 'site-1', crawlKey: 'ck_secret' };

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('demo:mutate --ping (SP-055)', () => {
  it('builds absolute, deduped URLs on the site origin from the touched paths', () => {
    expect(pingUrls('http://127.0.0.1:4100/', ['/listings/a', '/agents/b', '/listings/a'])).toEqual(
      ['http://127.0.0.1:4100/listings/a', 'http://127.0.0.1:4100/agents/b'],
    );
  });

  it('names every missing env key, never a value', () => {
    expect(() => pingConfigFromEnv({ SPIGOT_API_BASE: 'http://x' })).toThrow(
      '--ping needs SPIGOT_SITE_ID, SPIGOT_CRAWL_KEY',
    );
    expect(
      pingConfigFromEnv({
        SPIGOT_API_BASE: ' http://x ',
        SPIGOT_SITE_ID: 's',
        SPIGOT_CRAWL_KEY: 'ck_k',
      }),
    ).toEqual({ apiBase: 'http://x', siteId: 's', crawlKey: 'ck_k' });
  });

  it('POSTs the URLs with the crawl key as Bearer and returns the run', async () => {
    const f = answer(202, { crawlRunId: 'r1', workflowRunId: 'inproc:r1', joined: false, urls: 2 });
    const res = await pingSpigot(config, ['http://o/a', 'http://o/b'], f);
    expect(res).toEqual({ crawlRunId: 'r1', workflowRunId: 'inproc:r1', joined: false, urls: 2 });
    const [url, init] = f.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('http://spigot.test/api/sites/site-1/ping');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ck_secret');
    expect(JSON.parse(init.body as string)).toEqual({ urls: ['http://o/a', 'http://o/b'] });
  });

  it("surfaces Spigot's error without the key", async () => {
    const f = answer(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
    const err = await pingSpigot(config, ['http://o/a'], f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PingError);
    expect((err as PingError).status).toBe(429);
    expect((err as PingError).message).toContain('429 RATE_LIMITED Too many requests.');
    expect((err as PingError).message).not.toContain('ck_secret');
  });

  it('refuses over 500 URLs (or none) without calling Spigot', async () => {
    const f = answer(202, {});
    const many = Array.from({ length: MAX_PING_URLS + 1 }, (_, i) => `http://o/${i}`);
    await expect(pingSpigot(config, many, f)).rejects.toThrow('run a crawl instead');
    await expect(pingSpigot(config, [], f)).rejects.toThrow('nothing to ping');
    expect(f).not.toHaveBeenCalled();
  });
});
