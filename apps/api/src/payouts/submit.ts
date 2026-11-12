import type pg from 'pg';
import { centsToMicros } from '@spigot/shared';
import { transition } from '../db/transition.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { payoutReturnedEntries } from '../ledger/postings.js';
import type { MoneyOutClient } from '../paypal/moneyOut.js';
import { PayPalDuplicateBatch, PayPalInsufficientFunds } from '../paypal/payouts.js';
import { PayPalCallError } from '../paypal/transport.js';
import { inTx, statementFor } from './buildBatch.js';

/**
 * SP-020 steps 4b–7 (features/09 §Logic 5–6): submit a built batch to PayPal Payouts.
 *
 * - `BUILDING → SUBMITTED` before the call, so a crash after it is distinguishable from one
 *   before it. Both are resumed by the next run with the same `sender_batch_id`.
 * - 201 → batch PENDING with `paypal_batch_id`, audit `PAYOUT_SENT` per item.
 * - No answer / 5xx / 429 → retry the same `sender_batch_id` (3 tries), then leave it SUBMITTED.
 * - Duplicate batch (the first try reached PayPal): with a `payout_batch_id` → PENDING; without
 *   one (S10: PayPal sends none, and Payouts v1 has no lookup by `sender_batch_id`) →
 *   `needs_reconcile`, items stay PENDING, money stays in flight, alert. SP-059's webhook or
 *   `POST /admin/payouts/:batchId/reconcile` (SP-021) resolves it.
 * - Definite 4xx (incl. `422 INSUFFICIENT_FUNDS`, no batch at PayPal) → `PAYOUT_RETURNED` per
 *   item (key `payout_returned:<itemId>`, shared with SP-021), items FAILED with `error_code`,
 *   batch FAILED, alert. The next run builds a new batch.
 */

export type PayoutsClient = Pick<MoneyOutClient, 'payout'>;

export interface SubmitOptions {
  pp: PayoutsClient;
  /** Tries for a call PayPal didn't answer. Default 3. */
  attempts?: number;
  /** Backoff before try n+1: `retryDelayMs × n`. Default 1000. */
  retryDelayMs?: number;
}

export type SubmitOutcome =
  | { status: 'PENDING'; paypalBatchId: string }
  | { status: 'NEEDS_RECONCILE'; errorCode: string }
  | { status: 'FAILED'; errorCode: string }
  /** PayPal never answered; the batch stays SUBMITTED and the next run resubmits it. */
  | { status: 'RETRY_LATER'; errorCode: string };

/** `audit_events.action` of a payout alert (W14 shows them). */
export const PAYOUT_ALERT = 'PAYOUT_ALERT';
export const ACTOR_ID = 'payoutRun';
export const INSUFFICIENT_FUNDS_ALERT = 'Fund the sandbox merchant or lower the demo threshold';
export const NEEDS_RECONCILE_ALERT =
  'PayPal already has this payout batch but returned no payout_batch_id: reconcile it from the ' +
  'PAYMENT.PAYOUTSBATCH webhook or POST /admin/payouts/:batchId/reconcile {paypalBatchId}';

interface BatchRow {
  id: string;
  status: string;
  trigger: string;
  periodEnd: Date;
  needsReconcile: boolean;
}

interface ItemRow {
  id: string;
  publisherId: string;
  receiverEmail: string;
  netCents: number;
}

