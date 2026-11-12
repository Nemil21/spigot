import { centsToMicros, formatCents, microsToCentsFloor } from '@spigot/shared';
import { audit, type ActorType } from '../audit/audit.js';
import type { Queryable, Tx } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { getOrCreateAccount } from '../ledger/accounts.js';
import { InsufficientBalance } from '../ledger/errors.js';
import { post } from '../ledger/ledger.js';
import { refundEntries, type Entry } from '../ledger/postings.js';
import { PayPalCallError, PayPalRefundExceeded, type RefundView } from '../paypal/index.js';
import { nowOf, type RefundDeps } from './deps.js';

/**
 * Refund of unused balance (SP-049; features/10 §Refund of unused balance, api.md
 * `POST /api/buyer/refunds`, data-model §balance_refunds and rules 1, 2, 5).
 *
 * `requestRefund` runs in two steps, so no row lock is ever held across a PayPal call:
 *
 * 1. **Reserve** (one transaction, `reserveRefund`): lock the buyer row, then the buyer's
 *    refundable `topups` rows `FOR UPDATE` in id order. Refundable per capture is
 *    `amount − Σ balance_refunds (REQUESTED, PENDING, COMPLETED)` (not just `refunded_cents`), so
 *    two parallel requests can't slice the same capture. Allowed = `min(floor(balance cents),
 *    Σ refundable over COMPLETED top-ups ≤ 180 days old)`; above it → `422 REFUND_EXCEEDS_UNUSED`.
 *    Split newest first; per slice insert `balance_refunds` (its id is the `PayPal-Request-Id`) and
 *    `ledger.post(REFUND, 'refund:'+id)` **before** PayPal is called. A full cash-out disables auto
 *    top-up.
 * 2. **Settle** (`settleRefund`, per slice): `pp.refundCapture(capture, amount, id)`, then
 *    COMPLETED → `topups.refunded_cents += amount` and PARTIALLY_REFUNDED / REFUNDED; PENDING →
 *    left for the webhook or the sweep's `getRefund` poll; a definite refusal → FAILED and a
 *    `REFUND_REVERSAL` txn (`refund_reversal:<id>`) puts the money back. No answer → left
 *    REQUESTED; `sweepRefunds` replays it with the same request id (PayPal returns the original).
 *
 * The request-level `Idempotency-Key` is stored on the slices: slice 0 carries the key itself and
 * slice n > 0 carries `key + '\x1f' + n` (a client key is printable ASCII, so it can never collide
 * with a suffixed one), which keeps `unique(buyer_id, idempotency_key)` intact.
 */

/** PayPal accepts refunds on a capture for 180 days. */
export const REFUND_WINDOW_DAYS = 180;
const DAY_MS = 86_400_000;
/** Above this a request is a typo, not a cash-out (500 × the $500 top-up maximum). */
export const MAX_REFUND_CENTS = 25_000_000;

const SLICE_SEP = '\x1f';

export type BalanceRefundStatus = 'REQUESTED' | 'PENDING' | 'COMPLETED' | 'FAILED';

export interface BalanceRefundRow {
  id: string;
  buyerId: string;
  topupId: string;
  amountCents: number;
  status: BalanceRefundStatus;
  paypalRefundId: string | null;
  ledgerTxnId: string | null;
  errorCode: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The refunded capture (`topups.paypal_capture_id`). */
  captureId: string;
}

export const REFUND_COLUMNS = `r.id, r.buyer_id AS "buyerId", r.topup_id AS "topupId",
  r.amount_cents AS "amountCents", r.status, r.paypal_refund_id AS "paypalRefundId",
  r.ledger_txn_id AS "ledgerTxnId", r.error_code AS "errorCode",
  r.idempotency_key AS "idempotencyKey", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
  t.paypal_capture_id AS "captureId"`;

const SELECT_REFUNDS = `SELECT ${REFUND_COLUMNS} FROM balance_refunds r JOIN topups t ON t.id = r.topup_id`;

