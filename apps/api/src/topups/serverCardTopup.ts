import { audit, type ActorType } from '../audit/audit.js';
import { ApiError } from '../http/errors.js';
import { topupResultOf, type TestCard, type TopupResult } from '../paypal/index.js';
import {
  applyTopupResult,
  callPayPal,
  topupById,
  type CaptureOutcome,
  type TopupDeps,
} from './capture.js';
import { balanceOf } from './creditTopup.js';
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from './createTopup.js';
import { TOPUP_COLUMNS, type TopupRow } from './row.js';

/**
 * PayPal's published sandbox test cards (Holdfast S7 step 6), the ones that capture with CAPTURE
 * intent (SP-001b probe, Nov 12 2026). Not real cards. Never 5105…5100 (`VALIDATION_ERROR`).
 * Discover 6011…1117 worked for S7's AUTHORIZE holds but CAPTURE-intent creates refuse it
 * (`422 CREDIT_CARD_NUMBER_MUST_BE_TEST_NUMBER`), so it is left out.
 */
export const SIM_TEST_CARDS: readonly TestCard[] = [
  { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Spigot SIM Visa' },
  { number: '4012888888881881', expiry: '2030-11', security_code: '123', name: 'Spigot SIM Visa' },
  { number: '5555555555554444', expiry: '2030-10', security_code: '123', name: 'Spigot SIM MC' },
  { number: '371449635398431', expiry: '2030-09', security_code: '1234', name: 'Spigot SIM Amex' },
];

let cardTurn = 0;

/** The next SIM test card, round-robin (spreads the seed's concurrent creates over cards). */
export function nextSimTestCard(): TestCard {
  return SIM_TEST_CARDS[cardTurn++ % SIM_TEST_CARDS.length]!;
}

/** A CREATED row with no order id older than this was lost mid-create: a human must look. */
export const SIM_CREATE_STALE_MS = 5 * 60_000;

export interface ServerCardTopupInput {
  /**
   * Chosen by the caller and **deterministic** (e.g. derived from the seed's buyer), so a re-run
   * finds the same row. It is the `topups.id`, the order-create `PayPal-Request-Id` and `custom_id`.
   */
  topupId: string;
  buyerId: string;
  amountCents: number;
  trigger: 'SIM';
}

export type ServerCardTopupOutcome =
  /** Captured and credited (by this call, an earlier run or a racing caller). */
  | { status: 'COMPLETED'; topup: TopupRow; created: boolean; balanceMicros: number }
  /** PayPal holds the capture: no credit until the poller / webhook sees it complete. */
  | { status: 'PENDING'; topup: TopupRow; created: boolean }
  /** The card was declined; the row is FAILED. A new top-up needs a new id. */
  | { status: 'FAILED'; topup: TopupRow; created: boolean; code: string | null }
  /** Another caller inserted the row and is creating the order right now. Nothing was done. */
  | { status: 'IN_FLIGHT'; topup: TopupRow; created: false }
  /** Unknown outcome at PayPal: `needs_reconcile` is set and nothing more is tried. */
  | { status: 'NEEDS_RECONCILE'; topup: TopupRow; created: boolean; code: string };

const DONE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const OPEN = ['CREATED', 'AWAITING_APPROVAL', 'ABANDONED'];

/**
 * A server-side SIM card top-up (features/15 §Seed 6): a raw sandbox test card, CAPTURE at create,
 * card vaulted `ON_SUCCESS`, then `creditTopup`. **Server-side only**: the seed calls it; no route
 * does, and nothing in it may come from request input.
 *
 * Raw-card order create is **not** replay-safe (Holdfast S7: the same `PayPal-Request-Id` can come
 * back `422 TRANSACTION_REFUSED`), so the `topups` row is the only dedupe:
 * 1. `INSERT … ON CONFLICT (id) DO NOTHING`. Only the caller whose insert wins calls
 *    `createTopupOrder`, once; any answer other than captured / pending / declined sets
 *    `needs_reconcile` (it is never retried with a new order).
 * 2. A caller that finds the row reconciles it without creating an order: COMPLETED → done;
 *    an order id → `getOrder` and credit what PayPal captured; no order id and older than 5 min
 *    → `needs_reconcile`; younger → `IN_FLIGHT`.
 *
 * Throws `IDEMPOTENCY_MISMATCH` when `topupId` exists for another buyer / amount / trigger, and
 * `PAYPAL_ERROR` when a reconciling `getOrder` can't reach PayPal (safe to call again).
 */
export async function serverCardTopup(
  deps: TopupDeps,
  input: ServerCardTopupInput,
): Promise<ServerCardTopupOutcome> {
  const { db, config } = deps;
  if (input.trigger !== 'SIM') throw new TypeError('serverCardTopup is for SIM top-ups only');
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents < MIN_TOPUP_CENTS ||
    input.amountCents > MAX_TOPUP_CENTS
  ) {
    throw new RangeError(`amountCents must be ${MIN_TOPUP_CENTS}–${MAX_TOPUP_CENTS}`);
  }
  // Raw cards only against the sandbox or the fake (the client refuses them too; fail before the
  // insert so a live config never leaves a stuck row).
  if (config.PAYPAL_MODE !== 'stub' && !config.paypalIsSandbox) {
    throw new Error('SIM card top-ups run only against the PayPal sandbox or the stub');
  }
  const actor = { actorType: 'SIM' as ActorType, actorId: input.buyerId };

  const inserted = await db.tx(async (tx) => {
    const { rows } = await tx.query<TopupRow>(
      `INSERT INTO topups (id, buyer_id, amount_cents, method, trigger)
       VALUES ($1, $2, $3, 'CARD', 'SIM')
       ON CONFLICT (id) DO NOTHING
       RETURNING ${TOPUP_COLUMNS}`,
      [input.topupId, input.buyerId, input.amountCents],
    );
    const row = rows[0];
    if (row) {
      await audit(tx, {
        ...actor,
        entity: 'topups',
        entityId: row.id,
        action: 'TOPUP_CREATED',
        data: { amountCents: row.amountCents, method: row.method, trigger: row.trigger },
      });
    }
    return row ?? null;
  });

  if (!inserted) return reconcileExisting(deps, input, actor);

  // The winner: the one and only order create for this id.
  let result: TopupResult;
  try {
    result = await callPayPal(inserted.id, () =>
      deps.pp.createTopupOrder({
        topupId: inserted.id,
        amountCents: inserted.amountCents,
        source: { kind: 'card', card: nextSimTestCard(), vault: true },
      }),
    );
  } catch (err) {
    // PayPal may or may not have created (and captured) the order; we can't ask by custom_id.
    if (!(err instanceof ApiError)) throw err;
    return flagReconcile(deps, inserted, null, 'PAYPAL_UNREACHABLE', actor, true);
  }
  return settle(deps, inserted, result, actor, true);
}

