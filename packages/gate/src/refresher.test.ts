import { afterEach, describe, expect, it } from 'vitest';
import { demoPolicyWire } from './fixtures.test-helpers.js';
import { startPolicyRefresher, type FetchLike, type PolicyRefresher } from './refresher.js';

let refresher: PolicyRefresher | undefined;
afterEach(() => refresher?.stop());

function logs() {
  const lines: string[] = [];
  return {
    lines,
    logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) },
  };
}

function make(fetch: FetchLike, logger = logs().logger, intervalMs = 3_600_000) {
  refresher = startPolicyRefresher({
    apiBase: 'https://spigot.test',
    gateKey: 'gk_secret_value',
    fetch,
    logger,
    intervalMs,
  });
  return refresher;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('startPolicyRefresher', () => {
  it('loads the policy at boot with the gate key as a Bearer token and prebuilds the 402', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const r = make(async (url, init) => {
      seen.push({ url, init });
      return json(demoPolicyWire());
    });
    await r.refresh();
    expect(seen[0]!.url).toBe('https://spigot.test/api/gate/policy');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer gk_secret_value',
    );
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(r.current!.policy.policyVersion).toBe(3);
    expect(JSON.parse(r.current!.jsonBytes.toString()).error.code).toBe('PAYMENT_REQUIRED');
    expect(r.current!.htmlBytes.toString()).toContain('402 Payment Required');
  });

  it('keeps the last good policy on 500, network errors and malformed bodies', async () => {
    let mode: 'ok' | '500' | 'down' | 'bad' = 'ok';
    const r = make(async () => {
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === '500') return json({ error: 'x' }, 500);
      if (mode === 'bad') return json({ siteId: 'x' });
      return json(demoPolicyWire());
    });
    expect(await r.refresh()).toBe(true);
    for (const m of ['500', 'down', 'bad'] as const) {
      mode = m;
      expect(await r.refresh()).toBe(false);
      expect(r.current!.policy.policyVersion).toBe(3);
    }
    mode = 'ok';
    expect(await r.refresh()).toBe(true);
  });

  it('never loaded → current is null, logged once, and the key is never logged', async () => {
    const { lines, logger } = logs();
    const r = make(async () => {
      throw new TypeError('fetch failed');
    }, logger);
    await r.refresh();
    await r.refresh();
    await r.refresh();
    expect(r.current).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/passing every request/);
    expect(lines.join('\n')).not.toContain('gk_secret_value');
  });

  it('times out a slow API after timeoutMs', async () => {
    refresher = startPolicyRefresher({
      apiBase: 'https://spigot.test',
      gateKey: 'gk',
      timeoutMs: 50,
      logger: logs().logger,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });
    const t = Date.now();
    expect(await refresher.refresh()).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('picks up a policy change on the next interval', async () => {
    let version = 3;
    const r = make(async () => json(demoPolicyWire({ policyVersion: version })), logs().logger, 20);
    await r.refresh();
    version = 4;
    await expect.poll(() => r.current?.policy.policyVersion, { timeout: 2000 }).toBe(4);
  });
});
