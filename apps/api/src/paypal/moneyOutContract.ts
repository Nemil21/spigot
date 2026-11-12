import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MoneyOutClient } from './moneyOut.js';
import { PayPalDuplicateBatch } from './payouts.js';
import { PayPalRefundExceeded } from './refunds.js';

/**
 * The SP-001c contract suite: the same assertions against FakePayPal (CI) and the PayPal sandbox
 * (locally, once: `PAYPAL_MODE=sandbox npx vitest run apps/api/src/paypal/moneyOut.sandbox.contract.test.ts`).
 * Every expectation here is a sandbox fact from SP-003 (S9, S10, S11).
 */
export interface MoneyOutContractEnv {
  pp: MoneyOutClient;
  /** A COMPLETED capture of `amountCents`; returns its capture id. */
  makeCapture(amountCents: number): Promise<string>;
  /** A receiver that isn't the merchant (sandbox: `DEMO_PUBLISHER_PAYOUT_EMAIL`). */
  payoutEmail: string;
}

export function describeMoneyOutContract(
  name: string,
  setup: () => Promise<MoneyOutContractEnv>,
  timeoutMs = 5_000,
): void {
  describe(`SP-001c contract: ${name}`, () => {
    it(
      'S9: partial refunds, replay by request id, cumulative cap',
      async () => {
        const { pp, makeCapture } = await setup();
        const captureId = await makeCapture(2_000);
        const idA = randomUUID();

        const first = await pp.refundCapture(captureId, 740, idA);
        expect(first).toMatchObject({ status: 'COMPLETED', amountCents: 740, replayed: false });
        expect(first.captureId).toBe(captureId);

        // Replay with the same id, even with a different amount → the original refund.
        const replay = await pp.refundCapture(captureId, 300, idA);
        expect(replay).toMatchObject({
          refundId: first.refundId,
          amountCents: 740,
          status: 'COMPLETED',
          replayed: true,
        });

        const second = await pp.refundCapture(captureId, 500, randomUUID());
        expect(second.refundId).not.toBe(first.refundId);
        expect(second.status).toBe('COMPLETED');

        // $7.60 left: $10 is refused.
        const over = pp.refundCapture(captureId, 1_000, randomUUID());
        await expect(over).rejects.toBeInstanceOf(PayPalRefundExceeded);
        await expect(over).rejects.toMatchObject({
          http: 422,
          code: 'REFUND_AMOUNT_EXCEEDED',
          errorClass: 'TERMINAL',
        });

        const got = await pp.getRefund(first.refundId);
        expect(got).toMatchObject({
          refundId: first.refundId,
          status: 'COMPLETED',
          amountCents: 740,
        });
      },
      timeoutMs,
    );

    it(
      'S10: payout accepted PENDING; the same sender_batch_id again is a duplicate, never a 2nd payout',
      async () => {
        const { pp, payoutEmail } = await setup();
        const batchId = randomUUID();
        const itemId = randomUUID();
        const accepted = await pp.payout({
          batchId,
          items: [{ itemId, email: payoutEmail, amountCents: 100, note: 'Spigot: contract test' }],
        });
        expect(accepted.senderBatchId).toBe(batchId);
        expect(accepted.payoutBatchId).toEqual(expect.any(String));
        expect(['PENDING', 'PROCESSING', 'SUCCESS']).toContain(accepted.batchStatus);

        const dup = pp.payout({
          batchId,
          items: [{ itemId, email: payoutEmail, amountCents: 100, note: 'Spigot: contract test' }],
        });
        await expect(dup).rejects.toBeInstanceOf(PayPalDuplicateBatch);
        const err = (await dup.catch((e: unknown) => e)) as PayPalDuplicateBatch;
        expect(err.errorClass).toBe('RECONCILE');
        expect(err.senderBatchId).toBe(batchId);
        // S10: PayPal returned no payout_batch_id; if it ever does, it must be this batch.
        if (err.payoutBatchId !== null) expect(err.payoutBatchId).toBe(accepted.payoutBatchId);

        const batch = await pp.getPayoutBatch(accepted.payoutBatchId);
        expect(batch.senderBatchId).toBe(batchId);
        expect(batch.items).toHaveLength(1);
        expect(batch.items[0]).toMatchObject({ senderItemId: itemId, amountCents: 100 });
      },
      timeoutMs,
    );

    it(
      'S11: a bad signature is false (200 FAILURE), missing headers false without a call',
      async () => {
        const { pp } = await setup();
        const rawBody =
          '{"id":"WH-CONTRACT","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{}}';
        const headers = {
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url':
            'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270',
          'paypal-transmission-id': randomUUID(),
          'paypal-transmission-sig': 'bm90IGEgc2lnbmF0dXJl',
          'paypal-transmission-time': new Date().toISOString(),
        };
        await expect(pp.verifyWebhook(headers, rawBody)).resolves.toBe(false);
        const { 'paypal-transmission-sig': _sig, ...missing } = headers;
        await expect(pp.verifyWebhook(missing, rawBody)).resolves.toBe(false);
      },
      timeoutMs,
    );
  });
}
