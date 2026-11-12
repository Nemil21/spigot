import { getPayoutBatch, getPayoutItem, payout, type PayoutInput } from './payouts.js';
import { getRefund, refundCapture, type RefundCaptureOptions } from './refunds.js';
import type { PayPalTransport } from './transport.js';
import { verifyWebhook, type WebhookHeaders } from './webhooks.js';

/**
 * The SP-001c calls bound to one transport, so callers write `pp.refundCapture(…)`. SP-001b's
 * `createPayPalClient` spreads this into its client (`moneyOut(http, config.PAYPAL_WEBHOOK_ID)`).
 */
export function moneyOut(http: PayPalTransport, webhookId: string | undefined) {
  return {
    refundCapture: (
      captureId: string,
      amountCents: number,
      refundId: string,
      opts?: RefundCaptureOptions,
    ) => refundCapture(http, captureId, amountCents, refundId, opts),
    getRefund: (refundId: string) => getRefund(http, refundId),
    payout: (input: PayoutInput) => payout(http, input),
    getPayoutBatch: (payoutBatchId: string) => getPayoutBatch(http, payoutBatchId),
    getPayoutItem: (payoutItemId: string) => getPayoutItem(http, payoutItemId),
    verifyWebhook: (headers: WebhookHeaders, rawBody: string) =>
      verifyWebhook(http, webhookId, headers, rawBody),
  };
}

export type MoneyOutClient = ReturnType<typeof moneyOut>;

export * from './transport.js';
export * from './refunds.js';
export * from './payouts.js';
export * from './webhooks.js';
