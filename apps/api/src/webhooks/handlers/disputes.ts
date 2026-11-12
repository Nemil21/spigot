import { audit } from '../../audit/audit.js';
import type { Tx } from '../../db/index.js';
import type { PayPalWebhookEvent } from '../paypal.js';

/**
 * `CUSTOMER.DISPUTE.CREATED` (SP-059; api.md §Webhooks): audit only. Freezing the buyer's keys is
 * P2. The row carries the dispute id and the disputed capture ids, so W14's audit search finds it
 * by PayPal id; the top-up is named when one of them is ours.
 */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const handler = {
  eventTypes: ['CUSTOMER.DISPUTE.CREATED'] as const,

  async handle(tx: Tx, event: PayPalWebhookEvent): Promise<'AUDITED'> {
    const r = event.resource;
    const disputeId = str(r.dispute_id) ?? str(r.id);
    const transactions = Array.isArray(r.disputed_transactions) ? r.disputed_transactions : [];
    const captureIds = transactions
      .map((t) => str(obj(t).seller_transaction_id))
      .filter((id): id is string => id !== null);
    const topup = captureIds.length
      ? (
          await tx.query<{ id: string; buyerId: string }>(
            `SELECT id, buyer_id AS "buyerId" FROM topups WHERE paypal_capture_id = ANY($1::text[])
             LIMIT 1`,
            [captureIds],
          )
        ).rows[0]
      : undefined;
    await audit(tx, {
      actorType: 'PAYPAL_WEBHOOK',
      actorId: event.id,
      entity: topup ? 'topups' : 'webhook_events',
      entityId: topup?.id ?? null,
      action: 'DISPUTE_CREATED',
      paypalId: disputeId,
      data: {
        eventId: event.id,
        disputeId,
        captureIds,
        reason: str(r.reason),
        status: str(r.status),
        amount: obj(r.dispute_amount),
        ...(topup ? { topupId: topup.id, buyerId: topup.buyerId } : {}),
      },
    });
    return 'AUDITED';
  },
};

export default handler;