/** What the buyer portal (W12, SP-050) shows for one slice. */
export function refundView(r: BalanceRefundRow) {
  return {
    refundId: r.id,
    topupId: r.topupId,
    amountCents: r.amountCents,
    status: r.status,
    paypalRefundId: r.paypalRefundId,
    errorCode: r.errorCode,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ------------------------------------------------------------------ availability + slicing (pure)

/** A top-up capture refunds can draw on. */
export interface RefundSource {
  topupId: string;
  captureId: string;
  createdAt: Date;
  /** What's left on the capture after REQUESTED / PENDING / COMPLETED slices. */
  refundableCents: number;
}

export interface RefundSlice {
  topupId: string;
  captureId: string;
  amountCents: number;
}

/**
 * Split `amountCents` across `sources`, newest first (by `createdAt`, then `topupId` descending).
 * Returns `null` when the sources can't cover it.
 */
export function planSlices(
  sources: readonly RefundSource[],
  amountCents: number,
): RefundSlice[] | null {
  const newestFirst = [...sources].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (a.topupId < b.topupId ? 1 : a.topupId > b.topupId ? -1 : 0),
  );
  const slices: RefundSlice[] = [];
  let left = amountCents;
  for (const s of newestFirst) {
    if (left <= 0) break;
    if (s.refundableCents <= 0) continue;
    const take = Math.min(left, s.refundableCents);
    slices.push({ topupId: s.topupId, captureId: s.captureId, amountCents: take });
    left -= take;
  }
  return left === 0 ? slices : null;
}

export interface RefundAvailability {
  /** `floor(buyer balance)` in cents. */
  balanceCents: number;
  /** Σ refundable over COMPLETED top-ups ≤ 180 days old. */
  refundableCents: number;
  /** `min(balanceCents, refundableCents)`: the most a request may ask for. */
  allowedCents: number;
  sources: RefundSource[];
}

/**
 * The buyer's refundable captures and balance. With `lock`, the buyer's source `topups` rows are
 * locked `FOR UPDATE` in id order first (the caller must be inside a transaction).
 */
export async function refundAvailability(
  q: Queryable,
  buyerId: string,
  nowMs: number,
  opts: { lock?: boolean } = {},
): Promise<RefundAvailability> {
  const since = new Date(nowMs - REFUND_WINDOW_DAYS * DAY_MS);
  const { rows: topups } = await q.query<{
    id: string;
    captureId: string;
    amountCents: number;
    refundedCents: number;
    createdAt: Date;
  }>(
    `SELECT id, paypal_capture_id AS "captureId", amount_cents AS "amountCents",
            refunded_cents AS "refundedCents", created_at AS "createdAt"
       FROM topups
      WHERE buyer_id = $1 AND status IN ('COMPLETED', 'PARTIALLY_REFUNDED')
        AND paypal_capture_id IS NOT NULL AND created_at > $2
      ORDER BY id${opts.lock ? ' FOR UPDATE' : ''}`,
    [buyerId, since],
  );
  const held = new Map<string, number>();
  if (topups.length > 0) {
    const { rows } = await q.query<{ topupId: string; cents: string }>(
      `SELECT topup_id AS "topupId", sum(amount_cents) AS cents FROM balance_refunds
        WHERE topup_id = ANY($1::uuid[]) AND status IN ('REQUESTED', 'PENDING', 'COMPLETED')
        GROUP BY topup_id`,
      [topups.map((t) => t.id)],
    );
    for (const r of rows) held.set(r.topupId, Number(r.cents));
  }
  const sources = topups.map((t) => ({
    topupId: t.id,
    captureId: t.captureId,
    createdAt: t.createdAt,
    // `refunded_cents` only counts COMPLETED slices, so the held sum is normally the larger; take
    // the max so a refund recorded elsewhere can never be sliced again.
    refundableCents: Math.max(0, t.amountCents - Math.max(held.get(t.id) ?? 0, t.refundedCents)),
  }));
  const refundableCents = sources.reduce((s, t) => s + t.refundableCents, 0);
  const balanceCents = microsToCentsFloor(await buyerBalanceMicros(q, buyerId));
  return {
    balanceCents,
    refundableCents,
    allowedCents: Math.min(balanceCents, refundableCents),
    sources,
  };
}

async function buyerBalanceMicros(q: Queryable, buyerId: string): Promise<number> {
  const { rows } = await q.query<{ balance: string }>(
    `SELECT balance_micros AS balance FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
    [buyerId],
  );
  return rows[0] ? Number(rows[0].balance) : 0;
}

function exceeded(requestedCents: number, a: RefundAvailability): ApiError {
  const why =
    a.refundableCents < a.balanceCents
      ? `Only ${formatCents(a.refundableCents)} of your balance came from PayPal top-ups in the last ` +
        `${REFUND_WINDOW_DAYS} days and hasn't been refunded yet; the rest (claim credits, older ` +
        `top-ups) can't go back to PayPal.`
      : `Your unused balance is ${formatCents(a.balanceCents)}.`;
  return new ApiError(
    'REFUND_EXCEEDS_UNUSED',
    `You can refund at most ${formatCents(a.allowedCents)}. ${why}`,
    {
      requestedCents,
      allowedCents: a.allowedCents,
      balanceCents: a.balanceCents,
      refundableCents: a.refundableCents,
    },
  );
}

// ------------------------------------------------------------------ reserve (step 1)

export interface RefundRequestInput {
  buyerId: string;
  amountCents: number;
  idempotencyKey: string;
  actor?: { actorType: ActorType; actorId?: string | null };
}

export interface Reservation {
  /** True when this key already made a request: nothing new was written. */
  replay: boolean;
  slices: BalanceRefundRow[];
  /** A full cash-out turned auto top-up off. */
  autoTopupDisabled: boolean;
}

function sliceKey(key: string, n: number): string {
  return n === 0 ? key : `${key}${SLICE_SEP}${n}`;
}

function sliceIndex(key: string | null): number {
  const i = key?.lastIndexOf(SLICE_SEP) ?? -1;
  return i < 0 ? 0 : Number(key!.slice(i + 1));
}

/** The slices an earlier request with this key made, in slice order (empty if none). */
async function slicesForKey(
  q: Queryable,
  buyerId: string,
  key: string,
): Promise<BalanceRefundRow[]> {
  const { rows } = await q.query<BalanceRefundRow>(
    `${SELECT_REFUNDS}
      WHERE r.buyer_id = $1 AND (r.idempotency_key = $2 OR starts_with(r.idempotency_key, $3))`,
    [buyerId, key, key + SLICE_SEP],
  );
  return rows.sort((a, b) => sliceIndex(a.idempotencyKey) - sliceIndex(b.idempotencyKey));
}

export function assertRefundAmount(amountCents: unknown): asserts amountCents is number {
  if (
    typeof amountCents !== 'number' ||
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_REFUND_CENTS
  ) {
    throw new ApiError('VALIDATION_ERROR', 'amountCents must be a positive whole number of cents.');
  }
}

/** Step 1: lock, check, slice, insert and post REFUND (one transaction; no PayPal call). */
export async function reserveRefund(
  deps: RefundDeps,
  input: RefundRequestInput,
): Promise<Reservation> {
  assertRefundAmount(input.amountCents);
  const actor = input.actor ?? { actorType: 'BUYER' as const, actorId: input.buyerId };
  try {
    return await deps.db.tx(async (tx) => {
      // Serialises this buyer's refund requests (and a same-key double-click) before anything is read.
      // NO KEY UPDATE, not UPDATE: FOR UPDATE would also block the buyer_id foreign-key checks of
      // concurrent charges and credits and can deadlock them (autoTopup.ts §Lock order).
      const buyer = await tx.query<{ autoTopup: boolean }>(
        `SELECT auto_topup_enabled AS "autoTopup" FROM buyers WHERE id = $1 FOR NO KEY UPDATE`,
        [input.buyerId],
      );
      if (!buyer.rows[0]) throw new ApiError('NOT_FOUND', 'No such buyer.');

      const prior = await slicesForKey(tx, input.buyerId, input.idempotencyKey);
      if (prior.length > 0) {
        const sum = prior.reduce((s, r) => s + r.amountCents, 0);
        if (sum !== input.amountCents) {
          throw new ApiError(
            'IDEMPOTENCY_MISMATCH',
            'This Idempotency-Key was already used for a different refund amount.',
          );
        }
        return { replay: true, slices: prior, autoTopupDisabled: false };
      }

      const avail = await refundAvailability(tx, input.buyerId, nowOf(deps), { lock: true });
      if (input.amountCents > avail.allowedCents) throw exceeded(input.amountCents, avail);
      const plan = planSlices(avail.sources, input.amountCents);
      if (!plan) throw exceeded(input.amountCents, avail);

      const accounts = {
        buyer: await getOrCreateAccount(tx, 'BUYER_BALANCE', input.buyerId),
        paypalCash: await getOrCreateAccount(tx, 'PAYPAL_CASH'),
      };
      const ids: string[] = [];
      for (const [n, slice] of plan.entries()) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO balance_refunds (buyer_id, topup_id, amount_cents, idempotency_key)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.buyerId, slice.topupId, slice.amountCents, sliceKey(input.idempotencyKey, n)],
        );
        const id = rows[0]!.id;
        const posted = await post(tx, {
          kind: 'REFUND',
          idempotencyKey: `refund:${id}`,
          refType: 'balance_refund',
          refId: id,
          memo: `Refund to PayPal capture ${slice.captureId}`,
          entries: refundEntries(accounts, centsToMicros(slice.amountCents)),
        });
        await tx.query(`UPDATE balance_refunds SET ledger_txn_id = $2 WHERE id = $1`, [
          id,
          posted.txn.id,
        ]);
        ids.push(id);
      }

      // Full cash-out: nothing (not even a cent) is left, so an auto top-up would refill a balance
      // the buyer just asked to empty.
      const autoTopupDisabled = input.amountCents >= avail.balanceCents && buyer.rows[0].autoTopup;
      if (autoTopupDisabled) {
        await tx.query(
          `UPDATE buyers SET auto_topup_enabled = false, updated_at = now() WHERE id = $1`,
          [input.buyerId],
        );
      }

      await audit(tx, {
        ...actor,
        entity: 'balance_refunds',
        entityId: ids[0] ?? null,
        action: 'REFUND_REQUESTED',
        data: {
          amountCents: input.amountCents,
          slices: plan.map((s, n) => ({
            refundId: ids[n],
            topupId: s.topupId,
            amountCents: s.amountCents,
          })),
          autoTopupDisabled,
        },
      });

      const slices = await slicesForKey(tx, input.buyerId, input.idempotencyKey);
      return { replay: false, slices, autoTopupDisabled };
    });
  } catch (err) {
    // A charge landed between our balance read and the REFUND post: the balance is lower now.
    if (err instanceof InsufficientBalance) {
      const avail = await refundAvailability(deps.db.pool, input.buyerId, nowOf(deps));
      throw exceeded(input.amountCents, avail);
    }
    throw err;
  }
}

