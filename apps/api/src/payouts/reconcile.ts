import type pg from 'pg';
import {
  centsToMicros,
  payoutUnclaimedMessage,
  PUBLISHER_EVENTS_CHANNEL,
  publisherEvent,
} from '@spigot/shared';
import { audit, type ActorType } from '../audit/audit.js';
import { notify } from '../db/notify.js';
import { transition } from '../db/transition.js';
import { createDb, type Tx } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { payoutReturnedEntries, payoutSettledEntries } from '../ledger/postings.js';
import { normalisePayoutItemStatus } from '../paypal/payouts.js';
import { PAYOUT_ALERT } from './submit.js';

/**
 * SP-021 item reconcile (features/09 §Logic 7–8; data-model.md §Payout item state machine), shared
 * by the poller (`poll.ts`) and SP-059's payout webhooks.
 *
 * `applyItemStatus` runs in **one transaction** per item: it locks the item row `FOR UPDATE`, so a
 * poller and a webhook applying the same status at once serialise; the second sees the new status
 * and does nothing. Every move is a conditional `transition` and every ledger post has a fixed
 * idempotency key, so a replay can't post twice even without the row lock:
 * - `SUCCESS` (from PENDING or UNCLAIMED) → item SUCCESS, `PAYOUT_SETTLED` (key
 *   `payout_settled:<itemId>`), `fee_cents` from `payout_item_fee`.
 * - `UNCLAIMED` (from PENDING) → item UNCLAIMED: money stays in flight; alert "claim it with …".
 * - `FAILED | BLOCKED | DENIED | RETURNED | REFUNDED | …` → item FAILED (from PENDING) or RETURNED
 *   (from UNCLAIMED, the 30-day return), `PAYOUT_RETURNED` (key `payout_returned:<itemId>`, the
 *   key SP-020 uses for a refused batch): the amount is back in payable for the next run.
 * - `PENDING` / `ONHOLD` / unknown → no move (keep polling); a new `paypal_item_id` is still saved.
 * - Anything on an item already SUCCESS / FAILED / RETURNED → no move (terminal; logged in audit
 *   data only when it disagrees, never re-posted).
 * Then the batch status is re-derived (`refreshBatchStatus`), `payout.updated` is NOTIFYed and an
 * audit row with the PayPal ids is written, all in the same transaction.
 */

export type ItemStatus = 'PENDING' | 'SUCCESS' | 'UNCLAIMED' | 'RETURNED' | 'FAILED';

export interface ItemStatusUpdate {
  /** `payout_items.id` (= `sender_item_id`). */
  itemId: string;
  /** PayPal's `transaction_status` as sent (`SUCCESS`, `UNCLAIMED`, `BLOCKED`, …). */
  paypalStatus: string;
  paypalItemId?: string | null;
  /** `errors.name`, e.g. `RECEIVER_UNREGISTERED`. */
  errorCode?: string | null;
  /** `payout_item_fee` in cents (stored on `fee_cents`, outside the ledger). */
  feeCents?: number | null;
  /** The PayPal batch id, for the audit row. */
  paypalBatchId?: string | null;
  /** Who saw the status: the poller (`WORKFLOW`), a webhook (`PAYPAL_WEBHOOK`), an admin. */
  actorType?: ActorType;
  actorId?: string;
}

export type ApplyOutcome =
  | { changed: false; itemId: string; status: ItemStatus | null; reason: 'NOT_FOUND' | 'NO_CHANGE' }
  | { changed: true; itemId: string; from: ItemStatus; status: ItemStatus; batchStatus: string };

interface ItemRow {
  id: string;
  batchId: string;
  publisherId: string;
  receiverEmail: string | null;
  netCents: number;
  status: ItemStatus;
  paypalItemId: string | null;
  feeCents: number | null;
}

const TERMINAL_ITEM = new Set<ItemStatus>(['SUCCESS', 'FAILED', 'RETURNED']);

export const UNCLAIMED_ALERT_CODE = 'RECEIVER_UNREGISTERED';
const DEFAULT_ACTOR = 'payoutReconcile';

/** "publisher@…": enough for the publisher to recognise the address, not the whole email. */
export function maskEmail(email: string | null): string {
  if (!email) return 'your payout email';
  const at = email.indexOf('@');
  return at > 0 ? `${email.slice(0, at)}@…` : `${email.slice(0, 1)}…`;
}

