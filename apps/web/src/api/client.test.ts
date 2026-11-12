import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './client';
import { fixtureCandidates, fixtureKey, fixtureMapFromGlob } from './fixtures';

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('api client', () => {
  it('sends same-origin JSON requests with cookies', async () => {
    const fetch = vi.fn<FetchLike>(async () => json(200, { ok: true }));
    const api = createApiClient({ fetch, fixtures: false });
    await expect(
      api.post('/api/buyer/topups', { amountCents: 2000 }, { idempotencyKey: 'k1' }),
    ).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/buyer/topups');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe('{"amountCents":2000}');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'k1',
    });
  });

  it('refuses cross-origin and relative paths', async () => {
    const api = createApiClient({ fetch: vi.fn(), fixtures: false });
    await expect(api.get('https://evil.example/api')).rejects.toThrow(/same-origin/);
    await expect(api.get('//evil.example/api')).rejects.toThrow(/same-origin/);
    await expect(api.get('api/x')).rejects.toThrow(/same-origin/);
  });

  it('throws the error envelope as ApiError', async () => {
    const body = {
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Top up', details: { needMicros: 5 } },
      quote: { totalMicros: 5 },
    };
    const api = createApiClient({ fetch: async () => json(402, body), fixtures: false });
    const err = await api.get('/v1/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 402,
      code: 'INSUFFICIENT_BALANCE',
      message: 'Top up',
      details: { needMicros: 5 },
      body,
      retryable: false,
    });
  });

  it('maps non-envelope and unknown-code failures to HTTP_<status>', async () => {
    const api = createApiClient({
      fetch: async () =>
        new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      fixtures: false,
    });
    await expect(api.get('/api/x')).rejects.toMatchObject({ code: 'HTTP_502', retryable: true });
    const api2 = createApiClient({
      fetch: async () => json(418, { error: { code: 'TEAPOT', message: 'no' } }),
      fixtures: false,
    });
    await expect(api2.get('/api/x')).rejects.toMatchObject({ code: 'HTTP_418', message: 'no' });
  });

  it('maps a network failure to NETWORK_ERROR, but rethrows aborts', async () => {
    const api = createApiClient({
      fetch: async () => Promise.reject(new TypeError('x')),
      fixtures: false,
    });
    await expect(api.get('/api/x')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      retryable: true,
    });
    const abort = createApiClient({
      fetch: async () => Promise.reject(new DOMException('aborted', 'AbortError')),
      fixtures: false,
    });
    await expect(abort.get('/api/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('handles 204 No Content', async () => {
    const api = createApiClient({
      fetch: async () => new Response(null, { status: 204 }),
      fixtures: false,
    });
    await expect(api.delete('/api/buyer/keys/k1')).resolves.toBeUndefined();
  });
});

describe('fixture mode', () => {
  const fixtures = fixtureMapFromGlob({
    '../fixtures/api/publishers/me/earnings.json': async () => ({ totals: { grossMicros: 1 } }),
    '../fixtures/api/sites/_/bots.json': async () => ({ rows: ['any'] }),
    '../fixtures/api/sites/s1/bots.json': async () => ({ rows: ['s1'] }),
  });

  it('serves GETs from a matching file, ignoring the query', async () => {
    const fetch = vi.fn<FetchLike>();
    const api = createApiClient({ fetch, fixtures });
    await expect(api.get('/api/publishers/me/earnings?range=7d')).resolves.toEqual({
      totals: { grossMicros: 1 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers the exact file, then `_` wildcards', async () => {
    const api = createApiClient({ fetch: vi.fn(), fixtures });
    await expect(api.get('/api/sites/s1/bots')).resolves.toEqual({ rows: ['s1'] });
    await expect(api.get('/api/sites/s9/bots')).resolves.toEqual({ rows: ['any'] });
  });

  it('returns a copy, so a screen mutating it does not change the fixture', async () => {
    const api = createApiClient({ fetch: vi.fn(), fixtures });
    const a = await api.get<{ rows: string[] }>('/api/sites/s1/bots');
    a.rows.push('x');
    await expect(api.get('/api/sites/s1/bots')).resolves.toEqual({ rows: ['s1'] });
  });

  it('falls through to the network when no file matches, and for mutations', async () => {
    const fetch = vi.fn<FetchLike>(async () => json(200, { live: true }));
    const api = createApiClient({ fetch, fixtures });
    await expect(api.get('/api/publishers/me/payouts')).resolves.toEqual({ live: true });
    await expect(api.post('/api/sites/s1/bots', {})).resolves.toEqual({ live: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('builds keys and candidates', () => {
    expect(fixtureKey('/api/a/b/?x=1')).toBe('api/a/b');
    expect(fixtureCandidates('/api/sites/s1')).toEqual([
      'api/sites/s1',
      'api/sites/_',
      'api/_/s1',
      '_/sites/s1',
      'api/_/_',
      '_/sites/_',
      '_/_/s1',
      '_/_/_',
    ]);
    expect(fixtureCandidates('/')).toEqual([]);
  });
});
