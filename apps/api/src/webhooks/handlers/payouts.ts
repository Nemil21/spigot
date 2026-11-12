import { audit } from '../../audit/audit.js';
import type { Tx } from '../../db/index.js';
import { transition } from '../../db/transition.js';
import { decimalToCents } from '../../paypal/index.js';
import { applyItemStatusTx, refreshBatchStatus } from '../../payouts/reconcile.js';
import type { PayPalWebhookEvent } from '../paypal.js';

/**
 * Payout webhooks (SP-059; api.md §Webhooks, features/09 §Logic 7). Item events go through
 * SP-021's `applyItemStatusTx` in the event's transaction, so a webhook and the poller applying
 * the same status settle once (item row lock, conditional transitions, fixed ledger keys).
 *
 * SP-020's `needs_reconcile` batch (PayPal accepted it but we never learned its
 * `payout_batch_id`) is resolved here: a signed event for it carries our `sender_batch_id` (and
 * our `sender_item_id`) next to PayPal's `payout_batch_id`, which is what `reconcileBatch` checks
 * at PayPal. The batch moves SUBMITTED → PENDING with that id (`PAYOUT_SENT` audit rows, as
 * `reconcileBatch` writes) and the item is then settled as usual.
 *
 * Batch events (`PAYMENT.PAYOUTSBATCH.*`) resolve `needs_reconcile` too and re-derive the batch
 * status from its items; item outcomes come from item events or the poller (which now has the id).
 *
 * Lock order is SP-021's: the item row, then its batch.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Item event type → PayPal `transaction_status`, for a resource that doesn't carry one. */
const ITEM_EVENT_STATUS: Record<string, string> = {
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.FAILED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.DENIED': 'DENIED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED': 'RETURNED',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED': 'REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED': 'CANCELED',
  'PAYMENT.PAYOUTS-ITEM.HELD': 'ONHOLD',
};

const BATCH_EVENTS = [
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
] as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function cents(amount: unknown): number | null {
  const value = str(obj(amount).value);
  if (!value) return null;
  try {
    return decimalToCents(value);
  } catch {
    return null;
  }
}

interface BatchRow {
  id: string;
  status: string;
  paypalBatchId: string | null;
  needsReconcile: boolean;
}

/** A batch that isn't at PayPal yet as far as we know; the event is retried until it is. */
export class BatchNotSubmittedYet extends Error {
  constructor(batchId: string, status: string) {
    super(`payout batch ${batchId} is ${status}: waiting for the submit to record its PayPal id`);
    this.name = 'BatchNotSubmittedYet';
  }
}

export type PayoutWebhookResult =
  | { result: 'UNMATCHED' }
  | { result: 'BATCH_MISMATCH'; batchId: string }
  | {
      result: 'APPLIED';
      batchId: string;
      reconciled: boolean;
      changed: boolean;
      itemStatus?: string | null;
      batchStatus: string;
    };

async function batchRow(tx: Tx, batchId: string): Promise<BatchRow | null> {
  const { rows } = await tx.query<BatchRow>(
    `SELECT id, status, paypal_batch_id AS "paypalBatchId", needs_reconcile AS "needsReconcile"
     FROM payout_batches WHERE id = $1`,
    [batchId],
  );
  return rows[0] ?? null;
}

/**
 * Make sure `batch` is the PayPal batch `paypalBatchId`. Returns whether it was a
 * `needs_reconcile` batch resolved now, or null when the ids disagree (nothing written).
 * Throws `BatchNotSubmittedYet` for a batch our submit hasn't finished with.
 */
async function ensureBatchId(
  tx: Tx,
  batch: BatchRow,
  paypalBatchId: string | null,
  event: PayPalWebhookEvent,
): Promise<boolean | null> {
  if (batch.paypalBatchId) {
    return !paypalBatchId || paypalBatchId === batch.paypalBatchId ? false : null;
  }
  if (!(batch.status === 'SUBMITTED' && batch.needsReconcile)) {
    // BUILDING / SUBMITTED mid-call: the 201 handler stores the id; try again next tick.
    throw new BatchNotSubmittedYet(batch.id, batch.status);
  }
  if (!paypalBatchId) return null;
  const taken = await tx.query(
    `SELECT 1 FROM payout_batches WHERE paypal_batch_id = $1 AND id <> $2`,
    [paypalBatchId, batch.id],
  );
  if (taken.rowCount) return null;
  const moved = await transition(tx, 'payout_batches', batch.id, 'SUBMITTED', 'PENDING', {
    paypal_batch_id: paypalBatchId,
    needs_reconcile: false,
    updated_at: new Date(),
  });
  if (!moved) throw new Error(`payout batch ${batch.id} changed while reconciling; retry`);
  const items = await tx.query<{ id: string; publisherId: string; netCents: number }>(
    `SELECT id, publisher_id AS "publisherId", net_cents AS "netCents"
     FROM payout_items WHERE batch_id = $1 ORDER BY id`,
    [batch.id],
  );
  for (const item of items.rows) {
    await audit(tx, {
      actorType: 'PAYPAL_WEBHOOK',
      actorId: event.id,
      publisherId: item.publisherId,
      entity: 'payout_item',
      entityId: item.id,
      action: 'PAYOUT_SENT',
      paypalId: paypalBatchId,
      data: { batchId: batch.id, netCents: item.netCents, reconciled: true, eventId: event.id },
    });
  }
  return true;
}