// ------------------------------------------------------------------ settle (step 2)

export type SettleOutcome =
  /** COMPLETED now or earlier. */
  | 'COMPLETED'
  /** PayPal holds the refund (e.g. eCheck): the webhook or the sweep's poll finishes it. */
  | 'PENDING'
  /** Refused: FAILED, money back on the balance. */
  | 'FAILED'
  /** No clear answer: left as is for the sweep (same request id). */
  | 'RETRY';

/**
 * Definite refusals: PayPal answered 4xx, so no refund exists. 401 (our credentials) and 409 (a
 * concurrent request with the same id still in flight) are not about this refund: retry them.
 */
function isDefiniteRefusal(err: unknown): err is PayPalCallError {
  if (err instanceof PayPalRefundExceeded) return true;
  return (
    err instanceof PayPalCallError &&
    err.errorClass === 'TERMINAL' &&
    err.http >= 400 &&
    err.http < 500 &&
    err.http !== 401 &&
    err.http !== 409
  );
}

/** Step 2 for one REQUESTED slice: call PayPal with `PayPal-Request-Id = id` and record the answer. */
export async function settleRefund(
  deps: RefundDeps,
  row: BalanceRefundRow,
): Promise<SettleOutcome> {
  if (row.status !== 'REQUESTED') return row.status;
  let view: RefundView;
  try {
    view = await deps.pp.refundCapture(row.captureId, row.amountCents, row.id);
  } catch (err) {
    if (isDefiniteRefusal(err)) {
      return deps.db.tx(async (tx) =>
        (await failRefundTx(tx, row.id, err.code)) ? 'FAILED' : currentOutcome(tx, row.id),
      );
    }
    log(deps, 'refund call not answered; the sweep retries it', {
      refundId: row.id,
      err: errText(err),
    });
    return 'RETRY';
  }
  return deps.db.tx((tx) => applyRefundView(tx, row.id, view));
}

