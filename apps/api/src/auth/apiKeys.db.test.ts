import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { cases } from '../security/tenancy/buyer-keys.cases.js';
import {
  apiKeyRateLimit,
  authenticateBearer,
  createKey,
  generateKey,
  requireScope,
} from './apiKeys.js';

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

/** A promise you resolve from outside. */
function latch() {
  let open!: () => void;
  const done = new Promise<void>((r) => (open = r));
  return { done, open };
}

describe.skipIf(!testDatabaseUrl)('SP-007b buyer API keys (Postgres)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let logs = '';
  /** Requests to /v1/test/held wait here *before* authenticateBearer runs. */
  let gate = latch();
  let arrived = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs += chunk.toString();
        cb();
      },
    });
    app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url }), {
      logStream: stream,
    });
    // Stand-ins for SP-017b's /v1 and SP-022a's /mcp: the hook, the scope guard, the limiter.
    await app.register(async (v1) => {
      v1.addHook('onRequest', authenticateBearer);
      v1.get('/v1/test/whoami', { preHandler: apiKeyRateLimit('rest') }, async (req) => ({
        buyerId: req.buyer?.id,
        via: req.buyer?.via,
        apiKeyId: req.apiKey?.id,
        scopes: req.apiKey?.scopes,
      }));
      v1.post('/v1/test/topups', { preHandler: requireScope('topup') }, async () => ({ ok: true }));
      v1.get('/mcp/test', { preHandler: apiKeyRateLimit('mcp') }, async () => ({ ok: true }));
    });
    await app.register(async (held) => {
      held.addHook('onRequest', async () => {
        arrived += 1;
        await gate.done;
      });
      held.addHook('onRequest', authenticateBearer);
      held.get('/v1/test/held', async (req) => ({ buyerId: req.buyer?.id }));
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => app.rateLimiter.reset());

  const agent = () => request(app.server);

  async function newBuyer() {
    const res = await agent()
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Acme', email: `b-${randomUUID()}@example.com`, password: 'battery staple' });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, cookie: cookiesOf(res) };
  }

  const createVia = (cookie: string, body: object = {}) =>
    agent().post('/api/buyer/keys').set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const listVia = (cookie: string) => agent().get('/api/buyer/keys').set('Cookie', cookie);
  const revokeVia = (cookie: string, id: string) =>
    agent().delete(`/api/buyer/keys/${id}`).set('Origin', ORIGIN).set('Cookie', cookie);
  const whoami = (key: string) =>
    agent().get('/v1/test/whoami').set('Authorization', `Bearer ${key}`);

  describe('portal routes', () => {
    it('create returns the key once; GET lists the prefix only', async () => {
      const b = await newBuyer();
      const res = await createVia(b.cookie, { name: 'laptop', scopes: ['read', 'topup'] });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const key = res.body.key as string;
      expect(key).toMatch(/^sk_spg_[0-9A-Za-z]{43}$/);
      expect(res.body).toMatchObject({
        name: 'laptop',
        prefix: key.slice(7, 15),
        scopes: ['read', 'topup'],
        rateLimitPerMin: 60,
        revokedAt: null,
      });

      const list = await listVia(b.cookie);
      expect(list.status).toBe(200);
      expect(list.body.keys).toHaveLength(1);
      expect(list.body.keys[0]).toMatchObject({ id: res.body.id, prefix: key.slice(7, 15) });
      const raw = JSON.stringify(list.body);
      expect(raw).not.toContain(key.slice(7));
      expect(raw).not.toMatch(/hash/i);
      expect(list.body.keys[0]).not.toHaveProperty('key');

      // Stored as SHA-256 only; the key is in no column.
      const { rows } = await app.db.pool.query(
        `SELECT row_to_json(k)::text AS j FROM api_keys k WHERE id = $1`,
        [res.body.id],
      );
      expect(rows[0].j).not.toContain(key.slice(7));
      // And never in a log line.
      expect(logs).not.toContain(key.slice(7));
    });

    it('scopes default to read; bad scopes → 400 VALIDATION_ERROR', async () => {
      const b = await newBuyer();
      const res = await createVia(b.cookie);
      expect(res.status).toBe(201);
      expect(res.body.scopes).toEqual(['read']);
      const bad = await createVia(b.cookie, { scopes: ['admin'] });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('needs a portal session: anonymous or an API key → 401; no Origin → 403 (CSRF)', async () => {
      const b = await newBuyer();
      const { body } = await createVia(b.cookie);
      expect((await agent().get('/api/buyer/keys')).status).toBe(401);
      const bearer = await agent()
        .post('/api/buyer/keys')
        .set('Authorization', `Bearer ${body.key}`)
        .send({});
      expect(bearer.status).toBe(401);
      expect(bearer.body.error.code).toBe('UNAUTHENTICATED');
      const noOrigin = await agent().post('/api/buyer/keys').set('Cookie', b.cookie).send({});
      expect(noOrigin.status).toBe(403);
    });

    it('tenancy: a buyer sees only their keys and cannot revoke another buyer’s key (404)', async () => {
      expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET /api/buyer/keys',
        'POST /api/buyer/keys',
        'DELETE /api/buyer/keys/:id',
      ]);
      const a = await newBuyer();
      const b = await newBuyer();
      const aKey = (await createVia(a.cookie, { buyerId: b.id })).body;
      const bKey = (await createVia(b.cookie)).body;

      const aList = await agent().get(`/api/buyer/keys?buyerId=${b.id}`).set('Cookie', a.cookie);
      expect(aList.body.keys.map((k: { id: string }) => k.id)).toEqual([aKey.id]);
      expect((await whoami(aKey.key)).body.buyerId).toBe(a.id);

      const cross = await revokeVia(a.cookie, bKey.id);
      expect(cross.status).toBe(404);
      expect(cross.body.error.code).toBe('NOT_FOUND');
      expect((await revokeVia(a.cookie, randomUUID())).status).toBe(404);
      expect((await revokeVia(a.cookie, 'not-a-uuid')).status).toBe(404);
      // B's key still works.
      expect((await whoami(bKey.key)).status).toBe(200);
    });

    it('revoke is idempotent and keeps the first revoked_at; the list shows it', async () => {
      const b = await newBuyer();
      const { body } = await createVia(b.cookie);
      const first = await revokeVia(b.cookie, body.id);
      expect(first.status).toBe(200);
      expect(first.body.key.revokedAt).toBeTruthy();
      const again = await revokeVia(b.cookie, body.id);
      expect(again.status).toBe(200);
      expect(again.body.key.revokedAt).toBe(first.body.key.revokedAt);
      const list = await listVia(b.cookie);
      expect(list.body.keys[0].revokedAt).toBe(first.body.key.revokedAt);
    });
  });

  describe('Bearer hook', () => {
    it('valid key → buyer resolved (via apiKey), even with another buyer’s session cookie', async () => {
      const a = await newBuyer();
      const b = await newBuyer();
      const { body } = await createVia(a.cookie);
      const res = await whoami(body.key).set('Cookie', b.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        buyerId: a.id,
        via: 'apiKey',
        apiKeyId: body.id,
        scopes: ['read'],
      });
    });

    it('missing, malformed, unknown → 401 UNAUTHENTICATED; a session cookie alone is not enough', async () => {
      const b = await newBuyer();
      const unknown = generateKey().key;
      const attempts = [
        agent().get('/v1/test/whoami'),
        agent().get('/v1/test/whoami').set('Cookie', b.cookie),
        agent().get('/v1/test/whoami').set('Authorization', 'Bearer'),
        agent().get('/v1/test/whoami').set('Authorization', 'Bearer gk_notabuyerkey'),
        agent().get('/v1/test/whoami').set('Authorization', `Basic ${unknown}`),
        agent().get('/v1/test/whoami').set('Authorization', `Bearer ${unknown}x`),
        whoami(unknown),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('revoked → 401 KEY_REVOKED on the very next request', async () => {
      const b = await newBuyer();
      const { body } = await createVia(b.cookie);
      expect((await whoami(body.key)).status).toBe(200);
      expect((await revokeVia(b.cookie, body.id)).status).toBe(200);
      const res = await whoami(body.key);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('KEY_REVOKED');
    });

    it('a key without the topup scope → 403 FORBIDDEN on a topup route', async () => {
      const b = await newBuyer();
      const readOnly = (await createVia(b.cookie, { scopes: ['read'] })).body.key;
      const topupOnly = (await createVia(b.cookie, { scopes: ['topup'] })).body.key;
      const denied = await agent()
        .post('/v1/test/topups')
        .set('Authorization', `Bearer ${readOnly}`)
        .send({});
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: { requiredScope: 'topup' },
      });
      const ok = await agent()
        .post('/v1/test/topups')
        .set('Authorization', `Bearer ${topupOnly}`)
        .send({});
      expect(ok.status).toBe(200);
    });

    it('last_used_at is written at most once a minute', async () => {
      const b = await newBuyer();
      const { body } = await createVia(b.cookie);
      const lastUsed = async () =>
        (
          await app.db.pool.query<{ t: Date | null }>(
            `SELECT last_used_at AS t FROM api_keys WHERE id = $1`,
            [body.id],
          )
        ).rows[0]!.t;
      expect(await lastUsed()).toBeNull();
      await whoami(body.key);
      const first = await lastUsed();
      expect(first).toBeInstanceOf(Date);
      await Promise.all(Array.from({ length: 5 }, () => whoami(body.key)));
      expect((await lastUsed())!.getTime()).toBe(first!.getTime());
      // A minute later the next call bumps it.
      await app.db.pool.query(
        `UPDATE api_keys SET last_used_at = now() - interval '61 seconds' WHERE id = $1`,
        [body.id],
      );
      const stale = await lastUsed();
      await whoami(body.key);
      expect((await lastUsed())!.getTime()).toBeGreaterThan(stale!.getTime());
    });

    it('rate_limit_per_min is honoured per key (REST), and MCP is capped at 30/min', async () => {
      const b = await newBuyer();
      const slow = await createKey(app.db.pool, b.id, { rateLimitPerMin: 3 });
      const other = await createKey(app.db.pool, b.id);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await whoami(slow.key)).status);
      expect(statuses).toEqual([200, 200, 200, 429]);
      const limited = await whoami(slow.key);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(limited.headers['retry-after']).toBeDefined();
      // Another key of the same buyer has its own bucket.
      expect((await whoami(other.key)).status).toBe(200);

      const fast = await createKey(app.db.pool, b.id, { rateLimitPerMin: 1000 });
      const mcp: number[] = [];
      for (let i = 0; i < 31; i++) {
        mcp.push(
          (await agent().get('/mcp/test').set('Authorization', `Bearer ${fast.key}`)).status,
        );
      }
      expect(mcp.filter((s) => s === 200)).toHaveLength(30);
      expect(mcp[30]).toBe(429);
    });
  });

  describe('revoke race', () => {
    it('10 requests in flight when the revoke commits: every one that authenticates after it fails', async () => {
      const b = await newBuyer();
      const { body } = await createVia(b.cookie);
      gate = latch();
      arrived = 0;
      const inFlight = Array.from({ length: 10 }, () =>
        agent()
          .get('/v1/test/held')
          .set('Authorization', `Bearer ${body.key}`)
          .then((r) => r),
      );
      // All 10 have reached the server and are waiting just before authenticateBearer.
      await expect.poll(() => arrived, { timeout: 5_000 }).toBe(10);
      expect((await revokeVia(b.cookie, body.id)).status).toBe(200);
      gate.open();
      for (const res of await Promise.all(inFlight)) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('KEY_REVOKED');
      }
    });

    it('revoke racing 10 concurrent requests: each is 200 or KEY_REVOKED; all after the commit fail', async () => {
      const b = await newBuyer();
      const { body } = await createVia(b.cookie);
      const racing = Array.from({ length: 10 }, () => whoami(body.key).then((r) => r));
      const revoked = await revokeVia(b.cookie, body.id);
      expect(revoked.status).toBe(200);
      for (const res of await Promise.all(racing)) {
        if (res.status === 200) expect(res.body.buyerId).toBe(b.id);
        else expect([res.status, res.body.error.code]).toEqual([401, 'KEY_REVOKED']);
      }
      const after = await Promise.all(Array.from({ length: 10 }, () => whoami(body.key)));
      for (const res of after) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('KEY_REVOKED');
      }
    });
  });
});