/** The status an item moves to from `from` on PayPal's `paypalStatus`, or null for no move. */
export function nextItemStatus(from: ItemStatus, paypalStatus: string): ItemStatus | null {
  const seen = normalisePayoutItemStatus(paypalStatus);
  if (seen === 'PENDING' || seen === from) return null;
  if (from === 'PENDING') {
    if (seen === 'SUCCESS' || seen === 'UNCLAIMED') return seen;
    // RETURNED before UNCLAIMED isn't an edge: a refusal from PENDING is FAILED.
    return 'FAILED';
  }
  if (from === 'UNCLAIMED') {
    if (seen === 'SUCCESS') return 'SUCCESS';
    if (seen === 'FAILED' || seen === 'RETURNED') return 'RETURNED';
  }
  return null;
}

/** Apply PayPal's status for one item in its own transaction on `pool`. */
export async function applyItemStatus(
  pool: pg.Pool,
  update: ItemStatusUpdate,
): Promise<ApplyOutcome> {
  return createDb(pool).tx((tx) => applyItemStatusTx(tx, update));
}

/** `applyItemStatus` inside the caller's transaction (SP-059 also records the webhook event). */
export async function applyItemStatusTx(tx: Tx, u: ItemStatusUpdate): Promise<ApplyOutcome> {
  const item = (
    await tx.query<ItemRow>(
      `SELECT id, batch_id AS "batchId", publisher_id AS "publisherId",
              receiver_email AS "receiverEmail", net_cents AS "netCents", status,
              paypal_item_id AS "paypalItemId", fee_cents AS "feeCents"
       FROM payout_items WHERE id = $1 FOR UPDATE`,
      [u.itemId],
    )
  ).rows[0];
  if (!item) return { changed: false, itemId: u.itemId, status: null, reason: 'NOT_FOUND' };

  const paypalItemId = u.paypalItemId || null;
  const feeCents = u.feeCents ?? null;
  const to = TERMINAL_ITEM.has(item.status) ? null : nextItemStatus(item.status, u.paypalStatus);

  if (!to) {
    // No move; still remember PayPal's item id (and a fee) the first time we see them.
    if ((paypalItemId && !item.paypalItemId) || (feeCents !== null && item.feeCents === null)) {
      await tx.query(
        `UPDATE payout_items SET paypal_item_id = coalesce(paypal_item_id, $2),
                fee_cents = coalesce(fee_cents, $3), updated_at = now()
         WHERE id = $1`,
        [item.id, paypalItemId, feeCents],
      );
    }
    return { changed: false, itemId: item.id, status: item.status, reason: 'NO_CHANGE' };
  }

  const extra: Record<string, unknown> = { updated_at: new Date() };
  if (paypalItemId) extra.paypal_item_id = paypalItemId;
  if (feeCents !== null) extra.fee_cents = feeCents;
  if (to !== 'SUCCESS' && u.errorCode) extra.error_code = u.errorCode;
  const moved = await transition(tx, 'payout_items', item.id, item.status, to, extra);
  // The row is locked, so this only happens if the status changed under a broken caller.
  if (!moved) return { changed: false, itemId: item.id, status: item.status, reason: 'NO_CHANGE' };

  const actorType = u.actorType ?? 'WORKFLOW';
  const actorId = u.actorId ?? DEFAULT_ACTOR;
  const amountMicros = centsToMicros(item.netCents);
  const paypalId = paypalItemId ?? item.paypalItemId;
  const data = {
    batchId: item.batchId,
    paypalBatchId: u.paypalBatchId ?? null,
    paypalItemId: paypalId,
    paypalStatus: u.paypalStatus,
    from: item.status,
    to,
    netCents: item.netCents,
    ...(feeCents !== null ? { feeCents } : {}),
    ...(u.errorCode ? { errorCode: u.errorCode } : {}),
  };

  if (to === 'SUCCESS') {
    const platform = await platformAccounts(tx);
    await post(tx, {
      kind: 'PAYOUT_SETTLED',
      idempotencyKey: `payout_settled:${item.id}`,
      refType: 'payout_item',
      refId: item.id,
      memo: `PayPal paid out item ${paypalId ?? item.id}`,
      entries: payoutSettledEntries(
        { payoutsInFlight: platform.payoutsInFlight, paypalCash: platform.paypalCash },
        amountMicros,
      ),
    });
    await audit(tx, {
      actorType,
      actorId,
      publisherId: item.publisherId,
      entity: 'payout_item',
      entityId: item.id,
      action: 'PAYOUT_SETTLED',
      paypalId,
      data,
    });
  } else if (to === 'UNCLAIMED') {
    const message =
      payoutUnclaimedMessage({
        amountCents: item.netCents,
        payoutEmail: maskEmail(item.receiverEmail),
      }) + ` Claim it with ${maskEmail(item.receiverEmail)} within 30 days.`;
    await audit(tx, {
      actorType,
      actorId,
      publisherId: item.publisherId,
      entity: 'payout_item',
      entityId: item.id,
      action: PAYOUT_ALERT,
      paypalId,
      data: { ...data, code: u.errorCode ?? UNCLAIMED_ALERT_CODE, message },
    });
  } else {
    const platform = await platformAccounts(tx);
    const payable = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', item.publisherId);
    await post(tx, {
      kind: 'PAYOUT_RETURNED',
      idempotencyKey: `payout_returned:${item.id}`,
      refType: 'payout_item',
      refId: item.id,
      memo: `PayPal ${u.paypalStatus} item ${paypalId ?? item.id}${u.errorCode ? `: ${u.errorCode}` : ''}`,
      entries: payoutReturnedEntries(
        { payoutsInFlight: platform.payoutsInFlight, publisher: payable },
        amountMicros,
      ),
    });
    await audit(tx, {
      actorType,
      actorId,
      publisherId: item.publisherId,
      entity: 'payout_item',
      entityId: item.id,
      action: 'PAYOUT_RETURNED',
      paypalId,
      data,
    });
  }

  const batchStatus = await refreshBatchStatus(tx, item.batchId);
  await notify(
    tx,
    PUBLISHER_EVENTS_CHANNEL,
    publisherEvent(item.publisherId, 'payout.updated', [item.batchId]),
  );
  return { changed: true, itemId: item.id, from: item.status, status: to, batchStatus };
}