/**
 * Record what PayPal says about refund `refundId` (`balance_refunds.id`): from the POST, the
 * sweep's `getRefund`, or the `PAYMENT.CAPTURE.REFUNDED` webhook. Idempotent: every write is a
 * conditional status update, so the losers of a race change nothing.
 */
export async function applyRefundView(
  tx: Tx,
  refundId: string,
  view: RefundView,
): Promise<SettleOutcome> {
  switch (view.status) {
    case 'COMPLETED':
      await completeRefundTx(tx, refundId, view.refundId);
      return currentOutcome(tx, refundId);
    case 'PENDING':
      await tx.query(
        `UPDATE balance_refunds SET status = 'PENDING', paypal_refund_id = $2, updated_at = now()
          WHERE id = $1 AND status = 'REQUESTED'`,
        [refundId, view.refundId],
      );
      return currentOutcome(tx, refundId);
    default:
      await failRefundTx(tx, refundId, view.statusReason ?? `REFUND_${view.status}`, view.refundId);
      return currentOutcome(tx, refundId);
  }
}

async function currentOutcome(q: Queryable, refundId: string): Promise<SettleOutcome> {
  const { rows } = await q.query<{ status: BalanceRefundStatus }>(
    `SELECT status FROM balance_refunds WHERE id = $1`,
    [refundId],
  );
  const s = rows[0]?.status;
  return s === 'REQUESTED' || !s ? 'RETRY' : s;
}

