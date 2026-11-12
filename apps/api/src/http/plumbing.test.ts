import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signSession, verifySession } from '../auth/sessions.js';
import { loadConfig } from '../config.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { RATE_LIMITS, RateLimiter } from './rateLimit.js';
import { redactString, redactValue } from './redact.js';

const SECRET = REQUIRED_ENV.SESSION_SECRET!;
const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

describe('sessions', () => {
  it('round-trips, and refuses tampering, the other role and expiry', () => {
    const now = 1_000_000;
    const t = signSession(SECRET, 'publisher', 'p-1', now);
    expect(verifySession(SECRET, 'publisher', t, now)?.sub).toBe('p-1');
    expect(verifySession(SECRET, 'buyer', t, now)).toBeNull();
    expect(verifySession('y'.repeat(32), 'publisher', t, now)).toBeNull();
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'p-2', exp: now + 1e9, jti: 'x' })).toString(
      'base64url',
    );
    expect(verifySession(SECRET, 'publisher', `${forged}.${sig}`, now)).toBeNull();
    expect(verifySession(SECRET, 'publisher', `${body}.`, now)).toBeNull();
    expect(verifySession(SECRET, 'publisher', t, now + 12 * 3600_000)).toBeNull();
    expect(verifySession(SECRET, 'publisher', t, now + 12 * 3600_000 - 1)).not.toBeNull();
    const b = signSession(SECRET, 'buyer', 'b-1', now);
    expect(verifySession(SECRET, 'buyer', b, now + 29 * 86400_000)?.sub).toBe('b-1');
    expect(verifySession(SECRET, 'buyer', b, now + 30 * 86400_000)).toBeNull();
  });
});

describe('RateLimiter (token bucket)', () => {
  it('allows the capacity, refuses the next with Retry-After, refills over time', () => {
    let t = 0;
    const rl = new RateLimiter(RATE_LIMITS, () => t);
    for (let i = 0; i < 120; i++) expect(rl.take('portal', 'u').allowed).toBe(true);
    const refused = rl.take('portal', 'u');
    expect(refused).toMatchObject({ allowed: false, remaining: 0, limit: 120 });
    expect(refused.retryAfterSec).toBe(1);
    // Other keys and buckets are independent.
    expect(rl.take('portal', 'v').allowed).toBe(true);
    t += 500; // one token every 500 ms at 120/min
    expect(rl.take('portal', 'u').allowed).toBe(true);
    expect(rl.take('portal', 'u').allowed).toBe(false);
  });

  it('1 per 5 s per site for gate hits', () => {
    let t = 0;
    const rl = new RateLimiter(RATE_LIMITS, () => t);
    expect(rl.take('gateHits', 's').allowed).toBe(true);
    const d = rl.take('gateHits', 's');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(5);
    t += 4_999;
    expect(rl.take('gateHits', 's').allowed).toBe(false);
    t += 1;
    expect(rl.take('gateHits', 's').allowed).toBe(true);
  });

  it('a per-key perMin override replaces the capacity', () => {
    const rl = new RateLimiter(RATE_LIMITS, () => 0);
    for (let i = 0; i < 5; i++) expect(rl.take('rest', 'k', 5).allowed).toBe(true);
    expect(rl.take('rest', 'k', 5).allowed).toBe(false);
  });
});

describe('redaction', () => {
  const KEY = 'sk_spg_FAKEfake0123456789abcdefABCDEF';
  it('strips keys, emails and PayPal tokens from strings', () => {
    const s = redactString(
      `GET /v1/x?key=${KEY}&email=a.b%40example.com Bearer ${KEY} gk_abc123def ck_zz99yy88 ` +
        `EC-5Y6569149D2357259 A21AAFakeAccessToken123 jo@example.com token=abc pasted ${KEY}`,
    );
    for (const secret of [
      KEY,
      'a.b%40example.com',
      'gk_abc123def',
      'ck_zz99yy88',
      'EC-5Y6569149D2357259',
      'A21AAFakeAccessToken123',
      'jo@example.com',
      'token=abc',
    ]) {
      expect(s).not.toContain(secret);
    }
    expect(s).toContain('sk_spg_[redacted]');
  });

  it('redacts secret-named keys and nested values', () => {
    expect(
      redactValue({ email: 'x@y.io', nested: { note: `key ${KEY}`, apiKey: 'abc' }, n: 1 }),
    ).toEqual({
      email: '[redacted]',
      nested: { note: 'key sk_spg_[redacted]', apiKey: '[redacted]' },
      n: 1,
    });
  });
});

describe('CSRF and the publisher rate limit (no DB)', () => {
  async function app() {
    const a = await buildServer(loadConfig({ ...REQUIRED_ENV }), { logger: false });
    a.post('/api/test/mutate', async () => ({ ok: true }));
    a.post('/api/test/open', { config: { csrf: false } }, async () => ({ ok: true }));
    a.get('/api/test/read', async () => ({ ok: true }));
    return a;
  }

  it('mutating /api routes need a same-origin Origin', async () => {
    const a = await app();
    try {
      const post = (headers: Record<string, string>) =>
        a.inject({ method: 'POST', url: '/api/test/mutate', headers, payload: {} });
      expect((await post({})).statusCode).toBe(403);
      expect((await post({})).json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect((await post({ origin: 'https://evil.example' })).statusCode).toBe(403);
      expect((await post({ origin: 'null' })).statusCode).toBe(403);
      expect((await post({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
      expect((await post({ origin: ORIGIN })).statusCode).toBe(200);
      // Bearer clients (gate, API keys) and opted-out routes skip the check; GETs are never checked.
      expect((await post({ authorization: 'Bearer gk_x' })).statusCode).toBe(200);
      expect(
        (await a.inject({ method: 'POST', url: '/api/test/open', payload: {} })).statusCode,
      ).toBe(200);
      expect((await a.inject({ method: 'GET', url: '/api/test/read' })).statusCode).toBe(200);
    } finally {
      await a.close();
    }
  });

  it('121st request in a minute from one publisher → 429 with Retry-After', async () => {
    const a = await app();
    try {
      const cookie = `${SESSION_COOKIE.publisher}=${signSession(SECRET, 'publisher', randomUUID())}`;
      for (let i = 0; i < 120; i++) {
        const res = await a.inject({ method: 'GET', url: '/api/test/read', headers: { cookie } });
        expect(res.statusCode).toBe(200);
      }
      const res = await a.inject({ method: 'GET', url: '/api/test/read', headers: { cookie } });
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      // Another publisher is unaffected; anonymous traffic isn't keyed by this limit.
      const other = `${SESSION_COOKIE.publisher}=${signSession(SECRET, 'publisher', randomUUID())}`;
      expect(
        (await a.inject({ method: 'GET', url: '/api/test/read', headers: { cookie: other } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await a.close();
    }
  });
});
