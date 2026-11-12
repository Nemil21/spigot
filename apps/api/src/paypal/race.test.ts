import { describe, expect, it } from 'vitest';
import { FakePayPal, fakeError } from './fake/core.js';
import type { TestCard, TopupResult } from './types.js';

/** Races and fault cases on `FakePayPal` with latency and jitter, so concurrent calls overlap. */

const CARD: TestCard = {
  number: '4111111111111111',
  expiry: '2030-12',
  security_code: '123',
  name: 'Race Buyer',
};
const WALLET = { kind: 'wallet' as const, returnUrl: 'https://x/r', cancelUrl: 'https://x/c' };
let n = 0;
const uid = (p: string) => `${p}-${++n}`;

function racing() {
  const fake = new FakePayPal({ latencyMs: 2, jitterMs: 8 });
  return { fake, client: fake.client({ timeoutMs: 1_000 }) };
}

const orderIds = (rs: TopupResult[]) => new Set(rs.map((r) => ('orderId' in r ? r.orderId : null)));

describe('createTopupOrder races (FakePayPal)', () => {
  it('20 parallel creates with the same request id (vault_id) → one order, one capture', async () => {
    const { fake, client } = racing();
    const vaultId = fake.seedVault('card');
    const topupId = uid('topup');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        client.createTopupOrder({
          topupId,
          amountCents: 2000,
          source: { kind: 'card_vault', vaultId },
        }),
      ),
    );
    expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(orderIds(results).size).toBe(1);
    expect(new Set(results.map((r) => r.status === 'COMPLETED' && r.captureId)).size).toBe(1);
    expect(fake.orders()).toHaveLength(1);
    expect(fake.captures()).toHaveLength(1);
  });

  it('20 parallel creates with the same request id (wallet / no source) → one order', async () => {
    for (const source of [WALLET, { kind: 'none' as const }]) {
      const { fake, client } = racing();
      const topupId = uid('topup');
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          client.createTopupOrder({ topupId, amountCents: 1500, source }),
        ),
      );
      expect(results.every((r) => r.status === 'AWAITING_APPROVAL')).toBe(true);
      expect(orderIds(results).size).toBe(1);
      expect(fake.orders()).toHaveLength(1);
    }
  });

  it('20 parallel raw-card creates with the same id → one order, same capture everywhere (CAPTURE sandbox)', async () => {
    const { fake, client } = racing();
    const topupId = uid('sim');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        client.createTopupOrder({
          topupId,
          amountCents: 2000,
          source: { kind: 'card', card: CARD },
        }),
      ),
    );
    expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(new Set(results.map((r) => r.status === 'COMPLETED' && r.captureId)).size).toBe(1);
    expect(fake.orders()).toHaveLength(1);
    expect(fake.captures()).toHaveLength(1);
  });

  it('20 parallel raw-card creates, S7 refusal mode → one order; the rest NEEDS_RECONCILE, none DECLINED', async () => {
    const fake = new FakePayPal({ latencyMs: 2, jitterMs: 8, rawCardReplay: 'refuse' });
    const client = fake.client({ timeoutMs: 1_000 });
    const topupId = uid('sim');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        client.createTopupOrder({
          topupId,
          amountCents: 2000,
          source: { kind: 'card', card: CARD },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'COMPLETED')).toHaveLength(1);
    const rest = results.filter((r) => r.status !== 'COMPLETED');
    expect(rest).toHaveLength(19);
    for (const r of rest) {
      expect(r).toMatchObject({
        status: 'NEEDS_RECONCILE',
        errorClass: 'RECONCILE',
        code: 'TRANSACTION_REFUSED',
      });
    }
    expect(fake.orders()).toHaveLength(1);
    expect(fake.captures()).toHaveLength(1);
  });

  it('response lost after a vault charge landed → retry with the same id returns the original order', async () => {
    const { fake, client } = racing();
    const vaultId = fake.seedVault('card');
    const topupId = uid('auto');
    fake.failNext('order_create', { kind: 'drop_response' });
    const lost = await fake.client({ timeoutMs: 50, retries: 0 }).createTopupOrder({
      topupId,
      amountCents: 1000,
      source: { kind: 'card_vault', vaultId },
    });
    expect(lost).toMatchObject({ status: 'NEEDS_RECONCILE', errorClass: 'TRANSIENT' });
    expect(fake.captures()).toHaveLength(1); // PayPal did the work

    const retry = await client.createTopupOrder({
      topupId,
      amountCents: 1000,
      source: { kind: 'card_vault', vaultId },
    });
    expect(retry).toMatchObject({ status: 'COMPLETED', captureId: fake.captures()[0]!.id });
    expect(fake.captures()).toHaveLength(1);
  });

  it('in-call retries ride out a lost create response with the same request id', async () => {
    const { fake } = racing();
    const vaultId = fake.seedVault('paypal');
    fake.failNext('order_create', { kind: 'drop_response' });
    const client = fake.client({ timeoutMs: 50, retries: 2 });
    const r = await client.createTopupOrder({
      topupId: uid('auto'),
      amountCents: 700,
      source: { kind: 'wallet_vault', vaultId },
    });
    expect(r).toMatchObject({ status: 'COMPLETED', reconciled: false });
    expect(fake.captures()).toHaveLength(1);
  });
});

