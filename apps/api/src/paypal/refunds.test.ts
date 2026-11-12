import { describe, expect, it } from 'vitest';
import { FakePayPalExtras } from './fake/extras.js';
import { getRefund, PayPalRefundExceeded, refundCapture } from './refunds.js';

function setup(captureCents = 2_000) {
  const fake = new FakePayPalExtras();
  fake.refunds.addCapture('CAP1', captureCents);
  return { fake, http: fake.transport() };
}

describe('pp.refundCapture', () => {
  it('POSTs the amount in dollars with PayPal-Request-Id = refundId', async () => {
    const { fake, http } = setup();
    const r = await refundCapture(http, 'CAP1', 740, 'refund-1', { noteToPayer: 'Unused balance' });
    expect(r).toMatchObject({ status: 'COMPLETED', amountCents: 740, captureId: 'CAP1' });
    expect(fake.calls[0]).toMatchObject({ op: 'refund', requestId: 'refund-1', http: 201 });
    expect(fake.refunds.refund(r.refundId)).toMatchObject({ noteToPayer: 'Unused balance' });
  });

  it('replay with the same id → one refund (body ignored); a refund over the capture → 422', async () => {
    const { fake, http } = setup();
    const a = await refundCapture(http, 'CAP1', 1_500, 'r1');
    const again = await refundCapture(http, 'CAP1', 1_500, 'r1');
    expect(again).toMatchObject({ refundId: a.refundId, replayed: true });
    expect(fake.refunds.refundsOf('CAP1')).toHaveLength(1);

    const over = await refundCapture(http, 'CAP1', 501, 'r2').catch((e: unknown) => e);
    expect(over).toBeInstanceOf(PayPalRefundExceeded);
    expect(over).toMatchObject({ http: 422, captureId: 'CAP1', requestedCents: 501 });
    await expect(refundCapture(http, 'CAP1', 500, 'r3')).resolves.toMatchObject({
      amountCents: 500,
    });
    expect(fake.refunds.captureRefundStatus('CAP1')).toBe('REFUNDED');

    // Fully refunded: any further refund is refused too.
    await expect(refundCapture(http, 'CAP1', 1, 'r4')).rejects.toMatchObject({
      code: 'CAPTURE_FULLY_REFUNDED',
    });
  });

  it('PENDING refunds hold the amount; completeRefund settles; failRefund frees it', async () => {
    const { fake, http } = setup();
    fake.refunds.pendingNext(2);
    const p = await refundCapture(http, 'CAP1', 1_200, 'p1');
    expect(p).toMatchObject({ status: 'PENDING', statusReason: 'ECHECK' });
    await expect(refundCapture(http, 'CAP1', 900, 'p2')).rejects.toBeInstanceOf(
      PayPalRefundExceeded,
    );
    const q = await refundCapture(http, 'CAP1', 800, 'p3');
    expect(q.status).toBe('PENDING');

    expect(await getRefund(http, p.refundId)).toMatchObject({ status: 'PENDING' });
    fake.completeRefund(p.refundId);
    expect(await getRefund(http, p.refundId)).toMatchObject({
      status: 'COMPLETED',
      amountCents: 1_200,
      captureId: 'CAP1',
      replayed: false,
    });
    expect(fake.refunds.captureRefundStatus('CAP1')).toBe('PARTIALLY_REFUNDED');

    fake.refunds.failRefund(q.refundId);
    expect((await getRefund(http, q.refundId)).status).toBe('FAILED');
    await expect(refundCapture(http, 'CAP1', 800, 'p4')).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(() => fake.completeRefund(p.refundId)).toThrow(/not PENDING/);
  });

  it('unknown capture is a TERMINAL 404; 5xx and timeouts are TRANSIENT', async () => {
    const { fake, http } = setup();
    await expect(refundCapture(http, 'NOPE', 100, 'x')).rejects.toMatchObject({
      http: 404,
      errorClass: 'TERMINAL',
    });
    fake.failNext('refund', { kind: 'status', http: 500, body: { name: 'INTERNAL_SERVER_ERROR' } });
    await expect(refundCapture(http, 'CAP1', 100, 'y')).rejects.toMatchObject({
      errorClass: 'TRANSIENT',
    });
    fake.failNext('refund', { kind: 'timeout' });
    await expect(
      refundCapture(fake.transport({ timeoutMs: 50 }), 'CAP1', 100, 'y'),
    ).rejects.toMatchObject({ errorClass: 'TRANSIENT', http: 0, code: 'TIMEOUT' });
    expect(fake.refunds.refundsOf('CAP1')).toHaveLength(0);
  });

  it('rejects non-integer or non-positive cents and empty ids before calling PayPal', async () => {
    const { fake, http } = setup();
    await expect(refundCapture(http, 'CAP1', 0, 'a')).rejects.toThrow(RangeError);
    await expect(refundCapture(http, 'CAP1', 1.5, 'a')).rejects.toThrow(RangeError);
    await expect(refundCapture(http, 'CAP1', 100, ' ')).rejects.toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
  });

  it('getRefund on an unknown id is a TERMINAL 404', async () => {
    const { http } = setup();
    await expect(getRefund(http, 'NOPE')).rejects.toMatchObject({
      http: 404,
      errorClass: 'TERMINAL',
    });
  });
});
