import { audit } from '../audit/audit.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { transition } from '../db/transition.js';
import { ApiError } from '../http/errors.js';
import type { PayPalOrdersClient, TopupResult } from '../paypal/index.js';
import { balanceOf, creditTopup, type CreditActor } from './creditTopup.js';
import { TOPUP_COLUMNS, type TopupRow } from './row.js';

export interface TopupDeps {
  db: Db;
  pp: PayPalOrdersClient;
  config: Config;
}

export type CaptureOutcome =
  /** Captured and credited (by this call or an earlier / racing one). */
  | { status: 'COMPLETED'; topup: TopupRow; captureId: string; balanceMicros: number }
  /** PayPal holds the capture (e.g. eCheck): no credit until it completes (poller / webhook). */
  | { status: 'PENDING'; topup: TopupRow; pendingReason: string | null };

const DONE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export async function topupById(db: Db, id: string): Promise<TopupRow | null> {
  const { rows } = await db.pool.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** A PayPal call that threw (auth failure, bug) → `502 PAYPAL_ERROR`; nothing is decided. */
export async function callPayPal<T>(topupId: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('PAYPAL_ERROR', 'PayPal could not be reached. Please try again.', {
      topupId,
      retryable: true,
    });
  }
}

/**
 * `POST /api/buyer/topups/:id/capture` and `/topups/return` (features/08 §Manual top-up 3–4):
 * capture the approved order with `PayPal-Request-Id: capture:<topupId>` and credit it. Every
 * caller may race: PayPal replays the same capture for the same request id, and `creditTopup`
 * credits once. Already-credited top-ups return without calling PayPal.
 */
export async function captureTopup(
  deps: TopupDeps,
  topup: TopupRow,
  actor: CreditActor,
): Promise<CaptureOutcome> {
  if (DONE.has(topup.status)) return completedOutcome(deps.db, topup);
  if (topup.status === 'FAILED') throw topupFailed(topup.id, topup.errorCode);
  if (!topup.paypalOrderId) {
    throw new ApiError('STATE_CONFLICT', 'This top-up has no PayPal order yet.', {
      topupId: topup.id,
    });
  }
  const orderId = topup.paypalOrderId;
  const result = await callPayPal(topup.id, () => deps.pp.captureOrder(orderId, topup.id));
  return applyTopupResult(deps, topup, result, actor);
}

/**
 * Apply what PayPal said about a top-up's order to our row. Throws `ApiError` for every outcome
 * that isn't COMPLETED or PENDING:
 * - DECLINED → `FAILED` with `error_code`, audit `TOPUP_FAILED`, `422 TOPUP_FAILED`;
 * - AWAITING_APPROVAL (capture before approval) → `409 STATE_CONFLICT`, row untouched;
 * - NEEDS_RECONCILE → `502 PAYPAL_ERROR` (`RECONCILE` also sets `needs_reconcile`);
 * - a capture that doesn't match the top-up → `needs_reconcile` (in `creditTopup`), `409`.
 */
export async function applyTopupResult(
  deps: TopupDeps,
  topup: TopupRow,
  result: TopupResult,
  actor: CreditActor,
): Promise<CaptureOutcome> {
  const { db } = deps;
  switch (result.status) {
    case 'COMPLETED': {
      const credit = await creditTopup(
        db,
        topup.id,
        {
          captureId: result.captureId,
          amountCents: result.amountCents,
          currency: result.currency,
          feeCents: result.feeCents,
          orderId: result.orderId,
          customId: result.customId,
          vault: result.vault,
        },
        actor,
      );
      switch (credit.result) {
        case 'CREDITED':
          return {
            status: 'COMPLETED',
            topup: credit.topup,
            captureId: result.captureId,
            balanceMicros: credit.balanceMicros,
          };
        case 'ALREADY_CREDITED':
          return completedOutcome(db, (await topupById(db, topup.id)) ?? credit.topup);
        default:
          throw new ApiError(
            'STATE_CONFLICT',
            'PayPal captured a payment we could not match to this top-up. Support will review it; nothing was added to your balance.',
            { topupId: topup.id, needsReconcile: true },
          );
      }
    }

    case 'PENDING': {
      // Stays AWAITING_APPROVAL (a CREATED row moves there) with the reason; no credit.
      const { rows } = await db.pool.query<TopupRow>(
        `UPDATE topups
            SET pending_reason = $2,
                paypal_order_id = coalesce(paypal_order_id, $3),
                status = CASE WHEN status = 'CREATED' THEN 'AWAITING_APPROVAL' ELSE status END,
                updated_at = now()
          WHERE id = $1 AND status IN ('CREATED', 'AWAITING_APPROVAL', 'ABANDONED')
          RETURNING ${TOPUP_COLUMNS}`,
        [topup.id, result.reason ?? 'PENDING', result.orderId],
      );
      const row = rows[0] ?? (await topupById(db, topup.id)) ?? topup;
      if (DONE.has(row.status)) return completedOutcome(db, row);
      return { status: 'PENDING', topup: row, pendingReason: row.pendingReason };
    }

    case 'AWAITING_APPROVAL':
      throw new ApiError('STATE_CONFLICT', 'Approve the payment with PayPal first.', {
        topupId: topup.id,
        orderStatus: result.orderStatus,
      });

    case 'DECLINED': {
      await db.tx(async (tx) => {
        const failed = await transition(
          tx,
          'topups',
          topup.id,
          ['CREATED', 'AWAITING_APPROVAL'],
          'FAILED',
          {
            error_code: result.code,
            paypal_order_id: topup.paypalOrderId ?? result.orderId,
            updated_at: new Date(),
          },
        );
        if (failed) {
          await audit(tx, {
            ...actor,
            entity: 'topups',
            entityId: topup.id,
            action: 'TOPUP_FAILED',
            paypalId: result.orderId ?? topup.paypalOrderId,
            data: { code: result.code, http: result.http, orderId: result.orderId },
          });
        }
      });
      throw topupFailed(topup.id, result.code);
    }

    case 'NEEDS_RECONCILE':
      if (result.errorClass === 'RECONCILE') {
        await db.pool.query(
          `UPDATE topups SET needs_reconcile = true, updated_at = now() WHERE id = $1`,
          [topup.id],
        );
      }
      throw new ApiError('PAYPAL_ERROR', 'PayPal did not confirm the payment. Please try again.', {
        topupId: topup.id,
        retryable: result.errorClass === 'TRANSIENT',
      });
  }
}

export function topupFailed(topupId: string, code: string | null): ApiError {
  return new ApiError(
    'TOPUP_FAILED',
    'PayPal declined this payment. Try another payment method in PayPal.',
    { topupId, code },
  );
}

async function completedOutcome(db: Db, topup: TopupRow): Promise<CaptureOutcome> {
  return {
    status: 'COMPLETED',
    topup,
    captureId: topup.paypalCaptureId ?? '',
    balanceMicros: await balanceOf(db.pool, topup.buyerId),
  };
}