/**
 * REQUESTED | PENDING → COMPLETED, then add the amount to the top-up's `refunded_cents` and move it
 * to PARTIALLY_REFUNDED (or REFUNDED once all of it is back). Returns false if it was already final.
 */
export async function completeRefundTx(
  tx: Tx,
  refundId: string,
  paypalRefundId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ topupId: string; amountCents: number; buyerId: string }>(
    `UPDATE balance_refunds SET status = 'COMPLETED', paypal_refund_id = $2, error_code = NULL,
            updated_at = now()
      WHERE id = $1 AND status IN ('REQUESTED', 'PENDING')
      RETURNING topup_id AS "topupId", amount_cents AS "amountCents", buyer_id AS "buyerId"`,
    [refundId, paypalRefundId],
  );
  const done = rows[0];
  if (!done) return false;
  await tx.query(
    `UPDATE topups
        SET refunded_cents = refunded_cents + $2,
            status = CASE WHEN refunded_cents + $2 >= amount_cents THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
            updated_at = now()
      WHERE id = $1 AND status IN ('COMPLETED', 'PARTIALLY_REFUNDED')`,
    [done.topupId, done.amountCents],
  );
  await audit(tx, {
    actorType: 'SYSTEM',
    entity: 'balance_refunds',
    entityId: refundId,
    action: 'REFUND_COMPLETED',
    paypalId: paypalRefundId,
    data: { buyerId: done.buyerId, topupId: done.topupId, amountCents: done.amountCents },
  });
  return true;
}

