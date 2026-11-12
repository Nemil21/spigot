import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { audit, AUDIT_ACTIONS, type AuditAction } from '../audit/audit.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { buildServer } from '../server.js';
import { forPublisher } from '../tenancy.js';
import { REQUIRED_ENV } from '../test/env.js';
import { cases } from '../security/tenancy/auth.cases.js';
import { adminOnly } from './admin.js';

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const ADMIN = 'ops@spigot.test';
const FAKE_KEY = 'sk_spg_FAKEkey0123456789abcdefghijklmnopqrstu';

/** `name=value` pairs from a response's Set-Cookie headers. */
function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-007a auth core (Postgres)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let logs = '';

  beforeAll(async () => {
    db = await createTestDatabase();
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs += chunk.toString();
        cb();
      },
    });
    app = await buildServer(
      loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: db.url,
        ADMIN_EMAILS: `Other@x.io, ${ADMIN.toUpperCase()}`,
      }),
      { logStream: stream },
    );
    app.get('/admin/whoami', { preHandler: adminOnly }, async () => ({ ok: true }));
    app.get('/api/test/boom', async (req) => {
      req.log.info({ email: 'leak@victim.io', note: `user pasted ${FAKE_KEY}` }, 'about to fail');
      throw new Error(`failed for leak@victim.io with ${FAKE_KEY}`);
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  // The per-IP login/signup limit (20/min) would trip across tests that all come from 127.0.0.1.
  beforeEach(() => app.rateLimiter.reset());

  const agent = () => request(app.server);
  const post = (url: string, body: object, cookie = '') =>
    agent().post(url).set('Origin', ORIGIN).set('Cookie', cookie).send(body);

  async function newPublisher(email = `p-${randomUUID()}@example.com`) {
    const res = await post('/api/auth/signup', {
      name: 'Bluebonnet',
      email,
      password: 'correct horse',
      payoutEmail: 'payouts@example.com',
    });
    expect(res.status).toBe(201);
    return { id: res.body.publisherId as string, email, cookie: cookiesOf(res) };
  }

  async function newBuyer(email = `b-${randomUUID()}@example.com`) {
    const res = await post('/api/buyer/signup', {
      name: 'Acme',
      email,
      password: 'battery staple',
    });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, email, cookie: cookiesOf(res) };
  }

  describe('publisher', () => {
    it('signup → login → /api/auth/me; wrong password → 401 UNAUTHENTICATED', async () => {
      const email = `Mixed.${randomUUID()}@Example.com`;
      const signup = await post('/api/auth/signup', {
        name: 'Bluebonnet Rentals',
        email,
        password: 'correct horse',
        payoutEmail: 'pay@example.com',
      });
      expect(signup.status).toBe(201);
      const setCookie = (signup.headers['set-cookie'] as unknown as string[])[0]!;
      expect(setCookie).toMatch(/^spg_pub=/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      expect(setCookie).toMatch(/Max-Age=43200/);

      const login = await post('/api/auth/login', {
        email: email.toUpperCase(),
        password: 'correct horse',
      });
      expect(login.status).toBe(200);
      expect(login.body).toEqual({ publisherId: signup.body.publisherId });

      const me = await agent().get('/api/auth/me').set('Cookie', cookiesOf(login));
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        publisher: {
          id: signup.body.publisherId,
          email: email.toLowerCase(),
          name: 'Bluebonnet Rentals',
        },
        buyer: null,
        isAdmin: false,
      });

      const wrong = await post('/api/auth/login', { email, password: 'wrong horse' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({
        error: { code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' },
      });
      expect(wrong.headers['set-cookie']).toBeUndefined();
      const unknown = await post('/api/auth/login', { email: 'nobody@example.com', password: 'x' });
      expect(unknown.status).toBe(401);
      expect(unknown.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('no session → 401; a buyer cookie never passes as a publisher', async () => {
      expect((await agent().get('/api/auth/me')).status).toBe(401);
      const b = await newBuyer();
      const forged = b.cookie.replace('spg_buy=', 'spg_pub=');
      const me = await agent().get('/api/auth/me').set('Cookie', forged);
      expect(me.status).toBe(401);
    });

    it('duplicate email (any case) → 409; bad input → 400 VALIDATION_ERROR', async () => {
      const p = await newPublisher();
      const dup = await post('/api/auth/signup', {
        name: 'x',
        email: p.email.toUpperCase(),
        password: 'long enough',
        payoutEmail: 'a@b.io',
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('STATE_CONFLICT');

      const bad = await post('/api/auth/signup', { name: '', email: 'nope', password: 'short' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
      const paths = (bad.body.error.details.issues as { path: string }[]).map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['name', 'email', 'password', 'payoutEmail']));
    });

    it('concurrent signups with one email: exactly one account', async () => {
      const email = `race-${randomUUID()}@example.com`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          post('/api/auth/signup', {
            name: 'r',
            email,
            password: 'long enough',
            payoutEmail: 'a@b.io',
          }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const { rows } = await app.db.pool.query(
        `SELECT count(*)::int AS n FROM publishers WHERE email = $1`,
        [email],
      );
      expect(rows[0].n).toBe(1);
    });

    it('logout clears the cookie', async () => {
      const p = await newPublisher();
      const out = await post('/api/auth/logout', {}, p.cookie);
      expect(out.status).toBe(204);
      const set = (out.headers['set-cookie'] as unknown as string[])[0]!;
      expect(set).toMatch(/^spg_pub=;/);
      expect(set).toMatch(/Expires=Thu, 01 Jan 1970/);
    });
  });

  describe('buyer portal', () => {
    it('signup → login → /api/auth/me and /api/buyer/me; wrong password → 401', async () => {
      const b = await newBuyer();
      const set = (
        (await post('/api/buyer/login', { email: b.email, password: 'battery staple' })).headers[
          'set-cookie'
        ] as unknown as string[]
      )[0]!;
      expect(set).toMatch(/^spg_buy=/);
      expect(set).toMatch(/Max-Age=2592000/);
      const cookie = set.split(';', 1)[0]!;

      const me = await agent().get('/api/auth/me').set('Cookie', cookie);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        publisher: null,
        buyer: { id: b.id, email: b.email },
        isAdmin: false,
      });
      const buyerMe = await agent().get('/api/buyer/me').set('Cookie', cookie);
      expect(buyerMe.body).toEqual({ id: b.id, name: 'Acme', email: b.email });

      const wrong = await post('/api/buyer/login', { email: b.email, password: 'nope nope' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
      expect((await agent().get('/api/buyer/me')).status).toBe(401);
    });

    it('both cookies at once: /api/auth/me shows both principals', async () => {
      const p = await newPublisher();
      const b = await newBuyer();
      const me = await agent().get('/api/auth/me').set('Cookie', `${p.cookie}; ${b.cookie}`);
      expect(me.body).toMatchObject({ publisher: { id: p.id }, buyer: { id: b.id } });
    });
  });

  describe('admin', () => {
    it('requireAdmin: ADMIN_EMAILS (case-insensitive) → 200; other publisher → 403; none → 401', async () => {
      const admin = await newPublisher(ADMIN);
      const me = await agent().get('/api/auth/me').set('Cookie', admin.cookie);
      expect(me.body.isAdmin).toBe(true);
      expect((await agent().get('/admin/whoami').set('Cookie', admin.cookie)).status).toBe(200);
      const other = await newPublisher();
      const forbidden = await agent().get('/admin/whoami').set('Cookie', other.cookie);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe('FORBIDDEN');
      expect((await agent().get('/admin/whoami')).status).toBe(401);
      // A buyer with an admin email is still not an admin.
      const b = await newBuyer('other@x.io');
      expect((await agent().get('/admin/whoami').set('Cookie', b.cookie)).status).toBe(401);
    });
  });

  describe('CSRF', () => {
    it('a mutating route without a same-origin Origin → 403', async () => {
      const p = await newPublisher();
      const noOrigin = await agent().post('/api/auth/logout').set('Cookie', p.cookie).send({});
      expect(noOrigin.status).toBe(403);
      expect(noOrigin.body.error.code).toBe('FORBIDDEN');
      const evil = await agent()
        .post('/api/auth/logout')
        .set('Origin', 'https://evil.example')
        .set('Cookie', p.cookie)
        .send({});
      expect(evil.status).toBe(403);
      const login = await agent()
        .post('/api/buyer/login')
        .set('Origin', 'https://evil.example')
        .send({ email: 'x@y.io', password: 'whatever' });
      expect(login.status).toBe(403);
      expect((await post('/api/auth/logout', {}, p.cookie)).status).toBe(204);
    });
  });

  describe('rate limit', () => {
    it('121st publisher request in a minute → 429 with Retry-After', async () => {
      const p = await newPublisher();
      // The bucket refills one token per 500 ms; freeze the clock so a slow CI run can't earn one
      // back mid-burst. signup counted nothing (no session yet); 120 session requests are allowed.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      let limited: request.Response;
      try {
        for (let i = 0; i < 120; i++) {
          const res = await agent().get('/api/auth/me').set('Cookie', p.cookie);
          expect(res.status).toBe(200);
        }
        limited = await agent().get('/api/auth/me').set('Cookie', p.cookie);
      } finally {
        vi.useRealTimers();
      }
      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      // Another publisher has its own bucket.
      const q = await newPublisher();
      expect((await agent().get('/api/auth/me').set('Cookie', q.cookie)).status).toBe(200);
    });
  });

  describe('log redaction', () => {
    it('logged request lines never contain a full key or email', async () => {
      logs = '';
      const email = `secret-${randomUUID()}@example.com`;
      await agent().get(`/api/healthz?key=${FAKE_KEY}&email=${encodeURIComponent(email)}`);
      await agent()
        .get(`/api/nope/${FAKE_KEY}/${email}`)
        .set('Authorization', `Bearer ${FAKE_KEY}`);
      await agent().get('/api/test/boom').set('X-Spigot-Key', 'ck_FAKEcrawlKey123456');
      await post('/api/auth/login', { email, password: 'not-right' });
      expect(logs).toContain('incoming request');
      expect(logs).toContain('unhandled error');
      for (const secret of [
        FAKE_KEY,
        email,
        encodeURIComponent(email),
        'leak@victim.io',
        'ck_FAKEcrawlKey',
      ]) {
        expect(logs).not.toContain(secret);
      }
      expect(logs).toContain('sk_spg_[redacted]');
    });
  });

  describe('audit()', () => {
    it('writes rows that cannot be updated or deleted (SP-002 trigger)', async () => {
      const p = await newPublisher();
      const id = await app.db.tx((tx) =>
        audit(tx, {
          actorType: 'PUBLISHER',
          actorId: p.id,
          publisherId: p.id,
          entity: 'sites',
          entityId: randomUUID(),
          action: 'SITE_CONNECTED',
          data: { origin: 'https://bluebonnet.example' },
        }),
      );
      const { rows } = await app.db.pool.query(`SELECT * FROM audit_events WHERE id = $1`, [id]);
      expect(rows[0]).toMatchObject({
        actor_type: 'PUBLISHER',
        action: 'SITE_CONNECTED',
        publisher_id: p.id,
      });
      await expect(
        app.db.pool.query(`UPDATE audit_events SET action = 'ALERT' WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        app.db.pool.query(`DELETE FROM audit_events WHERE id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      // A rolled-back transaction takes its audit row with it.
      await expect(
        app.db.tx(async (tx) => {
          await audit(tx, {
            actorType: 'SYSTEM',
            action: 'ALERT',
            data: { marker: 'rolled-back' },
          });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const gone = await app.db.pool.query(
        `SELECT 1 FROM audit_events WHERE data->>'marker' = 'rolled-back'`,
      );
      expect(gone.rowCount).toBe(0);
    });

    it('accepts every AuditAction and refuses anything else', async () => {
      for (const action of AUDIT_ACTIONS) {
        await audit(app.db.pool, { actorType: 'SYSTEM', action, paypalId: 'PAYID-TEST' });
      }
      await expect(
        audit(app.db.pool, { actorType: 'SYSTEM', action: 'SIGNED_UP' as AuditAction }),
      ).rejects.toThrow(/Unknown audit action/);
    });
  });

  describe('tenancy', () => {
    it('forPublisher: another publisher’s rows are 404; owns() scopes joins', async () => {
      const a = await newPublisher();
      const b = await newPublisher();
      const site = async (publisherId: string) => {
        const { rows } = await app.db.pool.query(
          `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
           VALUES ($1, $2, 'v', 'c', 'g') RETURNING id`,
          [publisherId, `https://${randomUUID()}.example`],
        );
        const { rows: ds } = await app.db.pool.query(
          `INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'listings', 'Listing') RETURNING id`,
          [rows[0].id],
        );
        return { siteId: rows[0].id as string, datasetId: ds[0].id as string };
      };
      const sa = await site(a.id);
      const sb = await site(b.id);
      const scope = forPublisher(a.id);

      await expect(scope.get(app.db.pool, 'sites', sa.siteId)).resolves.toMatchObject({
        id: sa.siteId,
      });
      await expect(scope.get(app.db.pool, 'sites', sb.siteId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      await expect(scope.get(app.db.pool, 'datasets', sa.datasetId)).resolves.toMatchObject({
        id: sa.datasetId,
      });
      await expect(scope.get(app.db.pool, 'datasets', sb.datasetId)).rejects.toMatchObject({
        status: 404,
      });
      await expect(scope.get(app.db.pool, 'sites', 'not-a-uuid')).rejects.toMatchObject({
        status: 404,
      });
      await expect(scope.get(app.db.pool, 'publishers', b.id)).rejects.toMatchObject({
        status: 404,
      });

      const params: unknown[] = [];
      const where = scope.owns('datasets', 'd', params);
      const { rows } = await app.db.pool.query(
        `SELECT d.id FROM datasets d WHERE ${where}`,
        params,
      );
      expect(rows.map((r) => r.id)).toEqual([sa.datasetId]);
      expect(() => scope.owns('sites', 'x; DROP TABLE sites', [])).toThrow(/alias/);
    });

    it('auth.cases: ids smuggled into the query or body are ignored', async () => {
      expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual(
        expect.arrayContaining(['GET /api/auth/me', 'GET /api/buyer/me']),
      );
      const a = await newPublisher();
      const b = await newPublisher();
      const me = await agent().get(`/api/auth/me?publisherId=${b.id}`).set('Cookie', a.cookie);
      expect(me.body.publisher.id).toBe(a.id);
      const ba = await newBuyer();
      const bb = await newBuyer();
      const buyerMe = await agent().get(`/api/buyer/me?buyerId=${bb.id}`).set('Cookie', ba.cookie);
      expect(buyerMe.body.id).toBe(ba.id);
    });
  });
});
