import { describe, expect, it } from 'vitest';
import { FakePayPalExtras } from './fake/extras.js';
import { payout, PayPalDuplicateBatch, type PayoutInput } from './payouts.js';
import { PayPalRefundExceeded, refundCapture } from './refunds.js';

/** SP-001c race / idempotency tests on FakePayPal (latency + jitter so calls overlap). */

const input: PayoutInput = {
  batchId: 'batch-1',
  items: [
    {
      itemId: 'item-1',
      email: 'publisher@example.com',
      amountCents: 41_275,
      note: 'Spigot: payout',
    },
  ],
};

describe('refund races', () => {
  it('two parallel refunds with different ids whose sum exceeds the capture → one succeeds, one 422', async () => {
    const fake = new FakePayPalExtras({ latencyMs: 5, jitterMs: 10 });
    fake.refunds.addCapture('CAP1', 2_000);
    const http = fake.transport();
    const results = await Promise.allSettled([
      refundCapture(http, 'CAP1', 1_200, 'refund-a'),
      refundCapture(http, 'CAP1', 1_200, 'refund-b'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(PayPalRefundExceeded);
    expect(fake.refunds.refundedCents('CAP1')).toBe(1_200);
  });

  it('20 parallel refunds of $3 against $20 → exactly 6 succeed, never over the capture', async () => {
    const fake = new FakePayPalExtras({ latencyMs: 2, jitterMs: 15 });
    fake.refunds.addCapture('CAP1', 2_000);
    const http = fake.transport();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => refundCapture(http, 'CAP1', 300, `r-${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PayPalRefundExceeded);
    }
    expect(fake.refunds.refundedCents('CAP1')).toBe(1_800);
  });

  it('20 parallel refunds with the same id → one refund', async () => {
    const fake = new FakePayPalExtras({ latencyMs: 2, jitterMs: 15 });
    fake.refunds.addCapture('CAP1', 2_000);
    const http = fake.transport();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => refundCapture(http, 'CAP1', 740, 'same-id')),
    );
    expect(new Set(results.map((r) => r.refundId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(fake.refunds.refundsOf('CAP1')).toHaveLength(1);
  });

  it('refund response lost after PayPal refunded → retry with the same id → same refund, one refund', async () => {
    const fake = new FakePayPalExtras();
    fake.refunds.addCapture('CAP1', 2_000);
    fake.failNext('refund', { kind: 'drop_response' });
    const lost = await refundCapture(fake.transport({ timeoutMs: 50 }), 'CAP1', 740, 'r1').catch(
      (e: unknown) => e,
    );
    expect(lost).toMatchObject({ errorClass: 'TRANSIENT', http: 0 });
    expect(fake.refunds.refundsOf('CAP1')).toHaveLength(1);

    const retry = await refundCapture(fake.transport(), 'CAP1', 740, 'r1');
    expect(retry).toMatchObject({ replayed: true, amountCents: 740 });
    expect(retry.refundId).toBe(fake.refunds.refundsOf('CAP1')[0]!.id);
    expect(fake.refunds.refundsOf('CAP1')).toHaveLength(1);
  });
});

describe('payout races', () => {
  it('response lost after PayPal accepted the batch → retry with the same sender_batch_id → duplicate, no second payout', async () => {
    const fake = new FakePayPalExtras({ payouts: { balanceCents: 100_000 } });
    fake.failNext('payout', { kind: 'drop_response' });
    const lost = await payout(fake.transport({ timeoutMs: 50 }), input).catch((e: unknown) => e);
    expect(lost).toMatchObject({ errorClass: 'TRANSIENT', http: 0, code: 'TIMEOUT' });
    expect(fake.payouts.batchesCreated).toBe(1);

    const retry = await payout(fake.transport(), input).catch((e: unknown) => e);
    expect(retry).toBeInstanceOf(PayPalDuplicateBatch);
    expect(retry).toMatchObject({ senderBatchId: 'batch-1', payoutBatchId: null });
    expect(fake.payouts.batchesCreated).toBe(1);
    expect(fake.payouts.balanceCents).toBe(100_000 - 41_275);
    expect(fake.payouts.batchBySenderId('batch-1')).toBeDefined();
  });

  it('20 parallel submits of one batch → one payout at PayPal, 19 duplicates', async () => {
    const fake = new FakePayPalExtras({ latencyMs: 2, jitterMs: 15 });
    const http = fake.transport();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => payout(http, input)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PayPalDuplicateBatch);
    }
    expect(fake.payouts.batchesCreated).toBe(1);
  });

  it('parallel batches that together exceed the balance → the rest get INSUFFICIENT_FUNDS, no overdraft', async () => {
    const fake = new FakePayPalExtras({
      latencyMs: 2,
      jitterMs: 15,
      payouts: { balanceCents: 100_000 },
    });
    const http = fake.transport();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => payout(http, { ...input, batchId: `batch-${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(fake.payouts.balanceCents).toBe(100_000 - 2 * 41_275);
  });
});