/** Someone already inserted `topupId`: settle it from our row and PayPal, never a second order. */
async function reconcileExisting(
  deps: TopupDeps,
  input: ServerCardTopupInput,
  actor: { actorType: ActorType; actorId: string },
): Promise<ServerCardTopupOutcome> {
  const { db } = deps;
  // Committed: `ON CONFLICT` waited for the inserting transaction.
  const row = (await topupById(db, input.topupId))!;
  if (
    row.buyerId !== input.buyerId ||
    row.amountCents !== input.amountCents ||
    row.trigger !== 'SIM' ||
    row.method !== 'CARD'
  ) {
    throw new ApiError(
      'IDEMPOTENCY_MISMATCH',
      'This top-up id was already used for another top-up.',
      {
        topupId: row.id,
      },
    );
  }

  if (DONE.has(row.status)) {
    return {
      status: 'COMPLETED',
      topup: row,
      created: false,
      balanceMicros: await balanceOf(db.pool, row.buyerId),
    };
  }
  if (row.status === 'FAILED') {
    return { status: 'FAILED', topup: row, created: false, code: row.errorCode };
  }
  if (row.needsReconcile) {
    return { status: 'NEEDS_RECONCILE', topup: row, created: false, code: 'NEEDS_RECONCILE' };
  }

  if (row.paypalOrderId) {
    const orderId = row.paypalOrderId;
    const order = await callPayPal(row.id, () => deps.pp.getOrder(orderId));
    return settle(deps, row, topupResultOf(order, true), actor, false);
  }

  // No order id yet: the winner is mid-create, or it died there. Flag only when stale, atomically
  // (the winner may store its order id at any moment).
  const { rows: stale } = await db.pool.query<TopupRow>(
    `UPDATE topups SET needs_reconcile = true, updated_at = now()
      WHERE id = $1 AND status = 'CREATED' AND paypal_order_id IS NULL AND NOT needs_reconcile
        AND created_at < now() - make_interval(secs => $2)
      RETURNING ${TOPUP_COLUMNS}`,
    [row.id, SIM_CREATE_STALE_MS / 1000],
  );
  if (stale[0]) {
    await alert(deps, stale[0], null, 'SIM_CREATE_STALE', actor);
    return { status: 'NEEDS_RECONCILE', topup: stale[0], created: false, code: 'SIM_CREATE_STALE' };
  }
  return { status: 'IN_FLIGHT', topup: (await topupById(db, row.id)) ?? row, created: false };
}

