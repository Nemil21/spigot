import { centsToMicros } from '@spigot/shared';
import { audit, type ActorType } from '../audit/audit.js';
import type { Db, Tx } from '../db/index.js';
import { transition } from '../db/transition.js';
import { getOrCreateAccount } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import type { VaultRef } from '../paypal/index.js';
import { TOPUP_COLUMNS, type TopupRow } from './row.js';

/**
 * `creditTopup` (features/08 §Manual top-up step 4, data-model rule 6): the one place a top-up's
 * money reaches the buyer's balance. The capture endpoint, the return handler, SP-019's poller and
 * SP-059's webhook (`custom_id`) all call it with what PayPal said it captured. In one transaction:
 *
 * 1. lock the `topups` row (`FOR UPDATE`): concurrent callers queue here, and every loser finds
 *    the row already COMPLETED and does nothing;
 * 2. credit **only what PayPal captured**: the capture must be USD, for exactly
 *    `topups.amount_cents`, and (when PayPal echoes them) for this top-up's `custom_id` and order.
 *    A mismatch sets `needs_reconcile`, writes an `ALERT` audit row and credits nothing;
 * 3. `transition(CREATED | AWAITING_APPROVAL | ABANDONED → COMPLETED)` storing the capture id and
 *    PayPal's fee (a capture after SP-019's ABANDONED sweep still credits, once);
 * 4. `ledger.post(TOPUP, 'topup:'+id)` (idempotent on its own as a second guard);
 * 5. save `buyers.vault_id / vault_kind / vault_label` if PayPal vaulted the method;
 * 6. audit `TOPUP_COMPLETED` with the order and capture ids.
 *
 * Never call PayPal from here: it runs under a row lock.
 */

/** What PayPal captured (a `COMPLETED` `TopupResult`, a GET of the order, or a webhook resource). */
export interface CapturedFacts {
  captureId: string;
  /** The capture's amount in cents; `null` when PayPal's body couldn't be read. */
  amountCents: number | null;
  /** `amount.currency_code`; anything but `USD` (including unknown) is not credited. */
  currency: string | null | undefined;
  /** `seller_receivable_breakdown.paypal_fee`, tracked outside the ledger. */
  feeCents?: number | null;
  orderId?: string | null;
  /** The capture's `custom_id` when PayPal echoed it; must be this top-up's id. */
  customId?: string | null;
  vault?: VaultRef | null;
}

export interface CreditActor {
  actorType: ActorType;
  actorId?: string | null;
}

export interface CreditOptions {
  /**
   * Dates the TOPUP ledger txn (SP-035 / SP-036's simulated week). Applied only to `trigger=SIM`
   * top-ups (the ledger accepts it only on simulated txns); ignored for every other top-up.
   */
  simulatedAt?: Date;
}

export type CreditOutcome =
  /** This call credited the balance. */
  | { result: 'CREDITED'; topup: TopupRow; balanceMicros: number }
  /** Someone else already credited it (or it was refunded since): nothing written. */
  | { result: 'ALREADY_CREDITED'; topup: TopupRow }
  /** The capture doesn't match the top-up: `needs_reconcile` set, alert written, no credit. */
  | { result: 'MISMATCH'; topup: TopupRow; reason: string }
  /** The top-up is FAILED (or unknown): a completed capture for it needs a human. Alerted. */
  | { result: 'NOT_CREDITABLE'; topup: TopupRow | null; reason: string };

const DONE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const OPEN = ['CREATED', 'AWAITING_APPROVAL', 'ABANDONED'] as const;

/** Why this capture can't be credited to this top-up, or `null` when it matches. */
export function captureMismatch(topup: TopupRow, c: CapturedFacts): string | null {
  if (c.currency !== 'USD') return `CURRENCY_${c.currency ?? 'UNKNOWN'}`;
  if (c.amountCents !== topup.amountCents) return 'AMOUNT_MISMATCH';
  if (c.customId && c.customId !== topup.id) return 'CUSTOM_ID_MISMATCH';
  if (c.orderId && topup.paypalOrderId && c.orderId !== topup.paypalOrderId) {
    return 'ORDER_MISMATCH';
  }
  return null;
}

export async function creditTopup(
  db: Db,
  topupId: string,
  capture: CapturedFacts,
  actor: CreditActor = { actorType: 'SYSTEM' },
  opts: CreditOptions = {},
): Promise<CreditOutcome> {
  return db.tx((tx) => creditTopupTx(tx, topupId, capture, actor, opts));
}