/**
 * REQUESTED | PENDING → FAILED with `errorCode`, and post the `REFUND_REVERSAL` that puts the money
 * back on the balance. Returns false if the refund was already final.
 */
export async function failRefundTx(
  tx: Tx,
  refundId: string,
  errorCode: string,
  paypalRefundId: string | null = null,
): Promise<boolean> {
  const { rows } = await tx.query<{ buyerId: string; amountCents: number; topupId: string }>(
    `UPDATE balance_refunds SET status = 'FAILED', error_code = $2,
            paypal_refund_id = coalesce($3, paypal_refund_id), updated_at = now()
      WHERE id = $1 AND status IN ('REQUESTED', 'PENDING')
      RETURNING buyer_id AS "buyerId", amount_cents AS "amountCents", topup_id AS "topupId"`,
    [refundId, errorCode, paypalRefundId],
  );
  const failed = rows[0];
  if (!failed) return false;
  await postReversal(tx, refundId, failed.buyerId, failed.amountCents);
  await audit(tx, {
    actorType: 'SYSTEM',
    entity: 'balance_refunds',
    entityId: refundId,
    action: 'ALERT',
    paypalId: paypalRefundId,
    data: {
      alert: 'REFUND_FAILED',
      reason: errorCode,
      buyerId: failed.buyerId,
      topupId: failed.topupId,
      amountCents: failed.amountCents,
    },
  });
  return true;
}

/** `REFUND_REVERSAL` (`refund_reversal:<id>`): the REFUND lines negated. Idempotent. */
async function postReversal(
  tx: Tx,
  refundId: string,
  buyerId: string,
  amountCents: number,
): Promise<void> {
  const accounts = {
    buyer: await getOrCreateAccount(tx, 'BUYER_BALANCE', buyerId),
    paypalCash: await getOrCreateAccount(tx, 'PAYPAL_CASH'),
  };
  const entries: Entry[] = refundEntries(accounts, centsToMicros(amountCents)).map((e) => ({
    accountId: e.accountId,
    amountMicros: -e.amountMicros,
  }));
  await post(tx, {
    kind: 'REFUND_REVERSAL',
    idempotencyKey: `refund_reversal:${refundId}`,
    refType: 'balance_refund',
    refId: refundId,
    memo: 'Refund to PayPal failed: money back on the balance',
    entries,
  });
}

// ------------------------------------------------------------------ the endpoint's whole flow

export interface RefundRequestResult {
  replay: boolean;
  refunds: BalanceRefundRow[];
  autoTopupDisabled: boolean;
  balanceMicros: number;
}

/**
 * `POST /api/buyer/refunds`: reserve, then settle each new slice. A replay (same key) returns the
 * slices as they stand and calls PayPal for none of them: the original request (or the sweep, a
 * minute later) owns those calls, so a double-click never sends two concurrent POSTs.
 */
export async function requestRefund(
  deps: RefundDeps,
  input: RefundRequestInput,
): Promise<RefundRequestResult> {
  const reservation = await reserveRefund(deps, input);
  if (!reservation.replay) {
    // One at a time: a request is a slice or two, and it keeps PayPal calls predictable.
    for (const slice of reservation.slices) await settleRefund(deps, slice);
  }
  const ids = reservation.slices.map((s) => s.id);
  const { rows } = await deps.db.pool.query<BalanceRefundRow>(
    `${SELECT_REFUNDS} WHERE r.id = ANY($1::uuid[])`,
    [ids],
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    replay: reservation.replay,
    refunds: rows,
    autoTopupDisabled: reservation.autoTopupDisabled,
    balanceMicros: await buyerBalanceMicros(deps.db.pool, input.buyerId),
  };
}

