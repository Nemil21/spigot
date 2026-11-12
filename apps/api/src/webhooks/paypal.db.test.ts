import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { createDb, createPool } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import job from '../jobs/webhook-process.job.js';
import { pollOpenTopups } from '../jobs/topupPoller.js';
import { centsToDecimal, FakePayPal } from '../paypal/index.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { balanceOf, setTopupPayPal, topupById } from '../topups/index.js';
import { setWebhookDeps } from './deps.js';
import {
  loadWebhookHandlers,
  processPendingWebhooks,
  type WebhookContext,
  type WebhookHandler,
} from './paypal.js';

/**
 * SP-059 on Postgres + FakePayPal's verifier: raw-body verification, dedupe, durable processing
 * (crash after insert / handler failure), unknown and dispute events, and the top-up race
 * (webhook + capture endpoint + poller → one TOPUP txn). Payout events: `payouts.db.test.ts`.
 */

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const quiet = () => {};

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-059 PayPal webhooks (Postgres + FakePayPal)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPal;
  let handlers: WebhookHandler[];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logger: false },
    );
    await app.ready();
    fake = new FakePayPal({ latencyMs: 5, jitterMs: 10 });
    handlers = await loadWebhookHandlers();
  });
  afterAll(async () => {
    setTopupPayPal(undefined);
    setWebhookDeps();
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    app.rateLimiter.reset();
    fake.clearFaults();
    fake.extras.clearFaults();
    setTopupPayPal(fake.client({ timeoutMs: 1_000 }));
    setWebhookDeps({ verifier: fake.client({ timeoutMs: 1_000 }) });
  });

  const agent = () => request(app.server);
  const ctx = (over: Partial<WebhookContext> = {}): WebhookContext => ({
    db: app.db,
    pp: fake.client({ timeoutMs: 1_000 }),
    config: app.config,
    log: quiet,
    ...over,
  });
  const drain = (c: WebhookContext = ctx(), extra: WebhookHandler[] = []) =>
    processPendingWebhooks(c, { handlers: [...handlers, ...extra] });

  const deliver = (d: { rawBody: string; headers: Record<string, string> }) =>
    agent().post('/webhooks/paypal').set(d.headers).send(d.rawBody);

  async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return (await app.db.pool.query(sql, params)).rows as T[];
  }
  const eventRow = async (id: string) =>
    (
      await q<{ id: string; processed_at: Date | null; verified: boolean; event_type: string }>(
        `SELECT id, processed_at, verified, event_type FROM webhook_events WHERE id = $1`,
        [id],
      )
    )[0];
  const topupTxns = async (topupId: string) =>
    (await q(`SELECT id FROM ledger_txns WHERE idempotency_key = $1`, [`topup:${topupId}`])).length;

  async function newBuyer() {
    const res = await agent()
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Acme', email: `b-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, cookie: cookiesOf(res) };
  }

  /** A $20 wallet top-up the buyer has approved at PayPal (not captured yet). */
  async function approvedTopup() {
    const buyer = await newBuyer();
    const res = await agent()
      .post('/api/buyer/topups')
      .set('Origin', ORIGIN)
      .set('Cookie', buyer.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 2000, method: 'PAYPAL_WALLET', saveForAutoTopup: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    fake.approve(res.body.orderId);
    return {
      buyer,
      topupId: res.body.topupId as string,
      orderId: res.body.orderId as string,
    };
  }

  /** PayPal's `PAYMENT.CAPTURE.COMPLETED` resource for a fake capture. */
  function captureResource(orderId: string) {
    const c = fake.captures(orderId)[0]!;
    return {
      id: c.id,
      status: c.status,
      amount: { currency_code: 'USD', value: centsToDecimal(c.amountCents) },
      final_capture: true,
      custom_id: c.customId,
      seller_receivable_breakdown: {
        gross_amount: { currency_code: 'USD', value: centsToDecimal(c.amountCents) },
        paypal_fee: { currency_code: 'USD', value: centsToDecimal(c.feeCents) },
      },
      supplementary_data: { related_ids: { order_id: orderId } },
    };
  }

  /** PayPal's `CHECKOUT.ORDER.APPROVED` resource. */
  const approvedResource = (orderId: string, topupId: string) => ({
    id: orderId,
    intent: 'CAPTURE',
    status: 'APPROVED',
    purchase_units: [{ reference_id: 'default', custom_id: topupId }],
  });

  // ------------------------------------------------------------------ verify + store

  it('bad signature → 401 and nothing stored; missing headers → 401', async () => {
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-X', status: 'COMPLETED' });
    const tampered = await deliver({ ...d, rawBody: d.rawBody.replace('CAP-X', 'CAP-Y') });
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('UNAUTHENTICATED');

    const unsigned = await agent()
      .post('/webhooks/paypal')
      .set('content-type', 'application/json')
      .send(d.rawBody);
    expect(unsigned.status).toBe(401);
    expect(await eventRow(d.event.id)).toBeUndefined();
  });

  it('verifies the raw body: pretty-printed JSON passes; the same event re-serialised does not', async () => {
    const d = fake.emitWebhook(
      'PAYMENT.CAPTURE.COMPLETED',
      { id: 'CAP-PRETTY', status: 'COMPLETED' },
      { spacing: 2 },
    );
    const reserialised = await deliver({ ...d, rawBody: JSON.stringify(JSON.parse(d.rawBody)) });
    expect(reserialised.status).toBe(401);
    expect(await eventRow(d.event.id)).toBeUndefined();

    const res = await deliver(d);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: false });
    expect(await eventRow(d.event.id)).toMatchObject({
      verified: true,
      processed_at: null,
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
    });
  });

  it('verification unavailable (PayPal 503) → 502 so PayPal redelivers; nothing stored', async () => {
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-503' });
    fake.extras.failNext('verify_webhook', { kind: 'status', http: 503 });
    const res = await deliver(d);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYPAL_ERROR');
    expect(await eventRow(d.event.id)).toBeUndefined();
  });

  // ------------------------------------------------------------------ dedupe + durability

  it('same event delivered twice → stored once, processed once (one TOPUP txn)', async () => {
    const t = await approvedTopup();
    // Our capture call reached PayPal, but its credit never landed (crash).
    await fake.client().captureOrder(t.orderId, t.topupId);
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', captureResource(t.orderId));

    const [first, second] = [await deliver(d), await deliver(d)];
    expect(first.body).toEqual({ received: true, duplicate: false });
    expect(second.body).toEqual({ received: true, duplicate: true });
    expect((await q(`SELECT 1 FROM webhook_events WHERE id = $1`, [d.event.id])).length).toBe(1);

    const r = await drain();
    expect(r.processed.find((p) => p.id === d.event.id)?.results).toEqual({
      topups: 'CREDITED',
    });
    // A redelivery after processing is skipped too, and a later pass finds nothing to do.
    expect((await deliver(d)).body.duplicate).toBe(true);
    expect((await drain()).processed).toEqual([]);

    expect(await topupTxns(t.topupId)).toBe(1);
    expect(await balanceOf(app.db.pool, t.buyer.id)).toBe(20_000_000);
    expect(await topupById(app.db, t.topupId)).toMatchObject({
      status: 'COMPLETED',
      paypalCaptureId: fake.captures(t.orderId)[0]!.id,
    });
    const [audit] = await q<{ actor_type: string; actor_id: string; paypal_id: string }>(
      `SELECT actor_type, actor_id, paypal_id FROM audit_events
        WHERE entity_id = $1 AND action = 'TOPUP_COMPLETED'`,
      [t.topupId],
    );
    expect(audit).toEqual({
      actor_type: 'PAYPAL_WEBHOOK',
      actor_id: d.event.id,
      paypal_id: fake.captures(t.orderId)[0]!.id,
    });
    expect((await eventRow(d.event.id))!.processed_at).toBeInstanceOf(Date);
  });

  it('process killed right after the insert → processed on restart, exactly once', async () => {
    const t = await approvedTopup();
    await fake.client().captureOrder(t.orderId, t.topupId);
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', captureResource(t.orderId));
    // The API stores the event and answers 200; it "dies" before any processing.
    expect((await deliver(d)).status).toBe(200);
    expect(await topupTxns(t.topupId)).toBe(0);

    // PayPal redelivers while we're down/restarting: the dedupe row blocks it.
    expect((await deliver(d)).body.duplicate).toBe(true);

    // The restarted process (its own pool) runs the job: processed once.
    const pool = createPool(db.url, { max: 3, applicationName: 'restarted' });
    try {
      const restarted = ctx({ db: createDb(pool) });
      const [a, b] = await Promise.all([drain(restarted), drain(restarted)]);
      const mine = [...a.processed, ...b.processed].filter((p) => p.id === d.event.id);
      expect(mine).toHaveLength(1);
      expect((await drain(restarted)).processed).toEqual([]);
    } finally {
      await pool.end();
    }
    expect(await topupTxns(t.topupId)).toBe(1);
    expect(await balanceOf(app.db.pool, t.buyer.id)).toBe(20_000_000);
  });

  it('a handler that throws mid-event rolls the whole event back; the next pass processes it once', async () => {
    const t = await approvedTopup();
    await fake.client().captureOrder(t.orderId, t.topupId);
    const d = fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', captureResource(t.orderId));
    await deliver(d);

    // `topups` credits first (file order), then this one dies: the credit must roll back with it.
    const crash: WebhookHandler = {
      name: 'zz-crash',
      eventTypes: ['PAYMENT.CAPTURE.COMPLETED'],
      handle: async () => {
        throw new Error('process died');
      },
    };
    const failed = await drain(ctx(), [crash]);
    expect(failed.failed).toEqual([{ id: d.event.id, error: 'process died' }]);
    expect(await topupTxns(t.topupId)).toBe(0);
    expect((await topupById(app.db, t.topupId))!.status).toBe('AWAITING_APPROVAL');
    expect((await eventRow(d.event.id))!.processed_at).toBeNull();

    const ok = await drain();
    expect(ok.processed.map((p) => p.id)).toContain(d.event.id);
    expect(await topupTxns(t.topupId)).toBe(1);
  });

  it('the webhook-process job drains the queue (5 s, off under vitest until deps are set)', async () => {
    expect(job).toMatchObject({ name: 'webhooks.process', everyMs: 5_000 });
    const d = fake.emitWebhook('PAYMENT.SALE.COMPLETED', { id: 'SALE-1' });
    await deliver(d);
    await job.run(); // jobs off: nothing happens
    expect((await eventRow(d.event.id))!.processed_at).toBeNull();
    setWebhookDeps({ verifier: fake.client(), job: ctx() });
    await job.run();
    expect((await eventRow(d.event.id))!.processed_at).toBeInstanceOf(Date);
  });

  // ------------------------------------------------------------------ other events

  it('unknown event type → processed with a WEBHOOK_UNHANDLED audit row', async () => {
    const d = fake.emitWebhook('BILLING.SUBSCRIPTION.CREATED', { id: 'I-SUB1' });
    await deliver(d);
    const r = await drain();
    expect(r.processed.find((p) => p.id === d.event.id)?.results).toEqual({});
    expect(
      await q(
        `SELECT actor_type, actor_id, action, paypal_id FROM audit_events
          WHERE actor_id = $1 AND action = 'WEBHOOK_UNHANDLED'`,
        [d.event.id],
      ),
    ).toEqual([
      {
        actor_type: 'PAYPAL_WEBHOOK',
        actor_id: d.event.id,
        action: 'WEBHOOK_UNHANDLED',
        paypal_id: 'I-SUB1',
      },
    ]);
  });

  it('CUSTOMER.DISPUTE.CREATED → audit only, naming our top-up', async () => {
    const t = await approvedTopup();
    await fake.client().captureOrder(t.orderId, t.topupId);
    const cap = fake.captures(t.orderId)[0]!;
    await deliver(fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', captureResource(t.orderId)));
    await drain();
    const d = fake.emitWebhook('CUSTOMER.DISPUTE.CREATED', {
      dispute_id: 'PP-D-1',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'OPEN',
      disputed_transactions: [{ seller_transaction_id: cap.id }],
      dispute_amount: { currency_code: 'USD', value: '20.00' },
    });
    await deliver(d);
    await drain();
    const rows = await q<{ entity_id: string; paypal_id: string; data: Record<string, unknown> }>(
      `SELECT entity_id, paypal_id, data FROM audit_events WHERE action = 'DISPUTE_CREATED' AND actor_id = $1`,
      [d.event.id],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        entity_id: t.topupId,
        paypal_id: 'PP-D-1',
        data: expect.objectContaining({ captureIds: [cap.id], buyerId: t.buyer.id }),
      }),
    ]);
    // Nothing else changed: the top-up stays credited.
    expect(await balanceOf(app.db.pool, t.buyer.id)).toBe(20_000_000);
  });

  it('PAYMENT.CAPTURE.DENIED on a held wallet capture → FAILED with an audit row; replay changes nothing', async () => {
    const t = await approvedTopup();
    fake.pendNextCapture('PENDING_REVIEW');
    await agent()
      .post(`/api/buyer/topups/${t.topupId}/capture`)
      .set('Origin', ORIGIN)
      .set('Cookie', t.buyer.cookie)
      .send({});
    expect((await topupById(app.db, t.topupId))!.pendingReason).toBe('PENDING_REVIEW');
    const cap = fake.captures(t.orderId)[0]!;
    const resource = { ...captureResource(t.orderId), status: 'DECLINED' };
    await deliver(fake.emitWebhook('PAYMENT.CAPTURE.DENIED', resource));
    await deliver(fake.emitWebhook('PAYMENT.CAPTURE.DENIED', resource)); // new event id, same fact
    const r = await drain();
    expect(r.processed.map((p) => p.results)).toEqual([
      { 'auto-topup': 'SKIPPED', topups: 'FAILED' },
      { 'auto-topup': 'SKIPPED', topups: 'NOT_OPEN' },
    ]);
    expect(await topupById(app.db, t.topupId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'CAPTURE_DENIED',
    });
    const failed = await q(
      `SELECT paypal_id FROM audit_events WHERE entity_id = $1 AND action = 'TOPUP_FAILED'`,
      [t.topupId],
    );
    expect(failed).toEqual([{ paypal_id: cap.id }]);
    expect(await topupTxns(t.topupId)).toBe(0);
  });

  it("events for orders that aren't ours are ignored without alerts (the sandbox app is shared)", async () => {
    await deliver(
      fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', {
        id: 'CAP-OTHER',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '5.00' },
        custom_id: 'holdfast-order-1',
      }),
    );
    await deliver(
      fake.emitWebhook('CHECKOUT.ORDER.APPROVED', {
        id: 'ORDER-OTHER',
        purchase_units: [{ custom_id: randomUUID() }],
      }),
    );
    const r = await drain();
    expect(r.processed.map((p) => p.results)).toEqual([
      { topups: 'UNMATCHED' },
      { topups: 'UNMATCHED' },
    ]);
    expect(await q(`SELECT 1 FROM audit_events WHERE paypal_id = 'CAP-OTHER'`)).toEqual([]);
  });

  // ------------------------------------------------------------------ races

  it('CHECKOUT.ORDER.APPROVED (buyer closed the tab) → captured with capture:<id> and credited', async () => {
    const t = await approvedTopup();
    await deliver(
      fake.emitWebhook('CHECKOUT.ORDER.APPROVED', approvedResource(t.orderId, t.topupId)),
    );
    const r = await drain();
    expect(r.processed.map((p) => p.results)).toEqual([{ topups: 'COMPLETED' }]);
    expect(
      fake.calls
        .filter((c) => c.op === 'capture' && c.path.includes(t.orderId))
        .map((c) => c.requestId),
    ).toEqual([`capture:${t.topupId}`]);
    expect(await topupTxns(t.topupId)).toBe(1);
    expect(await balanceOf(app.db.pool, t.buyer.id)).toBe(20_000_000);
  });

  it('race: APPROVED + COMPLETED webhooks + capture endpoint + poller for one top-up → one TOPUP txn', async () => {
    for (let round = 0; round < 3; round++) {
      const t = await approvedTopup();
      // Our first capture reached PayPal (so a COMPLETED event exists) but its credit didn't land.
      await fake.client().captureOrder(t.orderId, t.topupId);
      await deliver(
        fake.emitWebhook('CHECKOUT.ORDER.APPROVED', approvedResource(t.orderId, t.topupId)),
      );
      await deliver(fake.emitWebhook('PAYMENT.CAPTURE.COMPLETED', captureResource(t.orderId)));

      const pool = createPool(db.url, { max: 4, applicationName: 'other-process' });
      try {
        const other = ctx({ db: createDb(pool) });
        const results = await Promise.all([
          agent()
            .post(`/api/buyer/topups/${t.topupId}/capture`)
            .set('Origin', ORIGIN)
            .set('Cookie', t.buyer.cookie)
            .send({}),
          pollOpenTopups({ db: app.db, config: app.config, pp: fake.client() }),
          drain(),
          drain(other),
        ]);
        expect(results[0].status, JSON.stringify(results[0].body)).toBe(200);
      } finally {
        await pool.end();
      }
      expect(await topupTxns(t.topupId)).toBe(1);
      expect(await balanceOf(app.db.pool, t.buyer.id)).toBe(20_000_000);
      expect(fake.captures(t.orderId)).toHaveLength(1);
      expect(
        new Set(
          fake.calls
            .filter((c) => c.op === 'capture' && c.path.includes(t.orderId))
            .map((c) => c.requestId),
        ),
      ).toEqual(new Set([`capture:${t.topupId}`]));
      expect(await q(`SELECT 1 FROM webhook_events WHERE processed_at IS NULL`)).toEqual([]);
    }
  });
});
