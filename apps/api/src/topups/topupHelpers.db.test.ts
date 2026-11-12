import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { ApiError } from '../http/errors.js';
import { FakePayPal } from '../paypal/index.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import {
  balanceOf,
  createTopupForAgent,
  nextSimTestCard,
  serverCardTopup,
  setTopupPayPal,
  SIM_TEST_CARDS,
  topupById,
  type TopupDeps,
} from './index.js';

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

/** Wraps the fake's fetch to keep every order-create request body (to check the return URL). */
function recordingFetch(fake: FakePayPal, bodies: Record<string, unknown>[]): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === '/v2/checkout/orders' && typeof init?.body === 'string') {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return fake.fetch(input, init);
  };
}

describe.skipIf(!testDatabaseUrl)('SP-018b top-up helpers (Postgres + FakePayPal)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPal;
  const createBodies: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logger: false },
    );
    await app.ready();
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

  const deps = (over: Partial<TopupDeps> = {}): TopupDeps => ({
    db: app.db,
    pp: fake.client({ timeoutMs: 1_000, fetch: recordingFetch(fake, createBodies) }),
    config: app.config,
    ...over,
  });

  async function newBuyer(): Promise<string> {
    const res = await request(app.server)
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'SIM', email: `sim-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return res.body.buyerId as string;
  }

  const createsFor = (f: FakePayPal, topupId: string) =>
    f.calls.filter((c) => c.op === 'order_create' && c.requestId === topupId);
  const ordersFor = (f: FakePayPal, topupId: string) =>
    f.orders().filter((o) => o.customId === topupId);

  async function topupTxns(topupId: string) {
    const { rows } = await app.db.pool.query<{ id: string; is_simulated: boolean }>(
      `SELECT id, is_simulated FROM ledger_txns WHERE kind = 'TOPUP' AND idempotency_key = $1`,
      [`topup:${topupId}`],
    );
    return rows;
  }
  async function topupCount(buyerId: string): Promise<number> {
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM topups WHERE buyer_id = $1`,
      [buyerId],
    );
    return rows[0]!.n;
  }
  async function alerts(topupId: string) {
    const { rows } = await app.db.pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'ALERT'`,
      [topupId],
    );
    return rows.map((r) => r.data);
  }

  describe('serverCardTopup (SIM)', () => {
    it('$20 SIM card top-up captures at create and credits once (vaulted, simulated txn)', async () => {
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const out = await serverCardTopup(deps(), {
        topupId,
        buyerId,
        amountCents: 2000,
        trigger: 'SIM',
      });
      expect(out).toMatchObject({ status: 'COMPLETED', created: true, balanceMicros: 20_000_000 });

      const [order] = ordersFor(fake, topupId);
      expect(ordersFor(fake, topupId)).toHaveLength(1);
      expect(order).toMatchObject({ amountCents: 2000, rawCard: true, vaultRequested: true });
      expect(fake.captures(order!.id)).toHaveLength(1);

      expect(await topupById(app.db, topupId)).toMatchObject({
        status: 'COMPLETED',
        method: 'CARD',
        trigger: 'SIM',
        paypalOrderId: order!.id,
        paypalCaptureId: expect.any(String),
        needsReconcile: false,
      });
      const txns = await topupTxns(topupId);
      expect(txns).toHaveLength(1);
      expect(txns[0]!.is_simulated).toBe(true);
      expect(await balanceOf(app.db.pool, buyerId)).toBe(20_000_000);
      const { rows } = await app.db.pool.query(
        `SELECT vault_id, vault_kind FROM buyers WHERE id = $1`,
        [buyerId],
      );
      expect(rows[0]).toMatchObject({ vault_id: expect.any(String), vault_kind: 'CARD' });
    });

    it('same topupId twice → one PayPal order, credited once', async () => {
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const input = { topupId, buyerId, amountCents: 2500, trigger: 'SIM' as const };
      const first = await serverCardTopup(deps(), input);
      const second = await serverCardTopup(deps(), input);
      expect(first).toMatchObject({ status: 'COMPLETED', created: true });
      expect(second).toMatchObject({ status: 'COMPLETED', created: false });
      expect(createsFor(fake, topupId)).toHaveLength(1);
      expect(ordersFor(fake, topupId)).toHaveLength(1);
      expect(await topupTxns(topupId)).toHaveLength(1);
      expect(await balanceOf(app.db.pool, buyerId)).toBe(25_000_000);
    });

    it('10 parallel calls with the same topupId → one order, one TOPUP txn', async () => {
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const input = { topupId, buyerId, amountCents: 3000, trigger: 'SIM' as const };
      const outs = await Promise.all(
        Array.from({ length: 10 }, () => serverCardTopup(deps(), input)),
      );

      expect(outs.filter((o) => o.created)).toHaveLength(1);
      expect(outs.find((o) => o.created)).toMatchObject({ status: 'COMPLETED' });
      for (const o of outs) expect(['COMPLETED', 'IN_FLIGHT']).toContain(o.status);
      expect(createsFor(fake, topupId)).toHaveLength(1);
      expect(ordersFor(fake, topupId)).toHaveLength(1);
      expect(await topupTxns(topupId)).toHaveLength(1);
      expect(await topupCount(buyerId)).toBe(1);
      expect(await balanceOf(app.db.pool, buyerId)).toBe(30_000_000);

      // Once the dust settles every caller sees it done, still without a new order.
      const again = await serverCardTopup(deps(), input);
      expect(again).toMatchObject({ status: 'COMPLETED', created: false });
      expect(createsFor(fake, topupId)).toHaveLength(1);
    });

    it('raw-card replay refused with TRANSACTION_REFUSED → needs_reconcile, never a second row or order', async () => {
      // S7: the first create's response is lost after PayPal did the work; the client retries with
      // the same PayPal-Request-Id and a raw-card replay is refused with 422 TRANSACTION_REFUSED.
      const refusing = new FakePayPal({ latencyMs: 2, rawCardReplay: 'refuse' });
      refusing.failNext('order_create', { kind: 'drop_response' });
      const pp = refusing.client({ timeoutMs: 100 });
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const input = { topupId, buyerId, amountCents: 2000, trigger: 'SIM' as const };

      const out = await serverCardTopup(deps({ pp }), input);
      expect(out).toMatchObject({
        status: 'NEEDS_RECONCILE',
        created: true,
        code: 'TRANSACTION_REFUSED',
      });
      expect(await topupById(app.db, topupId)).toMatchObject({
        status: 'CREATED',
        needsReconcile: true,
        paypalOrderId: null,
        errorCode: 'TRANSACTION_REFUSED',
      });
      expect(await alerts(topupId)).toEqual([
        expect.objectContaining({
          alert: 'SIM_TOPUP_NEEDS_RECONCILE',
          code: 'TRANSACTION_REFUSED',
        }),
      ]);
      // PayPal made exactly one order (the lost one); we made one row and credited nothing.
      expect(ordersFor(refusing, topupId)).toHaveLength(1);
      expect(await topupCount(buyerId)).toBe(1);
      expect(await topupTxns(topupId)).toHaveLength(0);
      expect(await balanceOf(app.db.pool, buyerId)).toBe(0);

      // A re-run doesn't call PayPal again.
      const creates = createsFor(refusing, topupId).length;
      const again = await serverCardTopup(deps({ pp }), input);
      expect(again).toMatchObject({ status: 'NEEDS_RECONCILE', created: false });
      expect(createsFor(refusing, topupId)).toHaveLength(creates);
      expect(ordersFor(refusing, topupId)).toHaveLength(1);
      expect(await topupCount(buyerId)).toBe(1);
    });

    it('PayPal unreachable on create → needs_reconcile, not retried with a new order', async () => {
      fake.failNext('order_create', { kind: 'status', http: 503 }, 3);
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const input = { topupId, buyerId, amountCents: 2000, trigger: 'SIM' as const };
      const out = await serverCardTopup(deps(), input);
      expect(out).toMatchObject({ status: 'NEEDS_RECONCILE', created: true });
      expect(await topupById(app.db, topupId)).toMatchObject({ needsReconcile: true });
      const again = await serverCardTopup(deps(), input);
      expect(again.status).toBe('NEEDS_RECONCILE');
      expect(ordersFor(fake, topupId)).toHaveLength(0);
      expect(await topupCount(buyerId)).toBe(1);
    });

    it('existing CREATED row with an order id → GET the order and credit, no new order', async () => {
      // The winner created and captured at PayPal and stored the order id, then died before credit.
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const created = await fake.client().createTopupOrder({
        topupId,
        amountCents: 2000,
        source: { kind: 'card', card: SIM_TEST_CARDS[0]! },
      });
      expect(created.status).toBe('COMPLETED');
      await app.db.pool.query(
        `INSERT INTO topups (id, buyer_id, amount_cents, method, trigger, paypal_order_id)
         VALUES ($1, $2, 2000, 'CARD', 'SIM', $3)`,
        [topupId, buyerId, created.orderId],
      );
      const creates = createsFor(fake, topupId).length;

      const outs = await Promise.all(
        Array.from({ length: 5 }, () =>
          serverCardTopup(deps(), { topupId, buyerId, amountCents: 2000, trigger: 'SIM' }),
        ),
      );
      for (const o of outs) expect(o).toMatchObject({ status: 'COMPLETED', created: false });
      expect(createsFor(fake, topupId)).toHaveLength(creates);
      expect(
        fake.calls.some((c) => c.op === 'get_order' && c.path.includes(created.orderId!)),
      ).toBe(true);
      expect(await topupTxns(topupId)).toHaveLength(1);
      expect(await balanceOf(app.db.pool, buyerId)).toBe(20_000_000);
    });

    it('existing CREATED row without an order id: IN_FLIGHT when fresh, needs_reconcile after 5 min', async () => {
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const input = { topupId, buyerId, amountCents: 2000, trigger: 'SIM' as const };
      await app.db.pool.query(
        `INSERT INTO topups (id, buyer_id, amount_cents, method, trigger) VALUES ($1, $2, 2000, 'CARD', 'SIM')`,
        [topupId, buyerId],
      );
      expect(await serverCardTopup(deps(), input)).toMatchObject({ status: 'IN_FLIGHT' });
      expect(await topupById(app.db, topupId)).toMatchObject({ needsReconcile: false });

      await app.db.pool.query(
        `UPDATE topups SET created_at = now() - interval '6 minutes' WHERE id = $1`,
        [topupId],
      );
      expect(await serverCardTopup(deps(), input)).toMatchObject({
        status: 'NEEDS_RECONCILE',
        code: 'SIM_CREATE_STALE',
      });
      expect(await topupById(app.db, topupId)).toMatchObject({
        status: 'CREATED',
        needsReconcile: true,
      });
      expect(createsFor(fake, topupId)).toHaveLength(0);
      expect(await alerts(topupId)).toHaveLength(1);
    });

    it('declined card → FAILED, no credit; a re-run reports FAILED without PayPal', async () => {
      fake.failNext('order_create', { kind: 'decline' });
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const input = { topupId, buyerId, amountCents: 2000, trigger: 'SIM' as const };
      const out = await serverCardTopup(deps(), input);
      expect(out).toMatchObject({ status: 'FAILED', created: true });
      expect(await topupById(app.db, topupId)).toMatchObject({ status: 'FAILED' });
      const creates = createsFor(fake, topupId).length;
      expect(await serverCardTopup(deps(), input)).toMatchObject({
        status: 'FAILED',
        created: false,
      });
      expect(createsFor(fake, topupId)).toHaveLength(creates);
      expect(await topupTxns(topupId)).toHaveLength(0);
    });

    it('a topupId reused for another buyer or amount → IDEMPOTENCY_MISMATCH, row untouched', async () => {
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      await serverCardTopup(deps(), { topupId, buyerId, amountCents: 2000, trigger: 'SIM' });
      await expect(
        serverCardTopup(deps(), { topupId, buyerId, amountCents: 5000, trigger: 'SIM' }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
      const other = await newBuyer();
      await expect(
        serverCardTopup(deps(), { topupId, buyerId: other, amountCents: 2000, trigger: 'SIM' }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(await balanceOf(app.db.pool, other)).toBe(0);
      expect(createsFor(fake, topupId)).toHaveLength(1);
    });

    it('refuses a live PayPal config before inserting anything', async () => {
      const buyerId = await newBuyer();
      const topupId = randomUUID();
      const live = { ...app.config, PAYPAL_MODE: 'sandbox' as const, paypalIsSandbox: false };
      await expect(
        serverCardTopup(deps({ config: live }), {
          topupId,
          buyerId,
          amountCents: 2000,
          trigger: 'SIM',
        }),
      ).rejects.toThrow(/sandbox/);
      expect(await topupById(app.db, topupId)).toBeNull();
    });

    it('round-robins over the working test cards, never 5105…5100', () => {
      const seen = new Set(Array.from({ length: 8 }, () => nextSimTestCard().number));
      expect(seen.size).toBe(SIM_TEST_CARDS.length);
      expect(seen.has('5105105105105100')).toBe(false);
    });
  });

  describe('createTopupForAgent (MCP approval link)', () => {
    it('returns a sandbox approve URL; approving + /topups/return credits once', async () => {
      const buyerId = await newBuyer();
      const key = randomUUID();
      const before = createBodies.length;
      const t = await createTopupForAgent(deps(), buyerId, 2000, key);
      expect(t).toMatchObject({
        status: 'AWAITING_APPROVAL',
        topupId: expect.any(String),
        orderId: expect.any(String),
        approveUrl: expect.stringMatching(/^https:\/\//),
        amountCents: 2000,
      });
      expect(t.topup).toMatchObject({
        trigger: 'MCP',
        method: 'PAYPAL_WALLET',
        idempotencyKey: `mcp:${key}`,
      });
      // Wallet order, no vault yet, returning to /topups/return.
      const body = createBodies.slice(before).at(-1) as {
        payment_source: {
          paypal: { experience_context: Record<string, string>; attributes?: unknown };
        };
      };
      const ctx = body.payment_source.paypal.experience_context;
      expect(ctx.return_url).toBe(`${ORIGIN.replace(/\/+$/, '')}/topups/return`);
      expect(body.payment_source.paypal.attributes).toBeUndefined();

      // A retried tool call (same key) → same top-up, same order, same link.
      const again = await createTopupForAgent(deps(), buyerId, 2000, key);
      expect(again).toMatchObject({
        topupId: t.topupId,
        orderId: t.orderId,
        approveUrl: t.approveUrl,
      });
      expect(ordersFor(fake, t.topupId)).toHaveLength(1);

      // The human approves at PayPal; the return URL is hit three times (refresh / double tab).
      fake.approve(t.orderId!);
      const returns = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(app.server).get(`/topups/return?token=${encodeURIComponent(t.orderId!)}`),
        ),
      );
      for (const r of returns) {
        expect(r.status).toBe(302);
        expect(r.headers.location).toMatch(/\?ok=1$/);
      }
      expect(await topupTxns(t.topupId)).toHaveLength(1);
      expect(await balanceOf(app.db.pool, buyerId)).toBe(20_000_000);
      expect(await topupById(app.db, t.topupId)).toMatchObject({ status: 'COMPLETED' });
    });

    it('agent keys never collide with W11 keys for the same buyer', async () => {
      const buyerId = await newBuyer();
      const key = randomUUID();
      // Same raw key used by the buyer's portal and their agent → two distinct top-ups.
      await app.db.pool.query(
        `INSERT INTO topups (buyer_id, amount_cents, method, trigger, idempotency_key)
         VALUES ($1, 2000, 'PAYPAL_WALLET', 'MANUAL', $2)`,
        [buyerId, key],
      );
      const t = await createTopupForAgent(deps(), buyerId, 2000, key);
      expect(t.topup.trigger).toBe('MCP');
      expect(await topupCount(buyerId)).toBe(2);
    });

    it('rejects an amount outside $5–$500 and an empty key', async () => {
      const buyerId = await newBuyer();
      await expect(createTopupForAgent(deps(), buyerId, 499, 'k')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      await expect(createTopupForAgent(deps(), buyerId, 50_001, 'k')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      await expect(createTopupForAgent(deps(), buyerId, 2000, ' ')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(await topupCount(buyerId)).toBe(0);
    });
  });
});
