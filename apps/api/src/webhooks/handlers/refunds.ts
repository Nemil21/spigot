import type { Tx } from '../../db/index.js';
import { applyRefundView, type SettleOutcome } from '../../refunds/refund.js';

/**
 * `PAYMENT.CAPTURE.REFUNDED` (SP-049), for SP-059's glob-loaded dispatcher. The event's `resource`
 * is the refund; it is matched to `balance_refunds` by `paypal_refund_id` and recorded with the
 * same conditional updates the POST answer and the sweep's poll use, so whichever lands first wins
 * and the others change nothing. A refund we haven't stored the PayPal id for yet (still
 * REQUESTED) is left alone: the sweep replays it with its request id and gets the same refund.
 *
 * SP-059 owns the handler contract; until it merges, this file defines the shape it expects:
 * `{ eventTypes, handle(tx, event) }`, run inside the transaction that marks the event processed.
 */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
}

export type HandleResult = SettleOutcome | 'UNMATCHED';

const handler = {
  eventTypes: ['PAYMENT.CAPTURE.REFUNDED'] as const,

  async handle(tx: Tx, event: PayPalWebhookEvent): Promise<HandleResult> {
    const refundId = typeof event.resource.id === 'string' ? event.resource.id : null;
    if (!refundId) return 'UNMATCHED';
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM balance_refunds WHERE paypal_refund_id = $1`,
      [refundId],
    );
    const row = rows[0];
    if (!row) return 'UNMATCHED';
    const status = event.resource.status;
    return applyRefundView(tx, row.id, {
      refundId,
      // The event means "refunded"; trust an explicit non-final status if PayPal sends one.
      status:
        status === 'PENDING' || status === 'FAILED' || status === 'CANCELLED'
          ? status
          : 'COMPLETED',
      amountCents: null,
      captureId: null,
      statusReason: null,
      replayed: false,
    });
  },
};

export default handler;
