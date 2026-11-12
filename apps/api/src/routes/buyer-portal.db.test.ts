import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { authenticateKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { FakePayPal } from '../paypal/index.js';
import { cases } from '../security/tenancy/buyer-portal.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { setTopupPayPal } from '../topups/index.js';

/**
 * SP-032 W11 against the API the page calls, with FakePayPal standing in for the JS SDK v6
 * approval: balance, PayPal client config (no secret), the top-up the button drives (double
 * click, racing captures) and key revoke.
 */
const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-032 buyer portal (Postgres + FakePayPal)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let sandboxApp: FastifyInstance;
  let fake: FakePayPal;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logger: false },
    );
    await app.ready();
    sandboxApp = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'sandbox' }),
      { logger: false },
    );
    await sandboxApp.ready();
    fake = new FakePayPal({ latencyMs: 5, jitterMs: 10 });
  });
  afterAll(async () => {
    setTopupPayPal(undefined);
    await app?.close();
    await sandboxApp?.close();
    await db?.drop();
  });
  beforeEach(() => {
    app.rateLimiter.reset();
    sandboxApp.rateLimiter.reset();
    fake.clearFaults();
    setTopupPayPal(fake.client({ timeoutMs: 1_000 }));
  });

  const agent = (on = app) => request(on.server);

  async function newBuyer(on = app) {
    const res = await agent(on)
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Acme', email: `b-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, cookie: cookiesOf(res) };
  }

  const balance = (cookie: string, query = '') =>
    agent().get(`/api/buyer/balance${query}`).set('Cookie', cookie);
  const startTopup = (cookie: string, key: string = randomUUID()) =>
    agent()
      .post('/api/buyer/topups')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send({ amountCents: 2000, method: 'PAYPAL_WALLET', saveForAutoTopup: false });
  const capture = (cookie: string, id: string) =>
    agent()
      .post(`/api/buyer/topups/${id}/capture`)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({});

  it('balance needs a buyer session and starts at 0', async () => {
    expect((await agent().get('/api/buyer/balance')).status).toBe(401);
    const buyer = await newBuyer();
    const res = await balance(buyer.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ balanceMicros: 0 });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('W11 flow: $20 approved in PayPal → capture → balance $20.00 (20,000,000 micros)', async () => {
    const buyer = await newBuyer();
    const created = await startTopup(buyer.cookie);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'AWAITING_APPROVAL', amountCents: 2000 });
    // What the JS SDK v6 popup does when the sandbox Personal account approves.
    fake.approve(created.body.orderId);
    const captured = await capture(buyer.cookie, created.body.topupId);
    expect(captured.status, JSON.stringify(captured.body)).toBe(200);
    expect(captured.body).toMatchObject({ status: 'COMPLETED', balanceMicros: 20_000_000 });
    expect((await balance(buyer.cookie)).body).toEqual({ balanceMicros: 20_000_000 });

    const list = await agent().get('/api/buyer/topups').set('Cookie', buyer.cookie);
    expect(list.body.topups[0]).toMatchObject({
      topupId: created.body.topupId,
      trigger: 'MANUAL',
      method: 'PAYPAL_WALLET',
      status: 'COMPLETED',
      orderId: created.body.orderId,
      captureId: captured.body.captureId,
    });
  });

  it('double click on the PayPal button (same Idempotency-Key) → one top-up, one order', async () => {
    const buyer = await newBuyer();
    const key = randomUUID();
    const clicks = await Promise.all([1, 2, 3].map(() => startTopup(buyer.cookie, key)));
    const ids = new Set(clicks.map((c) => c.body.topupId));
    const orders = new Set(clicks.map((c) => c.body.orderId));
    expect(ids.size).toBe(1);
    expect(orders.size).toBe(1);
    const { rows } = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM topups WHERE buyer_id = $1`,
      [buyer.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('racing captures (onApprove fired twice, plus a retry) credit once', async () => {
    const buyer = await newBuyer();
    const created = await startTopup(buyer.cookie);
    fake.approve(created.body.orderId);
    const outs = await Promise.all(
      [1, 2, 3, 4].map(() => capture(buyer.cookie, created.body.topupId)),
    );
    for (const o of outs) {
      expect(o.status, JSON.stringify(o.body)).toBe(200);
      expect(o.body.status).toBe('COMPLETED');
    }
    expect(new Set(outs.map((o) => o.body.captureId)).size).toBe(1);
    expect((await balance(buyer.cookie)).body).toEqual({ balanceMicros: 20_000_000 });
    const { rows } = await app.db.pool.query(
      `SELECT count(*)::int AS n FROM ledger_txns WHERE idempotency_key = $1`,
      [`topup:${created.body.topupId}`],
    );
    expect(rows[0].n).toBe(1);
  });

  it("tenancy: A's balance is A's; ?buyerId=<B> is ignored", async () => {
    expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/buyer/balance',
      'GET /api/buyer/paypal-config',
    ]);
    const a = await newBuyer();
    const b = await newBuyer();
    const t = await startTopup(b.cookie);
    fake.approve(t.body.orderId);
    expect((await capture(b.cookie, t.body.topupId)).status).toBe(200);
    expect((await balance(a.cookie, `?buyerId=${b.id}`)).body).toEqual({ balanceMicros: 0 });
    expect((await balance(b.cookie)).body).toEqual({ balanceMicros: 20_000_000 });
  });

  it('paypal-config sends the client id only, never the secret; null under stub', async () => {
    expect((await agent().get('/api/buyer/paypal-config')).status).toBe(401);

    const stubBuyer = await newBuyer();
    const stub = await agent().get('/api/buyer/paypal-config').set('Cookie', stubBuyer.cookie);
    expect(stub.body).toEqual({ clientId: null, environment: 'sandbox' });

    const buyer = await newBuyer(sandboxApp);
    const res = await agent(sandboxApp).get('/api/buyer/paypal-config').set('Cookie', buyer.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clientId: REQUIRED_ENV.PAYPAL_CLIENT_ID, environment: 'sandbox' });
    expect(res.text.includes(REQUIRED_ENV.PAYPAL_CLIENT_SECRET!)).toBe(false);
  });

  it('a key is shown once; revoking it makes the next Bearer (MCP / v1) auth fail', async () => {
    const buyer = await newBuyer();
    const created = await agent()
      .post('/api/buyer/keys')
      .set('Origin', ORIGIN)
      .set('Cookie', buyer.cookie)
      .send({ name: 'Claude Desktop', scopes: ['read', 'topup'] });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^sk_spg_/);

    const list = await agent().get('/api/buyer/keys').set('Cookie', buyer.cookie);
    expect(JSON.stringify(list.body).includes(key)).toBe(false);

    // The same check `/mcp` and `/v1` run on every request (authenticateBearer → authenticateKey).
    await expect(authenticateKey(app.db.pool, key)).resolves.toMatchObject({ buyerId: buyer.id });
    const revoked = await agent()
      .delete(`/api/buyer/keys/${created.body.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', buyer.cookie);
    expect(revoked.status).toBe(200);
    await expect(authenticateKey(app.db.pool, key)).rejects.toMatchObject({ code: 'KEY_REVOKED' });
  });
});