/** Apply a create (or GET) answer for a SIM card top-up to its row. */
async function settle(
  deps: TopupDeps,
  row: TopupRow,
  result: TopupResult,
  actor: { actorType: ActorType; actorId: string },
  created: boolean,
): Promise<ServerCardTopupOutcome> {
  const { db } = deps;
  switch (result.status) {
    case 'COMPLETED':
    case 'PENDING': {
      // Store the order id first, so a racing caller can reconcile by GET.
      await db.pool.query(
        `UPDATE topups SET paypal_order_id = $2 WHERE id = $1 AND paypal_order_id IS NULL`,
        [row.id, result.orderId],
      );
      let outcome: CaptureOutcome;
      try {
        outcome = await applyTopupResult(deps, row, result, actor);
      } catch (err) {
        // A capture that doesn't match the top-up: `creditTopup` flagged and alerted it.
        if (!(err instanceof ApiError)) throw err;
        const current = (await topupById(db, row.id)) ?? row;
        return { status: 'NEEDS_RECONCILE', topup: current, created, code: err.code };
      }
      return outcome.status === 'COMPLETED'
        ? {
            status: 'COMPLETED',
            topup: outcome.topup,
            created,
            balanceMicros: outcome.balanceMicros,
          }
        : { status: 'PENDING', topup: outcome.topup, created };
    }

    case 'DECLINED': {
      try {
        await applyTopupResult(deps, row, result, actor); // → FAILED + TOPUP_FAILED audit, throws
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
      }
      const current = (await topupById(db, row.id)) ?? row;
      return { status: 'FAILED', topup: current, created, code: result.code };
    }

    case 'AWAITING_APPROVAL':
      // A raw-card create that wants payer action (3-D Secure): nobody is there to approve.
      return flagReconcile(
        deps,
        row,
        result.orderId,
        `ORDER_${result.orderStatus}`,
        actor,
        created,
      );

    case 'NEEDS_RECONCILE':
      // Including a raw-card replay refused with 422 TRANSACTION_REFUSED (S7): not a decline, and
      // not retried. Our row stays the only top-up for this id.
      return flagReconcile(deps, row, result.orderId, result.code, actor, created);
  }
}

async function flagReconcile(
  deps: TopupDeps,
  row: TopupRow,
  orderId: string | null,
  code: string,
  actor: { actorType: ActorType; actorId: string },
  created: boolean,
): Promise<ServerCardTopupOutcome> {
  const { rows } = await deps.db.pool.query<TopupRow>(
    `UPDATE topups
        SET needs_reconcile = true, error_code = coalesce(error_code, $3),
            paypal_order_id = coalesce(paypal_order_id, $2), updated_at = now()
      WHERE id = $1 AND status = ANY($4::text[])
      RETURNING ${TOPUP_COLUMNS}`,
    [row.id, orderId, code, OPEN],
  );
  const flagged = rows[0];
  if (!flagged) {
    // Settled meanwhile (a racing reconcile credited or failed it): report what it is now.
    const current = (await topupById(deps.db, row.id)) ?? row;
    if (DONE.has(current.status)) {
      return {
        status: 'COMPLETED',
        topup: current,
        created,
        balanceMicros: await balanceOf(deps.db.pool, current.buyerId),
      };
    }
    return { status: 'FAILED', topup: current, created, code: current.errorCode };
  }
  await alert(deps, flagged, orderId, code, actor);
  return { status: 'NEEDS_RECONCILE', topup: flagged, created, code };
}

function alert(
  deps: TopupDeps,
  row: TopupRow,
  orderId: string | null,
  code: string,
  actor: { actorType: ActorType; actorId: string },
): Promise<unknown> {
  return audit(deps.db.pool, {
    ...actor,
    entity: 'topups',
    entityId: row.id,
    action: 'ALERT',
    paypalId: orderId,
    data: {
      alert: 'SIM_TOPUP_NEEDS_RECONCILE',
      code,
      topupId: row.id,
      orderId: orderId ?? row.paypalOrderId,
      amountCents: row.amountCents,
    },
  });
}
