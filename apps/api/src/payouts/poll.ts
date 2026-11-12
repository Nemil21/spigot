import { audit } from '../audit/audit.js';
import { transition } from '../db/transition.js';
import { createDb } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { PayPalCallError } from '../paypal/transport.js';
import type { PayoutDeps } from './deps.js';
import { applyItemStatus, refreshBatchStatus, type ApplyOutcome } from './reconcile.js';

/**
 * SP-021 payout status polling (features/09 §Logic 7; api.md `pp.getPayoutBatch`):
 * - `pollRecentBatches`: every 60 s (`jobs/payout-poll.job.ts`), each PENDING / PROCESSING batch
 *   submitted in the last 30 min.
 * - `pollStaleBatches`: daily (`jobs/payout-daily.job.ts`), every batch still in flight after
 *   that window (PENDING / PROCESSING, or with an UNCLAIMED item), so UNCLAIMED items resolve
 *   without webhooks and SP-020's "skip publishers with an UNCLAIMED item" rule can't block a
 *   publisher forever.
 * - `reconcileBatch`: `POST /admin/payouts/:batchId/reconcile` for SP-020's `needs_reconcile`.
 * PayPal is called outside any transaction; each item is then applied in its own transaction.
 */

export const POLL_EVERY_MS = 60_000;
export const POLL_WINDOW_MS = 30 * 60_000;
export const DAILY_MS = 24 * 60 * 60_000;

export interface PollResult {
  batchId: string;
  paypalBatchId: string;
  paypalStatus: string;
  batchStatus: string;
  applied: ApplyOutcome[];
}

interface BatchRow {
  id: string;
  status: string;
  paypalBatchId: string | null;
}

/** When the batch went to PayPal: its first `PAYOUT_SENT` audit row, else its creation. */
const SUBMITTED_AT = `coalesce(
  (SELECT min(a.at) FROM payout_items i
     JOIN audit_events a ON a.entity = 'payout_item' AND a.entity_id = i.id AND a.action = 'PAYOUT_SENT'
   WHERE i.batch_id = b.id),
  b.created_at)`;

const IN_FLIGHT = `b.paypal_batch_id IS NOT NULL AND (
  b.status IN ('PENDING', 'PROCESSING')
  OR EXISTS (SELECT 1 FROM payout_items u WHERE u.batch_id = b.id AND u.status = 'UNCLAIMED'))`;

/** Poll one batch at PayPal and apply every item's status. */
export async function pollBatch(deps: PayoutDeps, batchId: string): Promise<PollResult | null> {
  const batch = (
    await deps.pool.query<BatchRow>(
      `SELECT id, status, paypal_batch_id AS "paypalBatchId" FROM payout_batches WHERE id = $1`,
      [batchId],
    )
  ).rows[0];
  if (!batch?.paypalBatchId) return null;
  const paypalBatchId = batch.paypalBatchId;

  const view = await deps.pp.getPayoutBatch(paypalBatchId);
  const ours = (
    await deps.pool.query<{ id: string; paypalItemId: string | null }>(
      `SELECT id, paypal_item_id AS "paypalItemId" FROM payout_items WHERE batch_id = $1`,
      [batchId],
    )
  ).rows;
  const byId = new Set(ours.map((i) => i.id));
  const byPaypalId = new Map(
    ours.filter((i) => i.paypalItemId).map((i) => [i.paypalItemId!, i.id]),
  );

  const applied: ApplyOutcome[] = [];
  for (const it of view.items) {
    // Only items of this batch: never let a PayPal answer touch another batch's rows.
    const itemId =
      it.senderItemId && byId.has(it.senderItemId)
        ? it.senderItemId
        : byPaypalId.get(it.payoutItemId);
    if (!itemId) continue;
    applied.push(
      await applyItemStatus(deps.pool, {
        itemId,
        paypalStatus: it.paypalStatus,
        paypalItemId: it.payoutItemId || null,
        errorCode: it.errorCode,
        feeCents: it.feeCents,
        paypalBatchId,
        actorType: 'WORKFLOW',
        actorId: 'payoutPoll',
      }),
    );
  }

  const batchStatus = await createDb(deps.pool).tx((tx) =>
    refreshBatchStatus(tx, batchId, view.batchStatus.toUpperCase() === 'PROCESSING'),
  );
  return { batchId, paypalBatchId, paypalStatus: view.batchStatus, batchStatus, applied };
}

