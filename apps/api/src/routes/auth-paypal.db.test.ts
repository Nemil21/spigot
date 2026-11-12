import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import {
  LIPP_COOKIE,
  setPayPalIdentity,
  StubPayPalIdentity,
  type PayPalLoginIdentity,
} from '../auth/paypalOidc.js';
import { SESSION_COOKIE } from '../auth/sessions.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-058 Log in with PayPal end to end against Postgres, with a stubbed OIDC provider standing in
 * for PayPal (codes are one-time, the id_token carries the nonce): create, sign in again, link a
 * password account, the refusals (state, cancel, unverified, taken, link-required) and races.
 */
const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

function cookieValues(res: request.Response): Record<string, string> {
  const set = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const out: Record<string, string> = {};
  for (const c of set) {
    const [pair] = c.split(';', 1);
    const eq = pair!.indexOf('=');
    out[pair!.slice(0, eq)] = pair!.slice(eq + 1);
  }
  return out;
}

let seq = 0;
function identity(extra: Partial<PayPalLoginIdentity> = {}): PayPalLoginIdentity {
  const n = `${Date.now().toString(36)}${++seq}`;
  return {
    email: `pp-${n}@example.com`,
    emailVerified: true,
    payerId: `PAYER${n.toUpperCase()}`,
    name: `PayPal ${n}`,
    ...extra,
  };
}