/** `creditTopup` inside the caller's transaction. */
export async function creditTopupTx(
  tx: Tx,
  topupId: string,
  capture: CapturedFacts,
  actor: CreditActor = { actorType: 'SYSTEM' },
  opts: CreditOptions = {},
): Promise<CreditOutcome> {
  const { rows } = await tx.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups WHERE id = $1 FOR UPDATE`,
    [topupId],
  );
  const topup = rows[0] ?? null;
  const alert = (reason: string, row: TopupRow | null) =>
    audit(tx, {
      ...actor,
      entity: 'topups',
      entityId: row?.id ?? null,
      action: 'ALERT',
      paypalId: capture.captureId,
      data: {
        alert: 'TOPUP_CAPTURE_NOT_CREDITED',
        reason,
        topupId,
        orderId: capture.orderId ?? null,
        captureId: capture.captureId,
        expectedCents: row?.amountCents ?? null,
        capturedCents: capture.amountCents,
        currency: capture.currency ?? null,
      },
    });

  if (!topup) {
    await alert('UNKNOWN_TOPUP', null);
    return { result: 'NOT_CREDITABLE', topup: null, reason: 'UNKNOWN_TOPUP' };
  }
  if (DONE.has(topup.status)) return { result: 'ALREADY_CREDITED', topup };

  const mismatch = captureMismatch(topup, capture);
  if (mismatch || topup.status === 'FAILED') {
    const reason = mismatch ?? 'TOPUP_FAILED';
    const { rows: flagged } = await tx.query<TopupRow>(
      `UPDATE topups SET needs_reconcile = true, updated_at = now() WHERE id = $1
       RETURNING ${TOPUP_COLUMNS}`,
      [topup.id],
    );
    await alert(reason, topup);
    const row = flagged[0] ?? topup;
    return mismatch
      ? { result: 'MISMATCH', topup: row, reason }
      : { result: 'NOT_CREDITABLE', topup: row, reason };
  }

  const completed = await transition<'topups', Record<string, unknown>>(
    tx,
    'topups',
    topup.id,
    OPEN,
    'COMPLETED',
    {
      paypal_capture_id: capture.captureId,
      paypal_order_id: topup.paypalOrderId ?? capture.orderId ?? null,
      paypal_fee_cents: capture.feeCents ?? null,
      pending_reason: null,
      updated_at: new Date(),
    },
  );
  // The row is locked and its status is open, so this can't lose; guard anyway (rule 1).
  if (!completed) return { result: 'ALREADY_CREDITED', topup };

  const amountMicros = centsToMicros(topup.amountCents);
  const buyerAccount = await getOrCreateAccount(tx, 'BUYER_BALANCE', topup.buyerId);
  const paypalCash = await getOrCreateAccount(tx, 'PAYPAL_CASH');
  const posted = await post(tx, {
    kind: 'TOPUP',
    idempotencyKey: `topup:${topup.id}`,
    refType: 'topup',
    refId: topup.id,
    entries: topupEntries({ buyer: buyerAccount, paypalCash }, amountMicros),
    isSimulated: topup.trigger === 'SIM',
    ...(topup.trigger === 'SIM' && opts.simulatedAt ? { simulatedAt: opts.simulatedAt } : {}),
  });

  const { rows: updated } = await tx.query<TopupRow>(
    `UPDATE topups SET ledger_txn_id = $2 WHERE id = $1 RETURNING ${TOPUP_COLUMNS}`,
    [topup.id, posted.txn.id],
  );

  if (capture.vault) {
    await tx.query(
      `UPDATE buyers SET vault_id = $2, vault_kind = $3, vault_label = $4, updated_at = now()
        WHERE id = $1`,
      [
        topup.buyerId,
        capture.vault.id,
        capture.vault.kind === 'card' ? 'CARD' : 'PAYPAL',
        capture.vault.label ?? null,
      ],
    );
  }

  await audit(tx, {
    ...actor,
    entity: 'topups',
    entityId: topup.id,
    action: 'TOPUP_COMPLETED',
    paypalId: capture.captureId,
    data: {
      orderId: topup.paypalOrderId ?? capture.orderId ?? null,
      captureId: capture.captureId,
      amountCents: topup.amountCents,
      feeCents: capture.feeCents ?? null,
      ledgerTxnId: posted.txn.id,
      vaulted: capture.vault ? capture.vault.kind : null,
      priorStatus: topup.status,
    },
  });

  const balanceMicros = posted.replay
    ? await balanceOf(tx, topup.buyerId)
    : posted.balances[buyerAccount]!;
  return { result: 'CREDITED', topup: updated[0]!, balanceMicros };
}

/** The buyer's prepaid balance in micros (0 before the first top-up). */
export async function balanceOf(
  q: Pick<Tx, 'query'> | Db['pool'],
  buyerId: string,
): Promise<number> {
  const { rows } = await q.query<{ balance: string | number }>(
    `SELECT balance_micros AS balance FROM ledger_accounts
      WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
    [buyerId],
  );
  return rows[0] ? Number(rows[0].balance) : 0;
}