/**
 * Re-derive a submitted batch's status from its items (locks the batch row; items are always
 * locked before their batch, so two items of one batch never deadlock):
 * - any item PENDING or UNCLAIMED → the batch is still in flight: PENDING moves to PROCESSING once
 *   an item has resolved (`paypalProcessing` also moves it when PayPal says PROCESSING);
 * - every item SUCCESS → SUCCESS; every item FAILED / RETURNED → DENIED; a mix → PARTIAL.
 * An UNCLAIMED item keeps its batch PROCESSING (not PARTIAL, which is terminal), so its later
 * `UNCLAIMED → SUCCESS` can still finish the batch as SUCCESS.
 */
export async function refreshBatchStatus(
  tx: Tx,
  batchId: string,
  paypalProcessing = false,
): Promise<string> {
  const batch = (
    await tx.query<{ status: string }>(
      `SELECT status FROM payout_batches WHERE id = $1 FOR UPDATE`,
      [batchId],
    )
  ).rows[0];
  if (!batch) throw new Error(`payout batch ${batchId} not found`);
  if (batch.status !== 'PENDING' && batch.status !== 'PROCESSING') return batch.status;

  const { rows } = await tx.query<{ status: ItemStatus; n: number }>(
    `SELECT status, count(*)::int AS n FROM payout_items WHERE batch_id = $1 GROUP BY status`,
    [batchId],
  );
  const count = (s: ItemStatus) => rows.find((r) => r.status === s)?.n ?? 0;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const inFlight = count('PENDING') + count('UNCLAIMED');
  const resolved = total - count('PENDING');

  let to: 'PROCESSING' | 'SUCCESS' | 'PARTIAL' | 'DENIED' | null = null;
  if (total > 0 && inFlight === 0) {
    to =
      count('SUCCESS') === total
        ? 'SUCCESS'
        : count('FAILED') + count('RETURNED') === total
          ? 'DENIED'
          : 'PARTIAL';
  } else if (batch.status === 'PENDING' && (resolved > 0 || paypalProcessing)) {
    to = 'PROCESSING';
  }
  if (!to || to === batch.status) return batch.status;
  const moved = await transition(
    tx,
    'payout_batches',
    batchId,
    batch.status as 'PENDING' | 'PROCESSING',
    to,
    { updated_at: new Date() },
  );
  return moved ? to : batch.status;
}

/** NOTIFY `payout.updated` for each publisher with an item in `batchId` (after a run). */
export async function notifyBatchPublishers(q: pg.Pool | Tx, batchId: string): Promise<void> {
  const { rows } = await q.query<{ publisherId: string }>(
    `SELECT DISTINCT publisher_id AS "publisherId" FROM payout_items WHERE batch_id = $1`,
    [batchId],
  );
  for (const r of rows) {
    await notify(
      q,
      PUBLISHER_EVENTS_CHANNEL,
      publisherEvent(r.publisherId, 'payout.updated', [batchId]),
    );
  }
}
