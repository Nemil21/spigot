import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { ledgerCheck } from '../ledger/check.js';
import { FakePayPal } from '../paypal/index.js';
import { cases } from '../security/tenancy/refunds.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { setTopupPayPal } from '../topups/index.js';
import webhookHandler from '../webhooks/handlers/refunds.js';
import { setRefundDeps, type RefundDeps } from './deps.js';
import { reserveRefund, SWEEP_REQUESTED_AFTER_MS, sweepRefunds } from './refund.js';

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-049 refund of unused balance (Postgres + FakePayPal)', () => {
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
    setRefundDeps(undefined);
    await app?.close();
    await db?.drop();
  });

  const quiet = () => {};
  const deps = (over: Partial<RefundDeps> = {}): RefundDeps => ({
    db: app.db,
    pp: fake.client({ timeoutMs: 1_000 }),
    log: quiet,
    ...over,
  });
  /** The sweep, run as if `ms` had passed since now. */
  const sweepLater = (ms = SWEEP_REQUESTED_AFTER_MS + 60_000, over: Partial<RefundDeps> = {}) =>
    sweepRefunds(deps({ now: () => Date.now() + ms, ...over }));

  beforeEach(() => {
    app.rateLimiter.reset();
    fake.clearFaults();
    setTopupPayPal(fake.client({ timeoutMs: 1_000 }));
    setRefundDeps(deps());
  });

  const agent = () => request(app.server);

  async function newBuyer() {
    const res = await agent()
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Acme', email: `b-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, cookie: cookiesOf(res) };
  }

  /** A captured wallet top-up of `amountCents`, credited to the buyer's balance. */
  async function completedTopup(cookie: string, amountCents = 2000) {
    const start = await agent()
      .post('/api/buyer/topups')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents, method: 'PAYPAL_WALLET', saveForAutoTopup: false });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    fake.approve(start.body.orderId);
    const cap = await agent()
      .post(`/api/buyer/topups/${start.body.topupId}/capture`)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({});
    expect(cap.status, JSON.stringify(cap.body)).toBe(200);
    return { topupId: start.body.topupId as string, captureId: cap.body.captureId as string };
  }

  const refund = (cookie: string, amountCents: number, key: string | null = randomUUID()) => {
    const r = agent().post('/api/buyer/refunds').set('Origin', ORIGIN).set('Cookie', cookie);
    return (key === null ? r : r.set('Idempotency-Key', key)).send({ amountCents });
  };

  async function balanceMicros(buyerId: string): Promise<number> {
    const { rows } = await app.db.pool.query<{ b: string }>(
      `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
      [buyerId],
    );
    return Number(rows[0]?.b ?? 0);
  }

  async function topupRow(id: string) {
    const { rows } = await app.db.pool.query<{ status: string; refunded: number }>(
      `SELECT status, refunded_cents AS refunded FROM topups WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function refundRows(buyerId: string) {
    const { rows } = await app.db.pool.query<{
      id: string;
      status: string;
      amountCents: number;
      paypalRefundId: string | null;
      errorCode: string | null;
    }>(
      `SELECT id, status, amount_cents AS "amountCents", paypal_refund_id AS "paypalRefundId",
              error_code AS "errorCode"
         FROM balance_refunds WHERE buyer_id = $1 ORDER BY created_at, id`,
      [buyerId],
    );
    return rows;
  }

  async function txnKinds(refundId: string): Promise<string[]> {
    const { rows } = await app.db.pool.query<{ kind: string }>(
      `SELECT kind FROM ledger_txns WHERE ref_type = 'balance_refund' AND ref_id = $1 ORDER BY created_at`,
      [refundId],
    );
    return rows.map((r) => r.kind);
  }

  const refundCalls = (captureId: string) =>
    fake.extras.calls.filter((c) => c.op === 'refund' && c.path.includes(`/${captureId}/`));

  async function expectLedgerOk() {
    const check = await ledgerCheck(app.db.pool);
    expect(check.mismatches).toEqual([]);
    expect(check.sumMicros).toBe(0);
  }

  // ---------------------------------------------------------------------- acceptance criteria

  it('refunds $7.40 of a $20 top-up: refund id stored, balance −$7.40, top-up PARTIALLY_REFUNDED', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);
    expect(await balanceMicros(b.id)).toBe(20_000_000);

    const res = await refund(b.cookie, 740);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.totalCents).toBe(740);
    expect(res.body.balanceMicros).toBe(12_600_000);
    expect(res.body.refunds).toHaveLength(1);
    const r = res.body.refunds[0];
    expect(r).toMatchObject({ topupId: t.topupId, amountCents: 740, status: 'COMPLETED' });
    expect(r.paypalRefundId).toMatch(/\S/);

    // PayPal-Request-Id = balance_refunds.id; the fake holds exactly that refund.
    const atPayPal = fake.extras.refunds.refundsOf(t.captureId);
    expect(atPayPal).toHaveLength(1);
    expect(atPayPal[0]).toMatchObject({
      id: r.paypalRefundId,
      requestId: r.refundId,
      amountCents: 740,
    });

    expect(await balanceMicros(b.id)).toBe(12_600_000);
    expect(await topupRow(t.topupId)).toEqual({ status: 'PARTIALLY_REFUNDED', refunded: 740 });
    expect(await txnKinds(r.refundId)).toEqual(['REFUND']);

    const list = await agent().get('/api/buyer/refunds').set('Cookie', b.cookie);
    expect(list.status).toBe(200);
    expect(list.body.refunds.map((x: { refundId: string }) => x.refundId)).toEqual([r.refundId]);
    expect(list.body.available).toEqual({
      balanceCents: 1260,
      refundableCents: 1260,
      allowedCents: 1260,
    });
    await expectLedgerOk();
  });

  it('splits across the newest top-ups first; a full cash-out disables auto top-up', async () => {
    const b = await newBuyer();
    const older = await completedTopup(b.cookie, 2000);
    const newer = await completedTopup(b.cookie, 1000);
    await app.db.pool.query(
      `UPDATE topups SET created_at = now() - interval '2 days' WHERE id = $1`,
      [older.topupId],
    );
    await app.db.pool.query(`UPDATE buyers SET auto_topup_enabled = true WHERE id = $1`, [b.id]);

    const first = await refund(b.cookie, 1500);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(
      first.body.refunds.map((r: { topupId: string; amountCents: number }) => [
        r.topupId,
        r.amountCents,
      ]),
    ).toEqual([
      [newer.topupId, 1000],
      [older.topupId, 500],
    ]);
    expect(first.body.autoTopupDisabled).toBe(false);
    expect(await topupRow(newer.topupId)).toEqual({ status: 'REFUNDED', refunded: 1000 });
    expect(await topupRow(older.topupId)).toEqual({ status: 'PARTIALLY_REFUNDED', refunded: 500 });

    const rest = await refund(b.cookie, 1500);
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.autoTopupDisabled).toBe(true);
    expect(await balanceMicros(b.id)).toBe(0);
    expect(await topupRow(older.topupId)).toEqual({ status: 'REFUNDED', refunded: 2000 });
    const { rows } = await app.db.pool.query(
      `SELECT auto_topup_enabled AS on FROM buyers WHERE id = $1`,
      [b.id],
    );
    expect(rows[0].on).toBe(false);
    await expectLedgerOk();
  });

  it('caps at the unrefunded captures ≤ 180 days old: 422 REFUND_EXCEEDS_UNUSED explains why', async () => {
    const b = await newBuyer();
    await completedTopup(b.cookie, 2000);
    const old = await completedTopup(b.cookie, 2000);
    // Balance $40, but one top-up is past PayPal's refund window (like balance from credits).
    await app.db.pool.query(
      `UPDATE topups SET created_at = now() - interval '200 days' WHERE id = $1`,
      [old.topupId],
    );

    const res = await refund(b.cookie, 3000);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REFUND_EXCEEDS_UNUSED');
    expect(res.body.error.message).toMatch(/at most \$20\b/);
    expect(res.body.error.message).toMatch(/can't go back to PayPal/);
    expect(res.body.error.details).toEqual({
      requestedCents: 3000,
      allowedCents: 2000,
      balanceCents: 4000,
      refundableCents: 2000,
    });
    expect(await refundRows(b.id)).toEqual([]);
    expect(await balanceMicros(b.id)).toBe(40_000_000);

    const over = await refund(b.cookie, 4001);
    expect(over.status).toBe(422);
  });

  it('a definite refusal → FAILED with the reason, REFUND_REVERSAL puts the money back; ledger check passes', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);
    fake.extras.failNext('refund', {
      kind: 'status',
      http: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'REFUND_NOT_ALLOWED' }] },
    });

    const res = await refund(b.cookie, 740);
    expect(res.status).toBe(201);
    expect(res.body.refunds[0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'REFUND_NOT_ALLOWED',
    });
    expect(res.body.balanceMicros).toBe(20_000_000);
    expect(await txnKinds(res.body.refunds[0].refundId)).toEqual(['REFUND', 'REFUND_REVERSAL']);
    expect(await topupRow(t.topupId)).toEqual({ status: 'COMPLETED', refunded: 0 });

    // The failed slice no longer holds the capture: the same amount can be refunded again.
    const again = await refund(b.cookie, 2000);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.refunds[0].status).toBe('COMPLETED');
    expect(await topupRow(t.topupId)).toEqual({ status: 'REFUNDED', refunded: 2000 });

    // A sweep finds nothing to reverse twice.
    expect((await sweepLater()).reversalsPosted).toBe(0);
    await expectLedgerOk();
  });

  it('crash between the REFUND post and the PayPal call → the sweep completes it once (same request id)', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);

    // Step 1 only, as if the process died right after committing it.
    const reserved = await reserveRefund(deps(), {
      buyerId: b.id,
      amountCents: 740,
      idempotencyKey: randomUUID(),
    });
    const id = reserved.slices[0]!.id;
    expect(reserved.slices[0]!.status).toBe('REQUESTED');
    expect(await balanceMicros(b.id)).toBe(12_600_000);
    expect(refundCalls(t.captureId)).toHaveLength(0);

    // Younger than a minute: still the request's own call, the sweep leaves it alone.
    await sweepRefunds(deps());
    expect(refundCalls(t.captureId)).toHaveLength(0);

    const swept = await sweepLater();
    expect(swept.replayed).toEqual({ COMPLETED: 1 });
    const calls = refundCalls(t.captureId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.requestId).toBe(id);
    expect((await refundRows(b.id))[0]).toMatchObject({ id, status: 'COMPLETED' });
    expect(await topupRow(t.topupId)).toEqual({ status: 'PARTIALLY_REFUNDED', refunded: 740 });

    // Nothing left to do on the next tick.
    await sweepLater();
    expect(refundCalls(t.captureId)).toHaveLength(1);
    expect(await txnKinds(id)).toEqual(['REFUND']);
    await expectLedgerOk();
  });

  it('a PENDING refund is resolved by polling, with no webhook', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);
    fake.extras.refunds.pendingNext(2);

    const res = await refund(b.cookie, 740);
    expect(res.status).toBe(201);
    const r = res.body.refunds[0];
    expect(r.status).toBe('PENDING');
    expect(r.paypalRefundId).toMatch(/\S/);
    expect(await topupRow(t.topupId)).toEqual({ status: 'COMPLETED', refunded: 0 });

    // Still PENDING at PayPal: the poll changes nothing.
    expect((await sweepRefunds(deps())).polled).toEqual({ PENDING: 1 });
    fake.completeRefund(r.paypalRefundId);
    expect((await sweepRefunds(deps())).polled).toEqual({ COMPLETED: 1 });
    expect((await refundRows(b.id))[0]!.status).toBe('COMPLETED');
    expect(await topupRow(t.topupId)).toEqual({ status: 'PARTIALLY_REFUNDED', refunded: 740 });

    // PENDING → FAILED at PayPal: the poll fails it and reverses the REFUND.
    const second = await refund(b.cookie, 500);
    const r2 = second.body.refunds[0];
    expect(r2.status).toBe('PENDING');
    fake.extras.refunds.failRefund(r2.paypalRefundId);
    expect((await sweepRefunds(deps())).polled).toEqual({ FAILED: 1 });
    expect(await txnKinds(r2.refundId)).toEqual(['REFUND', 'REFUND_REVERSAL']);
    expect(await balanceMicros(b.id)).toBe(12_600_000);
    await expectLedgerOk();
  });

  it('PAYMENT.CAPTURE.REFUNDED webhook completes a PENDING refund once', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);
    fake.extras.refunds.pendingNext();
    const res = await refund(b.cookie, 300);
    const r = res.body.refunds[0];
    expect(r.status).toBe('PENDING');

    const event = {
      id: `WH-${randomUUID()}`,
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: r.paypalRefundId, status: 'COMPLETED' },
    };
    expect(webhookHandler.eventTypes).toContain('PAYMENT.CAPTURE.REFUNDED');
    expect(await app.db.tx((tx) => webhookHandler.handle(tx, event))).toBe('COMPLETED');
    expect(await app.db.tx((tx) => webhookHandler.handle(tx, event))).toBe('COMPLETED');
    expect(await topupRow(t.topupId)).toEqual({ status: 'PARTIALLY_REFUNDED', refunded: 300 });
    expect(
      await app.db.tx((tx) =>
        webhookHandler.handle(tx, { ...event, resource: { id: 'RF-UNKNOWN' } }),
      ),
    ).toBe('UNMATCHED');
    await expectLedgerOk();
  });

  // ---------------------------------------------------------------------- race / idempotency

  it('double-click (same Idempotency-Key) → one refund', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);
    const key = randomUUID();

    const [a, c] = await Promise.all([refund(b.cookie, 740, key), refund(b.cookie, 740, key)]);
    expect([a.status, c.status].sort()).toEqual([200, 201]);
    const ids = (x: request.Response) =>
      x.body.refunds.map((r: { refundId: string }) => r.refundId);
    expect(ids(a)).toEqual(ids(c));

    expect(await refundRows(b.id)).toHaveLength(1);
    expect(fake.extras.refunds.refundsOf(t.captureId)).toHaveLength(1);
    expect(await balanceMicros(b.id)).toBe(12_600_000);

    // A later replay reports the final state; a different amount under the same key is refused.
    const replay = await refund(b.cookie, 740, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replay: true, totalCents: 740 });
    expect(replay.body.refunds[0].status).toBe('COMPLETED');
    const mismatch = await refund(b.cookie, 500, key);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(refundCalls(t.captureId)).toHaveLength(1);
  });

  it('response lost after the refund happened → retry with the same request id → same refund id, one REFUND txn', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);
    // PayPal makes the refund, but the answer never arrives (and the client doesn't retry inline).
    setRefundDeps(deps({ pp: fake.client({ timeoutMs: 250, retries: 0 }) }));
    fake.extras.failNext('refund', { kind: 'drop_response' });

    const res = await refund(b.cookie, 740);
    expect(res.status).toBe(201);
    const r = res.body.refunds[0];
    expect(r.status).toBe('REQUESTED');
    const atPayPal = fake.extras.refunds.refundsOf(t.captureId);
    expect(atPayPal).toHaveLength(1);

    const swept = await sweepLater();
    expect(swept.replayed).toEqual({ COMPLETED: 1 });
    const calls = refundCalls(t.captureId);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.requestId === r.refundId)).toBe(true);
    expect(fake.extras.refunds.refundsOf(t.captureId)).toHaveLength(1);

    const [row] = await refundRows(b.id);
    expect(row).toMatchObject({
      id: r.refundId,
      status: 'COMPLETED',
      paypalRefundId: atPayPal[0]!.id,
    });
    expect(await txnKinds(r.refundId)).toEqual(['REFUND']);
    expect(await balanceMicros(b.id)).toBe(12_600_000);
    expect(await topupRow(t.topupId)).toEqual({ status: 'PARTIALLY_REFUNDED', refunded: 740 });
    await expectLedgerOk();
  });

  it('two parallel refunds whose sum exceeds the refundable amount → one 201, one 422; balance never negative', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);

    const results = await Promise.all([refund(b.cookie, 1500), refund(b.cookie, 1500)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.error.code).toBe('REFUND_EXCEEDS_UNUSED');
    expect(await refundRows(b.id)).toHaveLength(1);
    expect(fake.extras.refunds.refundsOf(t.captureId)).toHaveLength(1);
    expect(await balanceMicros(b.id)).toBe(5_000_000);
    await expectLedgerOk();
  });

  it('parallel refunds that slice one capture while a slice is still in flight never over-refund it', async () => {
    const b = await newBuyer();
    const t = await completedTopup(b.cookie);
    // A REQUESTED slice (not yet at PayPal) holds its share of the capture.
    await reserveRefund(deps(), { buyerId: b.id, amountCents: 1500, idempotencyKey: randomUUID() });
    const res = await refund(b.cookie, 600);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toMatchObject({ allowedCents: 500, refundableCents: 500 });
    await sweepLater();
    expect(fake.extras.refunds.refundedCents(t.captureId)).toBe(1500);
    await expectLedgerOk();
  });

  // ---------------------------------------------------------------------- validation + tenancy

  it('requires a session, an Idempotency-Key and a positive whole amount', async () => {
    const b = await newBuyer();
    const anon = await agent()
      .post('/api/buyer/refunds')
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', 'k')
      .send({ amountCents: 1 });
    expect(anon.status).toBe(401);
    expect((await refund(b.cookie, 100, null)).status).toBe(400);
    for (const bad of [0, -5, 1.5]) expect((await refund(b.cookie, bad)).status).toBe(400);
    expect((await agent().get('/api/buyer/refunds')).status).toBe(401);
  });

  it('tenancy: buyer B can neither refund nor see buyer A’s balance', async () => {
    expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/buyer/refunds',
      'GET /api/buyer/refunds',
    ]);
    const a = await newBuyer();
    const bb = await newBuyer();
    await completedTopup(a.cookie);
    const mine = await refund(a.cookie, 100);
    expect(mine.status).toBe(201);

    const theirs = await agent()
      .post('/api/buyer/refunds')
      .set('Origin', ORIGIN)
      .set('Cookie', bb.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 100, buyerId: a.id });
    expect(theirs.status).toBe(422);
    const list = await agent().get(`/api/buyer/refunds?buyerId=${a.id}`).set('Cookie', bb.cookie);
    expect(list.body.refunds).toEqual([]);
    expect(list.body.available.balanceCents).toBe(0);
    expect(await balanceMicros(a.id)).toBe(19_000_000);
  });
});