describe('captureOrder races and faults (FakePayPal)', () => {
  async function approved(fake: FakePayPal, client: ReturnType<FakePayPal['client']>) {
    const topupId = uid('topup');
    const r = await client.createTopupOrder({ topupId, amountCents: 2000, source: WALLET });
    fake.approve(r.orderId!);
    return { orderId: r.orderId!, topupId };
  }

  it('20 parallel captures with capture:<topupId> → one capture, same id everywhere', async () => {
    const { fake, client } = racing();
    const { orderId, topupId } = await approved(fake, client);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => client.captureOrder(orderId, topupId)),
    );
    expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(new Set(results.map((r) => r.status === 'COMPLETED' && r.captureId)).size).toBe(1);
    expect(fake.captures(orderId)).toHaveLength(1);
  });

  it('return handler, webhook and poller capture with different ids at once → one capture', async () => {
    const { fake, client } = racing();
    const { orderId, topupId } = await approved(fake, client);
    const results = await Promise.all([
      client.captureOrder(orderId, topupId),
      client.captureOrder(orderId, `${topupId}-b`),
      client.captureOrder(orderId, `${topupId}-c`),
    ]);
    expect(results.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(new Set(results.map((r) => r.status === 'COMPLETED' && r.captureId)).size).toBe(1);
    expect(fake.captures(orderId)).toHaveLength(1);
  });

  it('response lost after the capture happened → retry with the same id returns the original capture', async () => {
    const { fake, client } = racing();
    const { orderId, topupId } = await approved(fake, client);
    fake.failNext('capture', { kind: 'drop_response' });
    const lost = await fake.client({ timeoutMs: 50, retries: 0 }).captureOrder(orderId, topupId);
    expect(lost).toMatchObject({
      status: 'NEEDS_RECONCILE',
      errorClass: 'TRANSIENT',
      code: 'TIMEOUT',
    });
    const [original] = fake.captures(orderId);
    expect(original).toMatchObject({ status: 'COMPLETED' });

    const retry = await client.captureOrder(orderId, topupId);
    expect(retry).toMatchObject({
      status: 'COMPLETED',
      captureId: original!.id,
      reconciled: false,
    });
    expect(fake.captures(orderId)).toHaveLength(1);
    // The retry was a replay (200), not a second capture.
    const captureCalls = fake.calls.filter((c) => c.op === 'capture');
    expect(captureCalls.map((c) => c.http)).toEqual([201, 200]);
  });

  it('capture PENDING injection → PENDING; settle → getOrder shows COMPLETED', async () => {
    const { fake, client } = racing();
    const { orderId, topupId } = await approved(fake, client);
    fake.pendNextCapture('PENDING_REVIEW');
    const r = await client.captureOrder(orderId, topupId);
    expect(r).toMatchObject({ status: 'PENDING', reason: 'PENDING_REVIEW' });
    if (r.status !== 'PENDING') return;
    fake.settleCapture(r.captureId);
    const { topupResultOf } = await import('./orders.js');
    expect(topupResultOf(await client.getOrder(orderId))).toMatchObject({
      status: 'COMPLETED',
      captureId: r.captureId,
    });
  });

  it('decline fault on capture → 403 empty body → DECLINED; the order is still uncaptured', async () => {
    const { fake, client } = racing();
    const { orderId, topupId } = await approved(fake, client);
    fake.failNext('capture', { kind: 'decline' });
    expect(await client.captureOrder(orderId, topupId)).toMatchObject({
      status: 'DECLINED',
      http: 403,
    });
    expect(fake.captures(orderId)).toHaveLength(0);
  });

  it('a 5xx on capture is retried in-call with the same id', async () => {
    const { fake, client } = racing();
    const { orderId, topupId } = await approved(fake, client);
    fake.failNext('capture', { kind: 'status', http: 500 }, 2);
    expect(await client.captureOrder(orderId, topupId)).toMatchObject({ status: 'COMPLETED' });
    expect(fake.calls.filter((c) => c.op === 'capture').map((c) => c.requestId)).toEqual([
      `capture:${topupId}`,
      `capture:${topupId}`,
      `capture:${topupId}`,
    ]);
  });
});