/** `PAYMENT.PAYOUTS-ITEM.*`: the resource is the payout item. */
async function itemEvent(tx: Tx, event: PayPalWebhookEvent): Promise<PayoutWebhookResult> {
  const r = event.resource;
  const payoutItem = obj(r.payout_item);
  const senderItemId = str(payoutItem.sender_item_id) ?? str(r.sender_item_id);
  const paypalItemId = str(r.payout_item_id);
  const paypalBatchId = str(r.payout_batch_id);
  const senderBatchId = str(r.sender_batch_id) ?? str(payoutItem.sender_batch_id);

  // Lock the item first (SP-021's order: item, then batch).
  let item: { id: string; batchId: string } | undefined;
  if (senderItemId && UUID.test(senderItemId)) {
    item = (
      await tx.query<{ id: string; batchId: string }>(
        `SELECT id, batch_id AS "batchId" FROM payout_items WHERE id = $1 FOR UPDATE`,
        [senderItemId],
      )
    ).rows[0];
  }
  if (!item && paypalItemId) {
    item = (
      await tx.query<{ id: string; batchId: string }>(
        `SELECT id, batch_id AS "batchId" FROM payout_items WHERE paypal_item_id = $1 FOR UPDATE`,
        [paypalItemId],
      )
    ).rows[0];
  }
  if (!item) return { result: 'UNMATCHED' };
  if (senderBatchId && senderBatchId !== item.batchId) {
    return { result: 'BATCH_MISMATCH', batchId: item.batchId };
  }
  const batch = await batchRow(tx, item.batchId);
  if (!batch) return { result: 'UNMATCHED' };
  const reconciled = await ensureBatchId(tx, batch, paypalBatchId, event);
  if (reconciled === null) return { result: 'BATCH_MISMATCH', batchId: batch.id };

  const paypalStatus =
    str(r.transaction_status) ?? ITEM_EVENT_STATUS[event.event_type] ?? 'PENDING';
  const applied = await applyItemStatusTx(tx, {
    itemId: item.id,
    paypalStatus,
    paypalItemId,
    errorCode: str(obj(r.errors).name),
    feeCents: cents(r.payout_item_fee),
    paypalBatchId: paypalBatchId ?? batch.paypalBatchId,
    actorType: 'PAYPAL_WEBHOOK',
    actorId: event.id,
  });
  const batchStatus = applied.changed
    ? applied.batchStatus
    : await refreshBatchStatus(tx, batch.id);
  return {
    result: 'APPLIED',
    batchId: batch.id,
    reconciled,
    changed: applied.changed,
    itemStatus: applied.status,
    batchStatus,
  };
}

/** `PAYMENT.PAYOUTSBATCH.*`: the resource is `{ batch_header }`. */
async function batchEvent(tx: Tx, event: PayPalWebhookEvent): Promise<PayoutWebhookResult> {
  const header = obj(event.resource.batch_header);
  const paypalBatchId = str(header.payout_batch_id);
  const senderBatchId = str(obj(header.sender_batch_header).sender_batch_id);
  let batch: BatchRow | null = null;
  if (senderBatchId && UUID.test(senderBatchId)) batch = await batchRow(tx, senderBatchId);
  if (!batch && paypalBatchId) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM payout_batches WHERE paypal_batch_id = $1`,
      [paypalBatchId],
    );
    if (rows[0]) batch = await batchRow(tx, rows[0].id);
  }
  if (!batch) return { result: 'UNMATCHED' };
  const reconciled = await ensureBatchId(tx, batch, paypalBatchId, event);
  if (reconciled === null) return { result: 'BATCH_MISMATCH', batchId: batch.id };
  const batchStatus = await refreshBatchStatus(
    tx,
    batch.id,
    str(header.batch_status)?.toUpperCase() === 'PROCESSING',
  );
  return { result: 'APPLIED', batchId: batch.id, reconciled, changed: false, batchStatus };
}

const handler = {
  eventTypes: [...Object.keys(ITEM_EVENT_STATUS), ...BATCH_EVENTS],

  handle(tx: Tx, event: PayPalWebhookEvent): Promise<PayoutWebhookResult> {
    return event.event_type.startsWith('PAYMENT.PAYOUTSBATCH.')
      ? batchEvent(tx, event)
      : itemEvent(tx, event);
  },
};

export default handler;