async function pollWhere(
  deps: PayoutDeps,
  where: string,
  log: (msg: string, err: unknown) => void,
): Promise<PollResult[]> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT b.id FROM payout_batches b WHERE ${IN_FLIGHT} AND ${where} ORDER BY b.created_at, b.id`,
    [POLL_WINDOW_MS / 1000],
  );
  const results: PollResult[] = [];
  for (const { id } of rows) {
    try {
      const r = await pollBatch(deps, id);
      if (r) results.push(r);
    } catch (err) {
      // One batch PayPal can't answer for doesn't stop the others; the next tick retries it.
      log(`payout poll failed for batch ${id}`, err);
    }
  }
  return results;
}

const defaultLog = (msg: string, err: unknown) =>
  console.error(`[payouts] ${msg}: ${err instanceof Error ? err.message : String(err)}`);

/** Every in-flight batch submitted within the last 30 min (the 60-s job). */
export function pollRecentBatches(deps: PayoutDeps, log = defaultLog): Promise<PollResult[]> {
  return pollWhere(
    deps,
    `b.status IN ('PENDING', 'PROCESSING') AND ${SUBMITTED_AT} >= now() - make_interval(secs => $1)`,
    log,
  );
}

/** Every batch still in flight after its 30-min window (the daily job). */
export function pollStaleBatches(deps: PayoutDeps, log = defaultLog): Promise<PollResult[]> {
  return pollWhere(deps, `${SUBMITTED_AT} < now() - make_interval(secs => $1)`, log);
}

/**
 * Resolve SP-020's `needs_reconcile` batch: PayPal has it but never told us its id. Checks at
 * PayPal that `paypalBatchId` really is this batch (its `sender_batch_id` = our id) before saving
 * it, moves the batch SUBMITTED → PENDING and applies the item statuses.
 */
export async function reconcileBatch(
  deps: PayoutDeps,
  batchId: string,
  paypalBatchId: string,
  actorId: string,
): Promise<PollResult> {
  const batch = (
    await deps.pool.query<BatchRow & { needsReconcile: boolean }>(
      `SELECT id, status, paypal_batch_id AS "paypalBatchId", needs_reconcile AS "needsReconcile"
       FROM payout_batches WHERE id = $1`,
      [batchId],
    )
  ).rows[0];
  if (!batch) throw new ApiError('NOT_FOUND', 'No such payout batch.');
  const already = batch.paypalBatchId === paypalBatchId && !batch.needsReconcile;
  if (!already && !(batch.status === 'SUBMITTED' && batch.needsReconcile)) {
    throw new ApiError(
      'STATE_CONFLICT',
      `Payout batch is ${batch.status}${batch.needsReconcile ? '' : ' and not waiting for reconcile'}.`,
    );
  }

  if (!already) {
    let senderBatchId: string | null;
    try {
      senderBatchId = (await deps.pp.getPayoutBatch(paypalBatchId)).senderBatchId;
    } catch (err) {
      if (err instanceof PayPalCallError && err.http === 404) {
        throw new ApiError('VALIDATION_ERROR', 'PayPal has no payout batch with that id.');
      }
      throw err;
    }
    if (senderBatchId !== batchId) {
      throw new ApiError(
        'VALIDATION_ERROR',
        "That PayPal payout batch's sender_batch_id is not this batch.",
      );
    }
    await createDb(deps.pool).tx(async (tx) => {
      const taken = await tx.query(
        `SELECT 1 FROM payout_batches WHERE paypal_batch_id = $1 AND id <> $2`,
        [paypalBatchId, batchId],
      );
      if (taken.rowCount) {
        throw new ApiError('STATE_CONFLICT', 'That PayPal batch id belongs to another batch.');
      }
      const moved = await transition(tx, 'payout_batches', batchId, 'SUBMITTED', 'PENDING', {
        paypal_batch_id: paypalBatchId,
        needs_reconcile: false,
        updated_at: new Date(),
      });
      if (!moved) throw new ApiError('STATE_CONFLICT', 'Payout batch changed; try again.');
      const items = await tx.query<{ id: string; publisherId: string; netCents: number }>(
        `SELECT id, publisher_id AS "publisherId", net_cents AS "netCents"
         FROM payout_items WHERE batch_id = $1 ORDER BY id`,
        [batchId],
      );
      for (const item of items.rows) {
        await audit(tx, {
          actorType: 'PUBLISHER',
          actorId,
          publisherId: item.publisherId,
          entity: 'payout_item',
          entityId: item.id,
          action: 'PAYOUT_SENT',
          paypalId: paypalBatchId,
          data: { batchId, netCents: item.netCents, reconciled: true },
        });
      }
    });
  }

  const polled = await pollBatch(deps, batchId);
  if (!polled) throw new Error(`payout batch ${batchId} has no paypal_batch_id after reconcile`);
  return polled;
}