describe('FakePayPal behaviour', () => {
  it('vault ids: card vault works only as a card source; unknown vault → DECLINED', async () => {
    const { fake, client } = racing();
    const cardVault = fake.seedVault('card');
    expect(
      await client.createTopupOrder({
        topupId: uid('t'),
        amountCents: 500,
        source: { kind: 'wallet_vault', vaultId: cardVault },
      }),
    ).toMatchObject({ status: 'DECLINED', code: 'INVALID_RESOURCE_ID' });
    expect(
      await client.createTopupOrder({
        topupId: uid('t'),
        amountCents: 500,
        source: { kind: 'card_vault', vaultId: 'nope' },
      }),
    ).toMatchObject({ status: 'DECLINED' });
  });

  it('the fee is in seller_receivable_breakdown and the net adds up', async () => {
    const { fake, client } = racing();
    const r = await client.createTopupOrder({
      topupId: uid('t'),
      amountCents: 10_000,
      source: { kind: 'card', card: CARD },
    });
    expect(r).toMatchObject({ status: 'COMPLETED', amountCents: 10_000, feeCents: 398 });
    const order = await client.getOrder(r.orderId!);
    expect(order.captures[0]).toMatchObject({ feeCents: 398, netCents: 9602 });
    expect(fake.order(r.orderId!)?.status).toBe('COMPLETED');
  });

  it('extensions register routes for every new fake (SP-001c seam)', async () => {
    FakePayPal.extend((fake) =>
      fake.route({
        op: 'ping_test',
        method: 'GET',
        match: (p) => /^\/v1\/test-ping\/([^/]+)$/.exec(p)?.[1] ?? null,
        handle: (req) =>
          req.id === 'ok' ? { http: 200, body: { pong: fake.newId('P') } } : fakeError(404, 'NOPE'),
      }),
    );
    const fake = new FakePayPal();
    const client = fake.client();
    const ok = await client.http.request('get', 'GET', '/v1/test-ping/ok');
    expect(ok).toMatchObject({ http: 200, json: { pong: expect.stringMatching(/^P/) } });
    const missing = await client.http.request('get', 'GET', '/v1/test-ping/x');
    expect(missing).toMatchObject({ http: 404, issue: 'NOPE' });
    expect(fake.calls.at(-1)?.op).toBe('ping_test');
  });

  it('approve() refuses an order that is not awaiting approval', async () => {
    const { fake, client } = racing();
    const r = await client.createTopupOrder({
      topupId: uid('t'),
      amountCents: 500,
      source: { kind: 'card', card: CARD },
    });
    expect(() => fake.approve(r.orderId!)).toThrow(/not awaiting approval/);
    expect(() => fake.approve('nope')).toThrow(/no order/);
  });
});
