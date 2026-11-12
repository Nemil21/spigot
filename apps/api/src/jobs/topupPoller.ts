import { ApiError } from '../http/errors.js';
import { PayPalApiError, topupResultOf } from '../paypal/index.js';
import {
  applyTopupResult,
  captureTopup,
  TOPUP_COLUMNS,
  type CreditActor,
  type TopupRow,
} from '../topups/index.js';
import { nowOf, type JobDeps } from './deps.js';

/**
 * The top-up poller (SP-019; features/08 §Manual top-up 6, api.md §Webhooks): every 30 s, each
 * AWAITING_APPROVAL top-up younger than 30 min is looked up with `pp.getOrder`:
 * - order APPROVED (buyer approved, then closed the tab before W11 captured) → capture with
 *   `PayPal-Request-Id: capture:<topupId>` and credit;
 * - capture COMPLETED (someone captured; the credit didn't land) → `creditTopup`;
 * - capture PENDING → `pending_reason` recorded, no credit; DECLINED / VOIDED → FAILED.
 * Every path goes through SP-018a's `captureTopup` / `applyTopupResult`, so racing the capture
 * endpoint, the return URL or a webhook credits once (`creditTopup` locks the row; PayPal replays
 * the capture for the same request id).
 */

export const POLL_EVERY_MS = 30_000;
/** Open top-ups are polled for this long; after it the ABANDONED sweep takes over. */
export const POLL_WINDOW_MS = 30 * 60_000;
/** Rows per tick; the oldest first. */
export const POLL_BATCH = 100;

export const JOB_ACTOR: CreditActor = { actorType: 'SYSTEM', actorId: 'job:topup-poller' };

export type SettleOutcome =
  /** Credited now, or already credited by someone else. */
  | 'COMPLETED'
  /** PayPal holds the capture: `pending_reason` set, nothing credited. */
  | 'PENDING'
  /** The buyer hasn't approved yet. */
  | 'WAITING'
  /** Moved AWAITING_APPROVAL → ABANDONED (sweep only). */
  | 'ABANDONED'
  /** Declined / voided (FAILED), a capture we couldn't match (`needs_reconcile`), or a stale row. */
  | 'NOT_CREDITED'
  /** PayPal couldn't be asked, or didn't answer clearly: left as is for the next tick. */
  | 'ERROR';

export interface SettleOptions {
  /**
   * The order was never approved: move the row to ABANDONED instead of waiting (the 5-minute sweep).
   * Only rows with no capture, no `pending_reason` and no `needs_reconcile` are ever abandoned.
   */
  abandonIfUnapproved?: boolean;
  actor?: CreditActor;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

/** Ask PayPal about one open top-up and act on the answer. Never throws for a PayPal outcome. */
export async function settleTopup(
  deps: JobDeps,
  topup: TopupRow,
  opts: SettleOptions = {},
): Promise<SettleOutcome> {
  const actor = opts.actor ?? JOB_ACTOR;
  const log = opts.log ?? defaultLog;
  const orderId = topup.paypalOrderId;
  if (!orderId) {
    // No order at PayPal, so no money can exist for it.
    return opts.abandonIfUnapproved ? abandon(deps, topup) : 'WAITING';
  }

  let order;
  try {
    order = await deps.pp.getOrder(orderId);
  } catch (err) {
    // 404: PayPal has no such order (expired or never created), so nothing was captured.
    if (opts.abandonIfUnapproved && err instanceof PayPalApiError && err.http === 404) {
      return abandon(deps, topup);
    }
    log('getOrder failed', { topupId: topup.id, orderId, err: errText(err) });
    return 'ERROR';
  }

  const result = topupResultOf(order);
  try {
    if (result.status === 'AWAITING_APPROVAL') {
      if (result.orderStatus === 'APPROVED') {
        return outcomeOf(await captureTopup(deps, topup, actor));
      }
      return opts.abandonIfUnapproved ? abandon(deps, topup) : 'WAITING';
    }
    return outcomeOf(await applyTopupResult(deps, topup, result, actor));
  } catch (err) {
    if (err instanceof ApiError) {
      log('top-up not settled', { topupId: topup.id, orderId, code: err.code });
      return err.code === 'PAYPAL_ERROR' ? 'ERROR' : 'NOT_CREDITED';
    }
    throw err;
  }
}

function outcomeOf(o: { status: 'COMPLETED' | 'PENDING' }): SettleOutcome {
  return o.status;
}

/**
 * AWAITING_APPROVAL → ABANDONED, only while the row still has no capture, no pending reason and
 * no reconcile flag. A capture racing this either commits first (the row is COMPLETED and this
 * matches nothing) or lands after it (`creditTopup` accepts ABANDONED → COMPLETED, once).
 */
async function abandon(deps: JobDeps, topup: TopupRow): Promise<SettleOutcome> {
  const { rowCount } = await deps.db.pool.query(
    `UPDATE topups SET status = 'ABANDONED', updated_at = now()
      WHERE id = $1 AND status = 'AWAITING_APPROVAL'
        AND paypal_capture_id IS NULL AND pending_reason IS NULL AND NOT needs_reconcile`,
    [topup.id],
  );
  return rowCount ? 'ABANDONED' : 'NOT_CREDITED';
}

export interface PollResult {
  polled: number;
  outcomes: Partial<Record<SettleOutcome, number>>;
}

/**
 * One poller tick: every AWAITING_APPROVAL top-up with an order, created in the last 30 min.
 * `needs_reconcile` rows are left for a person: re-polling a mismatched capture would only call
 * PayPal and write the same `ALERT` again every tick.
 */
export async function pollOpenTopups(deps: JobDeps): Promise<PollResult> {
  const since = new Date(nowOf(deps) - POLL_WINDOW_MS);
  const { rows } = await deps.db.pool.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups
      WHERE status = 'AWAITING_APPROVAL' AND paypal_order_id IS NOT NULL AND created_at > $1
        AND NOT needs_reconcile
      ORDER BY created_at LIMIT $2`,
    [since, POLL_BATCH],
  );
  return settleAll(deps, rows, {});
}

export async function settleAll(
  deps: JobDeps,
  rows: TopupRow[],
  opts: SettleOptions,
): Promise<PollResult> {
  const outcomes: PollResult['outcomes'] = {};
  // One at a time: a tick is small, and it keeps PayPal calls and row locks predictable.
  for (const row of rows) {
    const o = await settleTopup(deps, row, opts);
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }
  return { polled: rows.length, outcomes };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultLog(msg: string, data: Record<string, unknown>): void {
  console.warn(`[topup-poller] ${msg} ${JSON.stringify(data)}`);
}