describe.skipIf(!testDatabaseUrl)('SP-058 Log in with PayPal (Postgres + stub OIDC)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let stub: StubPayPalIdentity;
  let logs = '';

  beforeAll(async () => {
    db = await createTestDatabase();
    const logStream = new PassThrough();
    logStream.on('data', (chunk: Buffer) => (logs += chunk.toString()));
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logStream },
    );
    await app.ready();
  });
  afterAll(async () => {
    setPayPalIdentity(undefined);
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    app.rateLimiter.reset();
    stub = new StubPayPalIdentity({ clientId: REQUIRED_ENV.PAYPAL_CLIENT_ID });
    setPayPalIdentity(stub);
  });

  const agent = () => request(app.server);

  /**
   * `/start` as `session` (a publisher cookie) or anonymous: the stub's callback URL + state
   * cookie. With a session it is W16's Connect (`?intent=connect`) unless `intent` says otherwise.
   */
  async function start(session?: string, intent: 'connect' | null = session ? 'connect' : null) {
    const req = agent().get(`/api/auth/paypal/start${intent ? `?intent=${intent}` : ''}`);
    if (session) req.set('Cookie', session);
    const res = await req;
    expect(res.status).toBe(302);
    const location = new URL(String(res.headers.location));
    const lipp = cookieValues(res)[LIPP_COOKIE]!;
    expect(lipp).toBeTruthy();
    expect(res.headers['set-cookie']!.toString()).toMatch(/HttpOnly/i);
    return { location, lipp };
  }

  /** Follow the stub's redirect back into `/callback` with the state cookie (and a session). */
  async function callback(
    s: { location: URL; lipp: string },
    opts: { session?: string; query?: string } = {},
  ) {
    const cookies = [`${LIPP_COOKIE}=${s.lipp}`, opts.session].filter(Boolean).join('; ');
    const path = opts.query ?? `${s.location.pathname}${s.location.search}`;
    const res = await agent().get(path).set('Cookie', cookies);
    expect(res.status).toBe(302);
    const session = cookieValues(res)[SESSION_COOKIE.publisher];
    return {
      res,
      to: String(res.headers.location),
      session: session ? `${SESSION_COOKIE.publisher}=${session}` : undefined,
    };
  }

  async function loginWithPayPal(id: PayPalLoginIdentity, session?: string) {
    stub.identity = id;
    return callback(await start(session), { session });
  }

  async function rowsFor(email: string) {
    const { rows } = await app.db.pool.query(
      `SELECT id, email, payout_email, paypal_payer_id, password_hash FROM publishers
        WHERE lower(email) = $1 OR payout_email = $1`,
      [email],
    );
    return rows;
  }

  async function passwordSignup() {
    const email = `pw-${randomUUID()}@example.com`;
    const res = await agent()
      .post('/api/auth/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Pw', email, password: 'correct horse', payoutEmail: `old-${email}` });
    expect(res.status).toBe(201);
    const c = cookieValues(res)[SESSION_COOKIE.publisher]!;
    return {
      email,
      id: res.body.publisherId as string,
      session: `${SESSION_COOKIE.publisher}=${c}`,
    };
  }

  const me = (session: string) => agent().get('/api/auth/me').set('Cookie', session);

  it('a new PayPal identity creates a publisher with the PayPal email as payout email', async () => {
    const id = identity();
    const { to, session } = await loginWithPayPal(id);
    expect(to).toBe('/app/connect');
    expect(session).toBeTruthy();
    const rows = await rowsFor(id.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: id.email,
      payout_email: id.email,
      paypal_payer_id: id.payerId,
      password_hash: null,
    });
    const who = await me(session!);
    expect(who.body.publisher).toMatchObject({
      id: rows[0].id,
      payoutEmail: id.email,
      paypalConnected: true,
    });
    // No password was ever set: password login can't get in.
    const pw = await agent()
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: id.email, password: 'anything at all' });
    expect(pw.status).toBe(401);
  });

  it('logging in again signs into the same publisher and keeps a payout email changed since', async () => {
    const id = identity();
    const first = await loginWithPayPal(id);
    const patched = await agent()
      .patch('/api/publishers/me')
      .set('Origin', ORIGIN)
      .set('Cookie', first.session!)
      .send({ payoutEmail: 'elsewhere@example.com' });
    expect(patched.status).toBe(200);

    const again = await loginWithPayPal({ ...id, name: 'Renamed' });
    expect(again.to).toBe('/app');
    const who = await me(again.session!);
    expect(who.body.publisher.payoutEmail).toBe('elsewhere@example.com');
    expect(await rowsFor(id.email)).toHaveLength(1);
  });

  it('Connect with PayPal links a signed-in password account and fills its payout email', async () => {
    const pw = await passwordSignup();
    const id = identity();
    const linked = await loginWithPayPal(id, pw.session);
    expect(linked.to).toBe('/app/settings?tab=payout&paypal=connected');
    expect(linked.session).toBeUndefined(); // still the same session
    const who = await me(pw.session);
    expect(who.body.publisher).toMatchObject({
      id: pw.id,
      email: pw.email,
      payoutEmail: id.email,
      paypalConnected: true,
    });
    // Signed out, Log in with PayPal now reaches the password account.
    const back = await loginWithPayPal(id);
    expect(back.to).toBe('/app');
    expect((await me(back.session!)).body.publisher.id).toBe(pw.id);
  });

  it('a plain /start while signed in is a login: it never links to the current session', async () => {
    const a = await passwordSignup();
    const before = (await me(a.session)).body.publisher;

    // (a) A new PayPal identity creates its own publisher and the session switches to it.
    const fresh = identity();
    stub.identity = fresh;
    const created = await callback(await start(a.session, null), { session: a.session });
    expect(created.to).toBe('/app/connect');
    const now = (await me(created.session!)).body.publisher;
    expect(now.id).not.toBe(a.id);
    expect(now.payoutEmail).toBe(fresh.email);

    // (b) A PayPal identity already on publisher B signs in as B, not `taken` on A.
    const b = await loginWithPayPal(identity());
    const bId = (await me(b.session!)).body.publisher.id;
    stub.identity = { ...stub.identity };
    const asB = await callback(await start(a.session, null), { session: a.session });
    expect(asB.to).toBe('/app');
    expect((await me(asB.session!)).body.publisher.id).toBe(bId);

    // A is untouched: no payer id, same payout email.
    const { rows } = await app.db.pool.query(
      'SELECT paypal_payer_id, payout_email FROM publishers WHERE id = $1',
      [a.id],
    );
    expect(rows[0]).toEqual({ paypal_payer_id: null, payout_email: before.payoutEmail });
  });

  it('?intent=connect without a session is a plain login', async () => {
    const id = identity();
    stub.identity = id;
    const r = await callback(await start(undefined, 'connect'));
    expect(r.to).toBe('/app/connect');
    expect(await rowsFor(id.email)).toHaveLength(1);
  });

  it('an unlinked password account with the PayPal email is not merged: link-required', async () => {
    const pw = await passwordSignup();
    const { to, session } = await loginWithPayPal(identity({ email: pw.email }));
    expect(to).toBe('/app/login?paypal=link-required');
    expect(session).toBeUndefined();
    const rows = await rowsFor(pw.email);
    expect(rows).toHaveLength(1);
    expect(rows[0].paypal_payer_id).toBeNull();
  });

  it('a payer id linked to another publisher can’t be connected again: taken', async () => {
    const id = identity();
    const owner = await loginWithPayPal(id);
    const other = await passwordSignup();
    const { to } = await loginWithPayPal(id, other.session);
    expect(to).toBe('/app/settings?tab=payout&paypal=taken');
    expect((await me(other.session)).body.publisher.paypalConnected).toBe(false);
    expect((await me(owner.session!)).body.publisher.paypalConnected).toBe(true);
  });

  it('a missing or mismatched state never reaches PayPal and signs nobody in', async () => {
    const s = await start();
    const noCookie = await agent().get(`${s.location.pathname}${s.location.search}`);
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.location).toBe('/app/login?paypal=state');

    const other = await start();
    const swapped = await callback(other, {
      query: `/api/auth/paypal/callback?code=${s.location.searchParams.get('code')}&state=${s.location.searchParams.get('state')}`,
    });
    expect(swapped.to).toBe('/app/login?paypal=state');
    expect(swapped.session).toBeUndefined();

    const forged = await callback({ ...s, lipp: `${s.lipp.slice(0, -2)}xx` });
    expect(forged.to).toBe('/app/login?paypal=state');
    expect(stub.provider.exchanged).toEqual([]);
  });

  it('cancelled consent (error=access_denied) shows the cancelled state; nothing exchanged', async () => {
    const s = await start();
    const state = s.location.searchParams.get('state')!;
    const r = await callback(s, {
      query: `/api/auth/paypal/callback?error=access_denied&state=${state}`,
    });
    expect(r.to).toBe('/app/login?paypal=cancelled');
    expect(stub.provider.exchanged).toEqual([]);

    const pw = await passwordSignup();
    const s2 = await start(pw.session);
    const r2 = await callback(s2, {
      session: pw.session,
      query: `/api/auth/paypal/callback?error=access_denied&state=${s2.location.searchParams.get('state')}`,
    });
    expect(r2.to).toBe('/app/settings?tab=payout&paypal=cancelled');
  });

  it('an unverified email or a missing payer id is refused', async () => {
    const a = identity({ emailVerified: false });
    expect((await loginWithPayPal(a)).to).toBe('/app/login?paypal=unverified');
    const b = identity({ payerId: null });
    expect((await loginWithPayPal(b)).to).toBe('/app/login?paypal=unverified');
    expect(await rowsFor(a.email)).toHaveLength(0);
    expect(await rowsFor(b.email)).toHaveLength(0);
  });

  it('a replayed callback (same code and state cookie) fails at PayPal: one publisher', async () => {
    stub.identity = identity();
    const s = await start();
    const first = await callback(s);
    expect(first.to).toBe('/app/connect');
    const replay = await callback(s);
    expect(replay.to).toBe('/app/login?paypal=error');
    expect(replay.session).toBeUndefined();
    expect(await rowsFor(stub.identity.email)).toHaveLength(1);
  });

  it('Connect started as one publisher can’t finish under another session or none', async () => {
    const a = await passwordSignup();
    const b = await passwordSignup();
    stub.identity = identity();
    const s = await start(a.session);
    expect((await callback(s, { session: b.session })).to).toBe('/app/login?paypal=state');
    const s2 = await start(a.session);
    expect((await callback(s2)).to).toBe('/app/login?paypal=state');
    expect((await me(a.session)).body.publisher.paypalConnected).toBe(false);
    expect((await me(b.session)).body.publisher.paypalConnected).toBe(false);
    expect(stub.provider.exchanged).toEqual([]);
  });

  it('a PayPal failure maps to ?paypal=error without logging the code or identity', async () => {
    stub.identity = identity();
    stub.provider.failNext = { http: 500, error: 'server_error' };
    const s = await start();
    const r = await callback(s);
    expect(r.to).toBe('/app/login?paypal=error');
    expect(logs).toContain('paypal login failed');
    expect(logs).not.toContain(s.location.searchParams.get('code')!);
    expect(logs).not.toContain(stub.identity.email);
    expect(logs).not.toContain(REQUIRED_ENV.PAYPAL_CLIENT_SECRET!);
  });

  it('race: 8 concurrent first logins for one PayPal identity create exactly one publisher', async () => {
    const id = identity();
    stub.identity = id;
    const starts = await Promise.all(Array.from({ length: 8 }, () => start()));
    const results = await Promise.all(starts.map((s) => callback(s)));
    expect(results.filter((r) => r.to === '/app/connect')).toHaveLength(1);
    expect(results.filter((r) => r.to === '/app')).toHaveLength(7);
    const rows = await rowsFor(id.email);
    expect(rows).toHaveLength(1);
    const ids = await Promise.all(
      results.map(async (r) => (await me(r.session!)).body.publisher.id),
    );
    expect(new Set(ids)).toEqual(new Set([rows[0].id]));
  });

  it('race: two publishers connecting the same PayPal account at once: one wins, one is taken', async () => {
    const [a, b] = await Promise.all([passwordSignup(), passwordSignup()]);
    stub.identity = identity();
    const [sa, sb] = await Promise.all([start(a.session), start(b.session)]);
    const [ra, rb] = await Promise.all([
      callback(sa, { session: a.session }),
      callback(sb, { session: b.session }),
    ]);
    expect([ra.to, rb.to].sort()).toEqual([
      '/app/settings?tab=payout&paypal=connected',
      '/app/settings?tab=payout&paypal=taken',
    ]);
    const { rows } = await app.db.pool.query(
      'SELECT count(*)::int AS n FROM publishers WHERE paypal_payer_id = $1',
      [stub.identity.payerId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('PAYPAL_MODE=stub without an override: start → callback signs in the stub identity', async () => {
    setPayPalIdentity(undefined);
    const s = await start();
    expect(s.location.pathname).toBe('/api/auth/paypal/callback');
    const r = await callback(s);
    expect(['/app/connect', '/app']).toContain(r.to);
    expect((await me(r.session!)).body.publisher.paypalConnected).toBe(true);
  });
});

describe('SP-058 /start against the sandbox base (no database)', () => {
  it('302s to sandbox consent with state, nonce and the registered callback; no secret', async () => {
    setPayPalIdentity(undefined);
    const app = await buildServer(loadConfig({ ...REQUIRED_ENV, PAYPAL_MODE: 'sandbox' }), {
      logger: false,
    });
    try {
      const res = await request((await app.ready()).server).get('/api/auth/paypal/start');
      expect(res.status).toBe(302);
      const url = new URL(String(res.headers.location));
      expect(url.origin + url.pathname).toBe('https://www.sandbox.paypal.com/signin/authorize');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/auth/paypal/callback',
      );
      expect(url.searchParams.get('state')).toMatch(/^[\w-]{32}$/);
      expect(url.searchParams.get('nonce')).toMatch(/^[\w-]{32}$/);
      expect(res.headers.location).not.toContain(REQUIRED_ENV.PAYPAL_CLIENT_SECRET!);
      expect(String(res.headers['set-cookie'])).toMatch(/Path=\/api\/auth\/paypal/);
    } finally {
      await app.close();
    }
  });
});