/** The buyer's refunds, newest first (W12). */
export async function listRefunds(
  q: Queryable,
  buyerId: string,
  limit = 100,
): Promise<BalanceRefundRow[]> {
  const { rows } = await q.query<BalanceRefundRow>(
    `${SELECT_REFUNDS} WHERE r.buyer_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT $2`,
    [buyerId, limit],
  );
  return rows;
}

// ------------------------------------------------------------------ recovery sweep

/** REQUESTED slices younger than this belong to the request still calling PayPal. */
export const SWEEP_REQUESTED_AFTER_MS = 60_000;
export const SWEEP_EVERY_MS = 60_000;
export const SWEEP_BATCH = 100;

export interface SweepResult {
  replayed: Partial<Record<SettleOutcome, number>>;
  polled: Partial<Record<SettleOutcome, number>>;
  reversalsPosted: number;
}

/**
 * The recovery sweep (`jobs/refund-sweep.job.ts`, every 60 s):
 * - REQUESTED older than 1 min (a crash between the REFUND post and PayPal, or a lost response) →
 *   replay `refundCapture` with the same request id: PayPal returns the original refund if it made
 *   one, so the refund happens once;
 * - PENDING → `pp.getRefund` until COMPLETED / FAILED (no webhook needed);
 * - FAILED without a `REFUND_REVERSAL` → post it (FAILED and the reversal commit together, so this
 *   only guards rows written by some other path).
 */
export async function sweepRefunds(deps: RefundDeps): Promise<SweepResult> {
  const result: SweepResult = { replayed: {}, polled: {}, reversalsPosted: 0 };
  const cutoff = new Date(nowOf(deps) - SWEEP_REQUESTED_AFTER_MS);

  const { rows: requested } = await deps.db.pool.query<BalanceRefundRow>(
    `${SELECT_REFUNDS} WHERE r.status = 'REQUESTED' AND r.created_at < $1
      ORDER BY r.created_at LIMIT $2`,
    [cutoff, SWEEP_BATCH],
  );
  for (const row of requested) {
    const o = await settleRefund(deps, row);
    result.replayed[o] = (result.replayed[o] ?? 0) + 1;
  }

  const { rows: pending } = await deps.db.pool.query<BalanceRefundRow>(
    `${SELECT_REFUNDS} WHERE r.status = 'PENDING' AND r.paypal_refund_id IS NOT NULL
      ORDER BY r.updated_at LIMIT $1`,
    [SWEEP_BATCH],
  );
  for (const row of pending) {
    let o: SettleOutcome;
    try {
      const view = await deps.pp.getRefund(row.paypalRefundId!);
      o = await deps.db.tx((tx) => applyRefundView(tx, row.id, view));
    } catch (err) {
      log(deps, 'getRefund failed', { refundId: row.id, err: errText(err) });
      o = 'RETRY';
    }
    result.polled[o] = (result.polled[o] ?? 0) + 1;
  }

  const { rows: unreversed } = await deps.db.pool.query<{
    id: string;
    buyerId: string;
    amountCents: number;
  }>(
    `SELECT r.id, r.buyer_id AS "buyerId", r.amount_cents AS "amountCents" FROM balance_refunds r
      WHERE r.status = 'FAILED'
        AND EXISTS (SELECT 1 FROM ledger_txns WHERE idempotency_key = 'refund:' || r.id)
        AND NOT EXISTS (SELECT 1 FROM ledger_txns WHERE idempotency_key = 'refund_reversal:' || r.id)
      LIMIT $1`,
    [SWEEP_BATCH],
  );
  for (const row of unreversed) {
    await deps.db.tx((tx) => postReversal(tx, row.id, row.buyerId, row.amountCents));
    result.reversalsPosted++;
  }
  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(deps: RefundDeps, msg: string, data: Record<string, unknown>): void {
  (deps.log ?? ((m, d) => console.warn(`[refunds] ${m} ${JSON.stringify(d)}`)))(msg, data);
}
