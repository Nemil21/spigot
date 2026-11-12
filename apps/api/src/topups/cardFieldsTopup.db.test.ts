import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { FakePayPal } from '../paypal/index.js';
import { cases } from '../security/tenancy/buyer-payment-method.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { balanceOf, setTopupPayPal } from './index.js';

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

/**
 * SP-063 card-fields top-up through the API on FakePayPal: `POST /api/buyer/topups` with
 * `method: 'CARD'` creates a numberless card order, the browser's card fields `submit(orderId)`
 * (`fake.submitCardFields`), then the capture endpoint credits once and vaults the card.
 */
describe.skipIf(!testDatabaseUrl)('SP-063 card-fields top-up (Postgres + FakePayPal)', () => {
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

  async function newBuyer() {
    const res = await agent()
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Card', email: `c-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, cookie: cookiesOf(res) };
  }

  const startCard = (cookie: string, key: string, body: object = {}) =>
    agent()
      .post('/api/buyer/topups')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send({ amountCents: 2000, method: 'CARD', saveForAutoTopup: true, ...body });
  const capture = (cookie: string, id: string) =>
    agent()
      .post(`/api/buyer/topups/${id}/capture`)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({});
  const savedMethod = (cookie: string) =>
    agent().get('/api/buyer/payment-method').set('Cookie', cookie);

  async function buyerRow(id: string) {
    const { rows } = await app.db.pool.query(
      `SELECT vault_id, vault_kind, vault_label FROM buyers WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function topupTxns(topupId: string) {
    const { rows } = await app.db.pool.query(
      `SELECT id FROM ledger_txns WHERE idempotency_key = $1`,
      [`topup:${topupId}`],
    );
    return rows;
  }

  it('$20 card top-up credits once and vaults the card (vault_kind=CARD, "Visa ••1111")', async () => {
    const buyer = await newBuyer();
    expect((await savedMethod(buyer.cookie)).body).toEqual({ savedMethod: null });

    const created = await startCard(buyer.cookie, randomUUID());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      status: 'AWAITING_APPROVAL',
      orderId: expect.any(String),
      amountCents: 2000,
      vaultRequested: true,
    });
    const { topupId, orderId } = created.body as { topupId: string; orderId: string };

    // What went to PayPal: a card source with vault ON_SUCCESS and no card number.
    expect(fake.order(orderId)).toMatchObject({
      source: 'card',
      rawCard: false,
      vaultRequested: true,
      customId: topupId,
      status: 'CREATED',
    });

    // Capture before the card fields submitted → 409, nothing credited.
    const early = await capture(buyer.cookie, topupId);
    expect(early.status).toBe(409);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(0);

    fake.submitCardFields(orderId, '4111111111111111');
    const done = await capture(buyer.cookie, topupId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', balanceMicros: 20_000_000 });

    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
    expect(await topupTxns(topupId)).toHaveLength(1);
    expect(await buyerRow(buyer.id)).toMatchObject({
      vault_id: fake.order(orderId)!.vault!.id,
      vault_kind: 'CARD',
      vault_label: 'Visa ••1111',
    });
    const list = await agent().get('/api/buyer/topups').set('Cookie', buyer.cookie);
    expect(list.body.topups[0]).toMatchObject({ topupId, method: 'CARD', status: 'COMPLETED' });

    const method = await savedMethod(buyer.cookie);
    expect(method.status).toBe(200);
    expect(method.body).toEqual({ savedMethod: { kind: 'CARD', label: 'Visa ••1111' } });
    expect(JSON.stringify(method.body)).not.toContain(fake.order(orderId)!.vault!.id);
  });

  it('race: double submit (same Idempotency-Key ×6 in parallel) → one top-up, one order; captures ×6 → one credit', async () => {
    const buyer = await newBuyer();
    const key = randomUUID();
    const ordersBefore = fake.orders().length;
    const creates = await Promise.all(
      Array.from({ length: 6 }, () => startCard(buyer.cookie, key)),
    );
    for (const r of creates) expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(new Set(creates.map((r) => r.body.topupId)).size).toBe(1);
    expect(new Set(creates.map((r) => r.body.orderId)).size).toBe(1);
    // The no-number card create replayed at PayPal with the same request id: one order.
    expect(fake.orders().length - ordersBefore).toBe(1);
    const { topupId, orderId } = creates[0]!.body as { topupId: string; orderId: string };

    fake.submitCardFields(orderId);
    const captures = await Promise.all(
      Array.from({ length: 6 }, () => capture(buyer.cookie, topupId)),
    );
    for (const r of captures) {
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.status).toBe('COMPLETED');
    }
    expect(fake.captures(orderId)).toHaveLength(1);
    expect(await topupTxns(topupId)).toHaveLength(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);

    // A replay of the create after completion returns the finished top-up, no new order.
    const again = await startCard(buyer.cookie, key);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ topupId, status: 'COMPLETED' });
    expect(fake.orders().length - ordersBefore).toBe(1);
  });

  it('a lost create response is retried with the same request id → still one order', async () => {
    const buyer = await newBuyer();
    const key = randomUUID();
    const ordersBefore = fake.orders().length;
    fake.failNext('order_create', { kind: 'drop_response' });
    const first = await startCard(buyer.cookie, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.status).toBe('AWAITING_APPROVAL');
    expect(fake.orders().length - ordersBefore).toBe(1);
  });

  it('saveForAutoTopup=false: captured and credited, card not vaulted', async () => {
    const buyer = await newBuyer();
    const created = await startCard(buyer.cookie, randomUUID(), {
      amountCents: 500,
      saveForAutoTopup: false,
    });
    expect(created.body.vaultRequested).toBe(false);
    fake.submitCardFields(created.body.orderId, '5555555555554444');
    const done = await capture(buyer.cookie, created.body.topupId);
    expect(done.body.status).toBe('COMPLETED');
    expect(await buyerRow(buyer.id)).toMatchObject({ vault_id: null, vault_kind: null });
    expect((await savedMethod(buyer.cookie)).body).toEqual({ savedMethod: null });
  });

  it('same Idempotency-Key for a wallet and then a card top-up → 409 IDEMPOTENCY_MISMATCH', async () => {
    const buyer = await newBuyer();
    const key = randomUUID();
    const wallet = await startCard(buyer.cookie, key, { method: 'PAYPAL_WALLET' });
    expect(wallet.status).toBe(201);
    const card = await startCard(buyer.cookie, key);
    expect(card.status).toBe(409);
    expect(card.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('tenancy: payment-method is per session; no session → 401', async () => {
    expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/buyer/payment-method']);
    const a = await newBuyer();
    const b = await newBuyer();
    const created = await startCard(a.cookie, randomUUID());
    fake.submitCardFields(created.body.orderId);
    await capture(a.cookie, created.body.topupId);

    expect((await savedMethod(a.cookie)).body.savedMethod).toMatchObject({ kind: 'CARD' });
    const asB = await agent()
      .get(`/api/buyer/payment-method?buyerId=${a.id}`)
      .set('Cookie', b.cookie);
    expect(asB.body).toEqual({ savedMethod: null });
    expect((await agent().get('/api/buyer/payment-method')).status).toBe(401);
  });
});
