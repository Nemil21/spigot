import { describe, expect, it } from 'vitest';
import { FakePayPalExtras } from './fake/extras.js';
import {
  getPayoutBatch,
  getPayoutItem,
  normalisePayoutItemStatus,
  payout,
  PayPalDuplicateBatch,
  PayPalInsufficientFunds,
  type PayoutInput,
} from './payouts.js';
import { PayPalCallError } from './transport.js';

const PUBLISHER = 'publisher@example.com';
const UNREGISTERED = 'nobody@example.com';
const MERCHANT = 'merchant@example.com';

function setup() {
  const fake = new FakePayPalExtras({
    payouts: { merchantEmail: MERCHANT, unregisteredEmails: [UNREGISTERED], settlesAfterGets: 2 },
  });
  return { fake, http: fake.transport() };
}

const batch = (batchId: string, ...emails: [string, number][]): PayoutInput => ({
  batchId,
  items: emails.map(([email, amountCents], i) => ({
    itemId: `${batchId}-item${i}`,
    email,
    amountCents,
    note: 'Spigot: 8,112 records sold, Nov 4–11',
  })),
});

describe('pp.payout', () => {
  it('sends sender_batch_id = PayPal-Request-Id = batchId, EMAIL items with sender_item_id', async () => {
    const { fake, http } = setup();
    const res = await payout(http, batch('b1', [PUBLISHER, 41_275]));
    expect(res).toMatchObject({ senderBatchId: 'b1', batchStatus: 'PENDING' });
    expect(fake.calls[0]).toMatchObject({ op: 'payout', requestId: 'b1', http: 201 });
    const item = fake.payouts.itemsOf(res.payoutBatchId)[0]!;
    expect(item).toMatchObject({
      senderItemId: 'b1-item0',
      receiver: PUBLISHER,
      amountCents: 41_275,
    });
    expect(fake.payouts.batch(res.payoutBatchId)?.emailSubject).toBe('Your Spigot earnings');
  });

  it('422 INSUFFICIENT_FUNDS → PayPalInsufficientFunds and no batch', async () => {
    const { fake, http } = setup();
    fake.payouts.balanceCents = 1_000;
    const err = await payout(http, batch('b1', [PUBLISHER, 250_000])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalInsufficientFunds);
    expect(err).toMatchObject({ http: 422, code: 'INSUFFICIENT_FUNDS', senderBatchId: 'b1' });
    expect(fake.payouts.batchesCreated).toBe(0);
    expect(fake.payouts.batchBySenderId('b1')).toBeUndefined();
    expect(fake.payouts.balanceCents).toBe(1_000);

    // Injected, whatever the balance; the next run's new batch goes through.
    fake.payouts.balanceCents = Number.MAX_SAFE_INTEGER;
    fake.payouts.insufficientFundsNext();
    await expect(payout(http, batch('b2', [PUBLISHER, 100]))).rejects.toBeInstanceOf(
      PayPalInsufficientFunds,
    );
    await expect(payout(http, batch('b3', [PUBLISHER, 100]))).resolves.toBeTruthy();
    expect(fake.payouts.batchesCreated).toBe(1);
  });

  it('duplicate sender_batch_id → PayPalDuplicateBatch with no batch id, same or new request id (S10)', async () => {
    const { fake, http } = setup();
    await payout(http, batch('b1', [PUBLISHER, 100]));
    const sameRequestId = await payout(http, batch('b1', [PUBLISHER, 100])).catch(
      (e: unknown) => e,
    );
    expect(sameRequestId).toBeInstanceOf(PayPalDuplicateBatch);
    expect(sameRequestId).toMatchObject({
      http: 400,
      code: 'USER_BUSINESS_ERROR',
      errorClass: 'RECONCILE',
      senderBatchId: 'b1',
      payoutBatchId: null,
    });

    // A new PayPal-Request-Id doesn't help either.
    const viaOtherId = await http.request('payout', 'POST', '/v1/payments/payouts', {
      requestId: 'another-request-id',
      body: {
        sender_batch_header: { sender_batch_id: 'b1' },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: PUBLISHER,
            amount: { value: '1.00', currency: 'USD' },
          },
        ],
      },
    });
    expect(viaOtherId.http).toBe(400);
    expect(viaOtherId.json).toMatchObject({
      name: 'USER_BUSINESS_ERROR',
      details: [{ issue: 'Batch with given sender_batch_id already exists' }],
    });
    expect(fake.payouts.batchesCreated).toBe(1);
  });

  it('reads a payout_batch_id if a duplicate error ever carries one', async () => {
    const { fake, http } = setup();
    fake.failNext('payout', {
      kind: 'status',
      http: 400,
      body: {
        name: 'USER_BUSINESS_ERROR',
        details: [{ issue: 'Batch with given sender_batch_id already exists' }],
        batch_header: { payout_batch_id: 'PAYPALBATCH1' },
      },
    });
    await expect(payout(http, batch('b1', [PUBLISHER, 100]))).rejects.toMatchObject({
      payoutBatchId: 'PAYPALBATCH1',
    });
  });

  it('5xx and no answer are TRANSIENT; validation errors TERMINAL', async () => {
    const { fake, http } = setup();
    fake.failNext('payout', { kind: 'status', http: 503, body: { name: 'SERVICE_UNAVAILABLE' } });
    await expect(payout(http, batch('b1', [PUBLISHER, 100]))).rejects.toMatchObject({
      errorClass: 'TRANSIENT',
      http: 503,
    });
    const err = await payout(http, batch('b2', ['', 100])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    fake.failNext('payout', { kind: 'status', http: 400, body: { name: 'VALIDATION_ERROR' } });
    const v = await payout(http, batch('b3', [PUBLISHER, 100])).catch((e: unknown) => e);
    expect(v).toBeInstanceOf(PayPalCallError);
    expect(v).not.toBeInstanceOf(PayPalDuplicateBatch);
    expect(v).toMatchObject({ errorClass: 'TERMINAL', code: 'VALIDATION_ERROR' });
  });

  it('rejects bad input before calling PayPal', async () => {
    const { fake, http } = setup();
    await expect(payout(http, { batchId: 'b', items: [] })).rejects.toThrow(RangeError);
    await expect(payout(http, batch('b', [PUBLISHER, 10.5]))).rejects.toThrow(RangeError);
    await expect(
      payout(http, {
        batchId: 'b',
        items: [
          { itemId: 'x', email: PUBLISHER, amountCents: 1, note: '' },
          { itemId: 'x', email: PUBLISHER, amountCents: 1, note: '' },
        ],
      }),
    ).rejects.toThrow(/duplicate itemId/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('pp.getPayoutBatch: statuses (S10, S7)', () => {
  it('PENDING → PROCESSING → SUCCESS; UNCLAIMED stays in flight while the batch is SUCCESS; fees', async () => {
    const { http } = setup();
    const { payoutBatchId } = await payout(
      http,
      batch('b1', [PUBLISHER, 1_234], [PUBLISHER, 500], [UNREGISTERED, 321]),
    );
    expect((await getPayoutBatch(http, payoutBatchId)).batchStatus).toBe('PENDING');
    expect((await getPayoutBatch(http, payoutBatchId)).batchStatus).toBe('PROCESSING');
    const done = await getPayoutBatch(http, payoutBatchId);
    expect(done).toMatchObject({
      payoutBatchId,
      senderBatchId: 'b1',
      batchStatus: 'SUCCESS',
      amountCents: 2_055,
      feesCents: 75,
    });
    expect(done.items.map((i) => [i.senderItemId, i.status, i.errorCode, i.feeCents])).toEqual([
      ['b1-item0', 'SUCCESS', null, 25],
      ['b1-item1', 'SUCCESS', null, 25],
      ['b1-item2', 'UNCLAIMED', 'RECEIVER_UNREGISTERED', 25],
    ]);
  });

  it('claimPayout: UNCLAIMED → SUCCESS; returnPayout: UNCLAIMED → RETURNED', async () => {
    const { fake, http } = setup();
    const { payoutBatchId } = await payout(
      http,
      batch('b1', [UNREGISTERED, 300], [UNREGISTERED, 400]),
    );
    fake.payouts.settleBatch(payoutBatchId);
    const [a, b] = (await getPayoutBatch(http, payoutBatchId)).items;
    expect([a?.status, b?.status]).toEqual(['UNCLAIMED', 'UNCLAIMED']);

    fake.claimPayout(a!.payoutItemId);
    fake.returnPayout(b!.payoutItemId);
    expect(await getPayoutItem(http, a!.payoutItemId)).toMatchObject({
      status: 'SUCCESS',
      paypalStatus: 'SUCCESS',
      errorCode: null,
    });
    expect(await getPayoutItem(http, b!.payoutItemId)).toMatchObject({
      status: 'RETURNED',
      paypalStatus: 'RETURNED',
    });
    expect(() => fake.claimPayout(a!.payoutItemId)).toThrow(/not UNCLAIMED/);
  });

  it('paying the merchant itself → item FAILED SELF_PAY_NOT_ALLOWED, batch DENIED (S7)', async () => {
    const { fake, http } = setup();
    const { payoutBatchId } = await payout(http, batch('b1', [MERCHANT, 1_000]));
    fake.payouts.settleBatch(payoutBatchId);
    const view = await getPayoutBatch(http, payoutBatchId);
    expect(view.batchStatus).toBe('DENIED');
    expect(view.items[0]).toMatchObject({
      status: 'FAILED',
      paypalStatus: 'FAILED',
      errorCode: 'SELF_PAY_NOT_ALLOWED',
    });
  });

  it('a GET for an unknown batch is a TERMINAL 404', async () => {
    const { http } = setup();
    await expect(getPayoutBatch(http, 'NOPE')).rejects.toMatchObject({
      http: 404,
      errorClass: 'TERMINAL',
    });
  });
});

describe('normalisePayoutItemStatus', () => {
  it.each([
    ['SUCCESS', 'SUCCESS'],
    ['UNCLAIMED', 'UNCLAIMED'],
    ['RETURNED', 'RETURNED'],
    ['FAILED', 'FAILED'],
    ['BLOCKED', 'FAILED'],
    ['DENIED', 'FAILED'],
    ['REFUNDED', 'FAILED'],
    ['REVERSED', 'FAILED'],
    ['PENDING', 'PENDING'],
    ['ONHOLD', 'PENDING'],
    ['SOMETHING_NEW', 'PENDING'],
  ])('%s → %s', (paypal, ours) => {
    expect(normalisePayoutItemStatus(paypal)).toBe(ours);
  });
});
