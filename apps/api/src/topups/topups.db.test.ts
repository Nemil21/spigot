import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { FakePayPal, fakeFeeCents, topupResultOf } from '../paypal/index.js';
import { cases } from '../security/tenancy/topups.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import {
  applyTopupResult,
  balanceOf,
  createTopup,
  creditTopup,
  setTopupPayPal,
  topupById,
  type TopupDeps,
} from './index.js';

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

/** A FakePayPal client whose capture answers report `value` as the captured amount. */
function amountRewritingFetch(fake: FakePayPal, value: string, currency = 'USD'): typeof fetch {
  return async (input, init) => {
    const res = await fake.fetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (!/\/capture$/.test(new URL(url).pathname) || res.status >= 300) return res;
    const body = (await res.json()) as {
      purchase_units: {
        payments: { captures: { amount: { value: string; currency_code: string } }[] };
      }[];
    };
    for (const c of body.purchase_units[0]!.payments.captures) {
      c.amount = { value, currency_code: currency };
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  };
}

describe.skipIf(!testDatabaseUrl)('SP-018a top-up core (Postgres + FakePayPal)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPal;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logger: false },
    );
    await app.ready();
    // One fake for the file: its order ids are unique only within one instance, like PayPal's.
    fake = new FakePayPal({ latencyMs: 5, jitterMs: 10 });
  });
  afterAll(async () => {
    setTopupPayPal(undefined);
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    app.rateLimiter.reset();
    fake.clearFaults();
    setTopupPayPal(fake.client({ timeoutMs: 1_000 }));
  });

  const agent = () => request(app.server);
  const deps = (over: Partial<TopupDeps> = {}): TopupDeps => ({
    db: app.db,
    pp: fake.client({ timeoutMs: 1_000 }),
    config: app.config,
    ...over,
  });

  async function newBuyer() {
    const res = await agent()
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Acme', email: `b-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, cookie: cookiesOf(res) };
  }

  const startTopup = (
    cookie: string,
    body: object = { amountCents: 2000, method: 'PAYPAL_WALLET', saveForAutoTopup: false },
    key: string | null = randomUUID(),
  ) => {
    const r = agent().post('/api/buyer/topups').set('Origin', ORIGIN).set('Cookie', cookie);
    return (key === null ? r : r.set('Idempotency-Key', key)).send(body);
  };
  const capture = (cookie: string, id: string) =>
    agent()
      .post(`/api/buyer/topups/${id}/capture`)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({});
  const returnTo = (token: string, extra = '') =>
    agent().get(`/topups/return?token=${encodeURIComponent(token)}${extra}`);

  /** A $20 top-up the buyer has approved at PayPal. */
  async function approvedTopup(cookie: string) {
    const res = await startTopup(cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    fake.approve(res.body.orderId);
    return { topupId: res.body.topupId as string, orderId: res.body.orderId as string };
  }

  const capturesSent = (orderId: string) =>
    fake.calls.filter((c) => c.op === 'capture' && c.path.includes(`/${orderId}/`));

  async function topupTxns(topupId: string) {
    const { rows } = await app.db.pool.query(
      `SELECT id, kind FROM ledger_txns WHERE idempotency_key = $1`,
      [`topup:${topupId}`],
    );
    return rows;
  }
  async function auditRows(topupId: string, action: string) {
    const { rows } = await app.db.pool.query(
      `SELECT actor_type, paypal_id, data FROM audit_events WHERE entity_id = $1 AND action = $2`,
      [topupId, action],
    );
    return rows as {
      actor_type: string;
      paypal_id: string | null;
      data: Record<string, unknown>;
    }[];
  }

  it('wallet top-up $20: approve + capture → balance $20.00, one TOPUP txn, ids in audit', async () => {
    const buyer = await newBuyer();
    const created = await startTopup(buyer.cookie);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      topupId: expect.any(String),
      status: 'AWAITING_APPROVAL',
      orderId: expect.any(String),
      approveUrl: expect.stringMatching(/^https:\/\//),
      vaultRequested: false,
    });
    const { topupId, orderId } = created.body;
    // The order carries the top-up id as custom_id; its create used it as PayPal-Request-Id.
    expect(fake.order(orderId)).toMatchObject({ amountCents: 2000, customId: topupId });
    expect(
      fake.calls.filter((c) => c.op === 'order_create' && c.requestId === topupId),
    ).toHaveLength(1);

    fake.approve(orderId);
    const cap = await capture(buyer.cookie, topupId);
    expect(cap.status, JSON.stringify(cap.body)).toBe(200);
    expect(cap.body).toEqual({
      topupId,
      status: 'COMPLETED',
      balanceMicros: 20_000_000,
      captureId: expect.any(String),
    });
    expect(capturesSent(orderId).map((c) => c.requestId)).toEqual([`capture:${topupId}`]);

    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
    expect(await topupTxns(topupId)).toHaveLength(1);
    const row = await topupById(app.db, topupId);
    expect(row).toMatchObject({
      status: 'COMPLETED',
      paypalOrderId: orderId,
      paypalCaptureId: cap.body.captureId,
      paypalFeeCents: fakeFeeCents(2000),
      ledgerTxnId: expect.any(String),
      needsReconcile: false,
    });
    const [done] = await auditRows(topupId, 'TOPUP_COMPLETED');
    expect(done).toMatchObject({
      actor_type: 'BUYER',
      paypal_id: cap.body.captureId,
      data: { orderId, captureId: cap.body.captureId, amountCents: 2000 },
    });
    expect(await auditRows(topupId, 'TOPUP_CREATED')).toHaveLength(1);

    const list = await agent().get('/api/buyer/topups').set('Cookie', buyer.cookie);
    expect(list.body.topups).toEqual([
      expect.objectContaining({ topupId, status: 'COMPLETED', amountCents: 2000, orderId }),
    ]);
  });

  it('Idempotency-Key: required; double click (even racing) → same top-up and order', async () => {
    const buyer = await newBuyer();
    const none = await startTopup(buyer.cookie, undefined, null);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('VALIDATION_ERROR');

    const key = randomUUID();
    const clicks = await Promise.all([1, 2, 3].map(() => startTopup(buyer.cookie, undefined, key)));
    for (const c of clicks) expect(c.status, JSON.stringify(c.body)).toBe(201);
    const ids = new Set(clicks.map((c) => c.body.topupId));
    const orders = new Set(clicks.map((c) => c.body.orderId));
    expect(ids.size).toBe(1);
    expect(orders.size).toBe(1);
    expect(fake.orders().filter((o) => o.customId === [...ids][0])).toHaveLength(1);
    const { rows } = await app.db.pool.query(`SELECT id FROM topups WHERE buyer_id = $1`, [
      buyer.id,
    ]);
    expect(rows).toHaveLength(1);

    const again = await startTopup(buyer.cookie, undefined, key);
    expect(again.body).toMatchObject({ topupId: [...ids][0], status: 'AWAITING_APPROVAL' });

    const other = await startTopup(
      buyer.cookie,
      { amountCents: 5000, method: 'PAYPAL_WALLET', saveForAutoTopup: false },
      key,
    );
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('validates the amount ($5–$500) and the method', async () => {
    const buyer = await newBuyer();
    const ordersBefore = fake.orders().length;
    for (const body of [
      { amountCents: 499, method: 'PAYPAL_WALLET' },
      { amountCents: 50_001, method: 'PAYPAL_WALLET' },
      { amountCents: 20.5, method: 'PAYPAL_WALLET' },
      { amountCents: 2000, method: 'VAULT_MIT' },
      { amountCents: 2000, method: 'card' },
    ]) {
      const res = await startTopup(buyer.cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.orders()).toHaveLength(ordersBefore);
  });

  it('race: capture ×5 + return handler ×5 + poller in parallel → one capture, one TOPUP, +$20 once', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await approvedTopup(buyer.cookie);

    const poller = async () => {
      // SP-019's poller: GET the order and hand a completed capture to creditTopup.
      const order = await fake.client().getOrder(orderId);
      const r = topupResultOf(order);
      if (r.status !== 'COMPLETED') return null;
      return creditTopup(
        app.db,
        topupId,
        { ...r, currency: r.currency ?? null },
        { actorType: 'WORKFLOW' },
      );
    };
    const results = await Promise.all([
      ...[1, 2, 3, 4, 5].map(() => capture(buyer.cookie, topupId)),
      ...[1, 2, 3, 4, 5].map(() => returnTo(orderId)),
      poller(),
    ]);
    const captures = results.slice(0, 5) as request.Response[];
    const returns = results.slice(5, 10) as request.Response[];
    for (const c of captures) {
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      expect(c.body).toMatchObject({ status: 'COMPLETED' });
    }
    for (const r of returns) {
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe(`/buyers/topup/${topupId}?ok=1`);
    }
    expect(new Set(captures.map((c) => c.body.captureId)).size).toBe(1);
    expect(fake.captures(orderId)).toHaveLength(1);
    expect(await topupTxns(topupId)).toHaveLength(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
    expect(await auditRows(topupId, 'TOPUP_COMPLETED')).toHaveLength(1);

    // Replays after the fact change nothing.
    expect(await poller()).toMatchObject({ result: 'ALREADY_CREDITED' });
    const late = await capture(buyer.cookie, topupId);
    expect(late.body).toMatchObject({ status: 'COMPLETED', balanceMicros: 20_000_000 });
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
  });

  it('response lost after capture: the client retries capture:<id> → same capture, credited once', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await approvedTopup(buyer.cookie);
    setTopupPayPal(fake.client({ timeoutMs: 150 }));
    fake.failNext('capture', { kind: 'drop_response' });

    const cap = await capture(buyer.cookie, topupId);
    expect(cap.status, JSON.stringify(cap.body)).toBe(200);
    const sent = capturesSent(orderId);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((c) => c.requestId))).toEqual(new Set([`capture:${topupId}`]));
    expect(fake.captures(orderId)).toHaveLength(1);
    expect(cap.body.captureId).toBe(fake.captures(orderId)[0]!.id);
    expect(await topupTxns(topupId)).toHaveLength(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
  });

  it('response lost and no client retry left: 502, then the endpoint retry gets the same capture', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await approvedTopup(buyer.cookie);
    setTopupPayPal(fake.client({ timeoutMs: 150, retries: 0 }));
    fake.failNext('capture', { kind: 'drop_response' });

    const first = await capture(buyer.cookie, topupId);
    expect(first.status).toBe(502);
    expect(first.body.error).toMatchObject({ code: 'PAYPAL_ERROR', details: { retryable: true } });
    expect(fake.captures(orderId)).toHaveLength(1); // PayPal did capture
    expect(await topupTxns(topupId)).toHaveLength(0);
    expect((await topupById(app.db, topupId))?.status).toBe('AWAITING_APPROVAL');

    const retry = await capture(buyer.cookie, topupId);
    expect(retry.status).toBe(200);
    expect(retry.body.captureId).toBe(fake.captures(orderId)[0]!.id);
    expect(await topupTxns(topupId)).toHaveLength(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
  });

  it('capture PENDING → stays AWAITING_APPROVAL with pending_reason, no credit; later completion credits once', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await approvedTopup(buyer.cookie);
    fake.pendNextCapture('ECHECK');

    const cap = await capture(buyer.cookie, topupId);
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ topupId, status: 'AWAITING_APPROVAL', pendingReason: 'ECHECK' });
    expect(await topupTxns(topupId)).toHaveLength(0);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(0);
    expect(await topupById(app.db, topupId)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      pendingReason: 'ECHECK',
    });

    // PayPal settles it; the poller / webhook path credits it.
    fake.settleCapture(fake.captures(orderId)[0]!.id);
    const settled = topupResultOf(await fake.client().getOrder(orderId));
    const row = (await topupById(app.db, topupId))!;
    const outcome = await applyTopupResult(deps(), row, settled, { actorType: 'WORKFLOW' });
    expect(outcome).toMatchObject({ status: 'COMPLETED', balanceMicros: 20_000_000 });
    expect(await topupById(app.db, topupId)).toMatchObject({
      status: 'COMPLETED',
      pendingReason: null,
    });
    expect(await topupTxns(topupId)).toHaveLength(1);
  });

  it('declined capture → FAILED with error_code, 422 TOPUP_FAILED, audit, no ledger txn', async () => {
    const buyer = await newBuyer();
    const { topupId } = await approvedTopup(buyer.cookie);
    fake.failNext('capture', { kind: 'decline' });

    const cap = await capture(buyer.cookie, topupId);
    expect(cap.status).toBe(422);
    expect(cap.body.error).toMatchObject({ code: 'TOPUP_FAILED', details: { topupId } });
    const row = await topupById(app.db, topupId);
    expect(row?.status).toBe('FAILED');
    expect(row?.errorCode).toEqual(expect.any(String));
    expect(await topupTxns(topupId)).toHaveLength(0);
    expect(await auditRows(topupId, 'TOPUP_FAILED')).toHaveLength(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(0);

    // Retrying a failed top-up stays a 422 and doesn't call PayPal again.
    const before = fake.calls.length;
    expect((await capture(buyer.cookie, topupId)).status).toBe(422);
    expect(fake.calls.length).toBe(before);
  });

  it('a capture whose amount differs from the top-up → needs_reconcile, alert, no credit', async () => {
    const buyer = await newBuyer();
    const { topupId } = await approvedTopup(buyer.cookie);
    setTopupPayPal(fake.client({ fetch: amountRewritingFetch(fake, '19.00') }));

    const cap = await capture(buyer.cookie, topupId);
    expect(cap.status).toBe(409);
    expect(cap.body.error.details).toMatchObject({ topupId, needsReconcile: true });
    expect(await topupById(app.db, topupId)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      needsReconcile: true,
      paypalCaptureId: null,
    });
    expect(await topupTxns(topupId)).toHaveLength(0);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(0);
    const [alert] = await auditRows(topupId, 'ALERT');
    expect(alert?.data).toMatchObject({
      reason: 'AMOUNT_MISMATCH',
      expectedCents: 2000,
      capturedCents: 1900,
    });
  });

  it('a non-USD capture is never credited', async () => {
    const buyer = await newBuyer();
    const { topupId } = await approvedTopup(buyer.cookie);
    const out = await creditTopup(app.db, topupId, {
      captureId: 'CAP-EUR',
      amountCents: 2000,
      currency: 'EUR',
    });
    expect(out).toMatchObject({ result: 'MISMATCH', reason: 'CURRENCY_EUR' });
    expect(await topupTxns(topupId)).toHaveLength(0);
  });

  it("tenancy: buyer B capturing buyer A's top-up → 404, nothing captured", async () => {
    const a = await newBuyer();
    const b = await newBuyer();
    const { topupId, orderId } = await approvedTopup(a.cookie);
    const before = fake.calls.length;

    const res = await capture(b.cookie, topupId);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(fake.calls.length).toBe(before);
    expect(fake.captures(orderId)).toHaveLength(0);
    expect((await capture(b.cookie, 'not-a-uuid')).status).toBe(404);
    expect((await capture(b.cookie, randomUUID())).status).toBe(404);

    const listB = await agent().get(`/api/buyer/topups?buyerId=${a.id}`).set('Cookie', b.cookie);
    expect(listB.body.topups).toEqual([]);
    // Signed out → 401.
    expect((await capture('', topupId)).status).toBe(401);
    expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/buyer/topups',
      'POST /api/buyer/topups/:id/capture',
      'GET /api/buyer/topups',
      'GET /topups/return',
    ]);
  });

  it('a top-up ABANDONED by the sweep, then captured → credited once', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await approvedTopup(buyer.cookie);
    await app.db.pool.query(`UPDATE topups SET status = 'ABANDONED' WHERE id = $1`, [topupId]);

    const [one, two] = await Promise.all([returnTo(orderId), capture(buyer.cookie, topupId)]);
    expect(one.headers.location).toBe(`/buyers/topup/${topupId}?ok=1`);
    expect(two.status).toBe(200);
    expect(await topupById(app.db, topupId)).toMatchObject({ status: 'COMPLETED' });
    expect(await topupTxns(topupId)).toHaveLength(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
    const [done] = await auditRows(topupId, 'TOPUP_COMPLETED');
    expect(done?.data).toMatchObject({ priorStatus: 'ABANDONED' });
  });

  it('return handler: cancel leaves AWAITING_APPROVAL; unknown / missing token changes nothing', async () => {
    const buyer = await newBuyer();
    const created = await startTopup(buyer.cookie);
    const { topupId, orderId } = created.body;

    const cancelled = await agent().get(`/topups/return?cancelled=1&token=${orderId}`);
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.location).toBe(`/buyers/topup/${topupId}?cancelled=1`);
    expect((await topupById(app.db, topupId))?.status).toBe('AWAITING_APPROVAL');
    expect(capturesSent(orderId)).toHaveLength(0);

    // Returned without approving (e.g. a stale link) → error on the page, row untouched.
    const early = await returnTo(orderId);
    expect(early.headers.location).toBe(`/buyers/topup/${topupId}?error=STATE_CONFLICT`);
    expect((await topupById(app.db, topupId))?.status).toBe('AWAITING_APPROVAL');

    expect((await returnTo('NOPE123')).headers.location).toBe('/buyers/topup?error=UNKNOWN_ORDER');
    expect((await agent().get('/topups/return')).headers.location).toBe(
      '/buyers/topup?error=INVALID_RETURN',
    );
  });

  it('saveForAutoTopup sends wallet vault attributes only with PAYPAL_WALLET_VAULT=on; the vault id is saved', async () => {
    const buyer = await newBuyer();
    // Off (default): the box is ignored, no vault attributes.
    const off = await startTopup(buyer.cookie, {
      amountCents: 2000,
      method: 'PAYPAL_WALLET',
      saveForAutoTopup: true,
    });
    expect(off.body.vaultRequested).toBe(false);
    expect(fake.order(off.body.orderId)?.vaultRequested).toBe(false);

    const on = await createTopup(deps({ config: { ...app.config, PAYPAL_WALLET_VAULT: 'on' } }), {
      buyerId: buyer.id,
      idempotencyKey: randomUUID(),
      amountCents: 2000,
      method: 'PAYPAL_WALLET',
      saveForAutoTopup: true,
    });
    expect(on.vaultRequested).toBe(true);
    const orderId = on.topup.paypalOrderId!;
    expect(fake.order(orderId)?.vaultRequested).toBe(true);
    fake.approve(orderId);
    const cap = await capture(buyer.cookie, on.topup.id);
    expect(cap.status).toBe(200);
    const { rows } = await app.db.pool.query(
      `SELECT vault_id, vault_kind FROM buyers WHERE id = $1`,
      [buyer.id],
    );
    expect(rows[0]).toEqual({ vault_id: fake.order(orderId)!.vault!.id, vault_kind: 'PAYPAL' });
  });

  it('order create declined → FAILED, 422 TOPUP_FAILED; a transient failure keeps CREATED and the same key retries', async () => {
    const buyer = await newBuyer();
    fake.failNext('order_create', { kind: 'status', http: 422, issue: 'PAYEE_ACCOUNT_RESTRICTED' });
    const declined = await startTopup(buyer.cookie);
    expect(declined.status).toBe(422);
    expect(declined.body.error.code).toBe('TOPUP_FAILED');
    const failedId = declined.body.error.details.topupId as string;
    expect(await topupById(app.db, failedId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'PAYEE_ACCOUNT_RESTRICTED',
    });
    expect(await auditRows(failedId, 'TOPUP_FAILED')).toHaveLength(1);

    const key = randomUUID();
    fake.failNext('order_create', { kind: 'status', http: 503 }, 3);
    const flaky = await startTopup(buyer.cookie, undefined, key);
    expect(flaky.status).toBe(502);
    const flakyId = flaky.body.error.details.topupId as string;
    expect((await topupById(app.db, flakyId))?.status).toBe('CREATED');
    const retried = await startTopup(buyer.cookie, undefined, key);
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ topupId: flakyId, status: 'AWAITING_APPROVAL' });
  });

  it('creditTopup straight from a webhook-style capture: matches on custom_id, credits once', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await approvedTopup(buyer.cookie);
    // The capture landed at PayPal but our side never saw the answer; the webhook delivers it.
    const pp = fake.client();
    const cap = await pp.captureOrder(orderId, topupId);
    expect(cap.status).toBe('COMPLETED');
    if (cap.status !== 'COMPLETED') return;
    const facts = { ...cap, currency: cap.currency ?? null };
    const wrong = await creditTopup(app.db, topupId, { ...facts, customId: randomUUID() });
    expect(wrong).toMatchObject({ result: 'MISMATCH', reason: 'CUSTOM_ID_MISMATCH' });
    await app.db.pool.query(`UPDATE topups SET needs_reconcile = false WHERE id = $1`, [topupId]);

    const outs = await Promise.all(
      [1, 2, 3].map(() => creditTopup(app.db, topupId, facts, { actorType: 'PAYPAL_WEBHOOK' })),
    );
    expect(outs.filter((o) => o.result === 'CREDITED')).toHaveLength(1);
    expect(outs.filter((o) => o.result === 'ALREADY_CREDITED')).toHaveLength(2);
    expect(await topupTxns(topupId)).toHaveLength(1);
  });
});