/** An append-only alert row (there is no alerts table; `audit_events` is what W14 searches). */
export async function payoutAlert(
  client: pg.ClientBase,
  batchId: string,
  code: string,
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (actor_type, actor_id, entity, entity_id, action, data)
     VALUES ('SYSTEM', $1, 'payout_batch', $2, $3, $4)`,
    [ACTOR_ID, batchId, PAYOUT_ALERT, { code, message, ...data }],
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Submit batch `batchId` (BUILDING, or SUBMITTED from a crashed run). `client` is not in a tx. */
export async function submitBatch(
  client: pg.ClientBase,
  batchId: string,
  opts: SubmitOptions,
): Promise<SubmitOutcome> {
  const batch = (
    await client.query<BatchRow>(
      `SELECT id, status, trigger, period_end AS "periodEnd", needs_reconcile AS "needsReconcile"
       FROM payout_batches WHERE id = $1`,
      [batchId],
    )
  ).rows[0];
  if (!batch) throw new Error(`payout batch ${batchId} not found`);
  if (batch.status !== 'BUILDING' && batch.status !== 'SUBMITTED') {
    throw new Error(`payout batch ${batchId} is ${batch.status}; only BUILDING / SUBMITTED submit`);
  }
  const items = (
    await client.query<ItemRow>(
      `SELECT id, publisher_id AS "publisherId", receiver_email AS "receiverEmail",
              net_cents AS "netCents"
       FROM payout_items WHERE batch_id = $1 AND status = 'PENDING' ORDER BY id`,
      [batchId],
    )
  ).rows;
  if (items.length === 0) throw new Error(`payout batch ${batchId} has no PENDING items`);

  const payoutItems = [];
  for (const item of items) {
    const { note } = await statementFor(client, item.publisherId, batchId, batch.periodEnd);
    payoutItems.push({
      itemId: item.id,
      email: item.receiverEmail,
      amountCents: item.netCents,
      note,
    });
  }

  // 4b. From here on, a crash leaves SUBMITTED: "PayPal may have it".
  if (batch.status === 'BUILDING') {
    const moved = await transition(client, 'payout_batches', batchId, 'BUILDING', 'SUBMITTED', {
      updated_at: new Date(),
    });
    if (!moved) throw new Error(`payout batch ${batchId} left BUILDING under the payout lock`);
  }

  const attempts = opts.attempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1_000;
  let lastTransient: PayPalCallError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && retryDelayMs > 0) await sleep(retryDelayMs * (attempt - 1));
    try {
      const accepted = await opts.pp.payout({
        batchId,
        items: payoutItems,
        emailSubject: 'Your Spigot earnings',
      });
      await markPending(client, batch, items, accepted.payoutBatchId);
      return { status: 'PENDING', paypalBatchId: accepted.payoutBatchId };
    } catch (err) {
      if (err instanceof PayPalDuplicateBatch) {
        if (err.payoutBatchId) {
          await markPending(client, batch, items, err.payoutBatchId);
          return { status: 'PENDING', paypalBatchId: err.payoutBatchId };
        }
        await markNeedsReconcile(client, batchId, err.code, err.debugId);
        return { status: 'NEEDS_RECONCILE', errorCode: err.code };
      }
      if (!(err instanceof PayPalCallError)) throw err;
      if (err.errorClass === 'TRANSIENT') {
        lastTransient = err;
        continue;
      }
      if (err.errorClass === 'RECONCILE') {
        // A 2xx without a batch id: PayPal has the batch; we can't name it.
        await markNeedsReconcile(client, batchId, err.code, err.debugId);
        return { status: 'NEEDS_RECONCILE', errorCode: err.code };
      }
      await failBatch(client, batch, items, err);
      return { status: 'FAILED', errorCode: err.code };
    }
  }
  return { status: 'RETRY_LATER', errorCode: lastTransient?.code ?? 'NETWORK' };
}

async function markPending(
  client: pg.ClientBase,
  batch: BatchRow,
  items: ItemRow[],
  paypalBatchId: string,
): Promise<void> {
  await inTx(client, async () => {
    const moved = await transition(client, 'payout_batches', batch.id, 'SUBMITTED', 'PENDING', {
      paypal_batch_id: paypalBatchId,
      needs_reconcile: false,
      updated_at: new Date(),
    });
    if (!moved) throw new Error(`payout batch ${batch.id} left SUBMITTED under the payout lock`);
    for (const item of items) {
      await client.query(
        `INSERT INTO audit_events (actor_type, actor_id, publisher_id, entity, entity_id, action, paypal_id, data)
         VALUES ('WORKFLOW', $1, $2, 'payout_item', $3, 'PAYOUT_SENT', $4, $5)`,
        [
          ACTOR_ID,
          item.publisherId,
          item.id,
          paypalBatchId,
          { batchId: batch.id, netCents: item.netCents, trigger: batch.trigger },
        ],
      );
    }
  });
}

async function markNeedsReconcile(
  client: pg.ClientBase,
  batchId: string,
  code: string,
  debugId: string | undefined,
): Promise<void> {
  await inTx(client, async () => {
    await client.query(
      `UPDATE payout_batches SET needs_reconcile = true, updated_at = now()
       WHERE id = $1 AND status = 'SUBMITTED'`,
      [batchId],
    );
    await payoutAlert(client, batchId, code, NEEDS_RECONCILE_ALERT, { debugId: debugId ?? null });
  });
}

async function failBatch(
  client: pg.ClientBase,
  batch: BatchRow,
  items: ItemRow[],
  err: PayPalCallError,
): Promise<void> {
  await inTx(client, async () => {
    const platform = await platformAccounts(client);
    for (const item of items) {
      const failed = await transition(client, 'payout_items', item.id, 'PENDING', 'FAILED', {
        error_code: err.code,
        updated_at: new Date(),
      });
      if (!failed) continue;
      const payable = await getOrCreateAccount(client, 'PUBLISHER_PAYABLE', item.publisherId);
      await post(client as pg.PoolClient, {
        kind: 'PAYOUT_RETURNED',
        idempotencyKey: `payout_returned:${item.id}`,
        refType: 'payout_item',
        refId: item.id,
        memo: `PayPal refused payout batch ${batch.id}: ${err.code}`,
        entries: payoutReturnedEntries(
          { payoutsInFlight: platform.payoutsInFlight, publisher: payable },
          centsToMicros(item.netCents),
        ),
      });
      await client.query(
        `INSERT INTO audit_events (actor_type, actor_id, publisher_id, entity, entity_id, action, data)
         VALUES ('WORKFLOW', $1, $2, 'payout_item', $3, 'PAYOUT_RETURNED', $4)`,
        [
          ACTOR_ID,
          item.publisherId,
          item.id,
          { batchId: batch.id, errorCode: err.code, http: err.http },
        ],
      );
    }
    const moved = await transition(client, 'payout_batches', batch.id, 'SUBMITTED', 'FAILED', {
      updated_at: new Date(),
    });
    if (!moved) throw new Error(`payout batch ${batch.id} left SUBMITTED under the payout lock`);
    const message =
      err instanceof PayPalInsufficientFunds
        ? INSUFFICIENT_FUNDS_ALERT
        : `PayPal refused payout batch (${err.code}); the amounts are back in payable for the next run`;
    await payoutAlert(client, batch.id, err.code, message, {
      http: err.http,
      debugId: err.debugId ?? null,
    });
  });
}
