// PayPal webhook handler for declined vault (auto top-up) captures (api.md §Webhooks; SP-047a).
// SP-059's dispatcher glob-loads `webhooks/handlers/*.ts` and calls `handle` for each event whose
// type is in `eventTypes`, inside the transaction that marks the event processed.
//
// A vault order normally captures in the create call (SP-047a settles it there); this covers a
// capture PayPal held (PENDING → the row is AWAITING_APPROVAL) and later denied. Only `VAULT_MIT`
// top-ups are handled here: FAILED + auto top-up off + audit, as for a decline at create. Other
// top-ups are left to SP-059's generic top-up handler.
import type { Tx } from '../../db/index.js';
import { failVaultTopupTx } from '../../topups/autoTopup.js';

export const eventTypes = ['PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED'] as const;

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
}

export type HandleResult = 'HANDLED' | 'SKIPPED';

/** Top-up ids are uuids; anything else isn't ours (and `id = $1` keeps the PK index). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `resource.custom_id` is the top-up id (`purchase_units[].custom_id`). */
export async function handle(tx: Tx, event: PayPalWebhookEvent): Promise<HandleResult> {
  if (!(eventTypes as readonly string[]).includes(event.event_type)) return 'SKIPPED';
  const topupId = event.resource.custom_id;
  if (typeof topupId !== 'string' || !UUID.test(topupId)) return 'SKIPPED';
  const { rows } = await tx.query<{ method: string | null }>(
    `SELECT method FROM topups WHERE id = $1`,
    [topupId],
  );
  if (rows[0]?.method !== 'VAULT_MIT') return 'SKIPPED';
  const orderId = relatedOrderId(event.resource);
  const failed = await failVaultTopupTx(tx, topupId, {
    code: event.event_type === 'PAYMENT.CAPTURE.DENIED' ? 'CAPTURE_DENIED' : 'CAPTURE_DECLINED',
    orderId,
    actor: { actorType: 'PAYPAL_WEBHOOK', actorId: event.id },
  });
  return failed ? 'HANDLED' : 'SKIPPED';
}

function relatedOrderId(resource: Record<string, unknown>): string | null {
  const related = (
    resource.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined
  )?.related_ids;
  return typeof related?.order_id === 'string' ? related.order_id : null;
}

export default { eventTypes, handle };
