import { transition } from '../db/transition.js';
import type { Tx } from '../db/tx.js';
import { getOrCreateAccount } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { creditEntries } from '../ledger/postings.js';

/**
 * Claim credit (features/10 §Claims 4–5; data-model §Postings CREDIT; SP-048a). Everything here
 * runs in the caller's transaction, after `lockBuyer`:
 *   1. abuse limit under the buyer lock: credits ≤ 10% of the buyer's charges over 7 days;
 *   2. conditional `credited_micros += unit` that can never pass `price_micros`;
 *   3. `ledger.post(CREDIT, 'claim:<id>')` reversing the CHARGE split at the call's snapshotted
 *      `commission_bps` (SP-016), so a later commission change can't unbalance the call;
 *   4. call → PARTIALLY_CREDITED / CREDITED.
 */

/** Credits per buyer may not exceed this share of their charges over the window. */
export const ABUSE_LIMIT_BPS = 1_000; // 10%
export const ABUSE_WINDOW = '7 days';

/**
 * `SELECT … FROM buyers WHERE id = $1 FOR UPDATE`: serializes every claim credit for one buyer,
 * so the abuse limit is evaluated against committed credits only. Take it **first** in the
 * transaction: inserting the claim takes a FOR KEY SHARE on the buyer row (FK), and two claims
 * that both did that before asking for FOR UPDATE would deadlock.
 */
export async function lockBuyer(tx: Tx, buyerId: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT id FROM buyers WHERE id = $1 FOR UPDATE`, [buyerId]);
  return rows.length > 0;
}

export interface AbuseWindow {
  chargedMicros: number;
  creditedMicros: number;
}

/** The buyer's charges and claim credits over the last 7 days. Call with the buyer locked. */
export async function abuseWindow(tx: Tx, buyerId: string): Promise<AbuseWindow> {
  const { rows } = await tx.query<{ charged: number; credited: number }>(
    `SELECT
       (SELECT coalesce(sum(price_micros), 0)::bigint FROM api_calls
         WHERE buyer_id = $1 AND created_at > now() - $2::interval
           AND status IN ('CHARGED', 'PARTIALLY_CREDITED', 'CREDITED')) AS charged,
       (SELECT coalesce(sum(c.credit_micros), 0)::bigint FROM claims c
          JOIN ledger_txns t ON t.id = c.ledger_txn_id
         WHERE c.buyer_id = $1 AND t.created_at > now() - $2::interval) AS credited`,
    [buyerId, ABUSE_WINDOW],
  );
  return { chargedMicros: rows[0]!.charged, creditedMicros: rows[0]!.credited };
}

/** `credited + credit ≤ 10% × charged`, in integers. */
export function withinAbuseLimit(w: AbuseWindow, creditMicros: number): boolean {
  return (w.creditedMicros + creditMicros) * 10_000 <= w.chargedMicros * ABUSE_LIMIT_BPS;
}

export interface CreditInput {
  claimId: string;
  callId: string;
  buyerId: string;
  publisherId: string;
}

export type CreditResult =
  | { credited: true; creditMicros: number; ledgerTxnId: string; callStatus: string }
  | { credited: false; why: 'ABUSE_LIMIT' | 'NOTHING_TO_CREDIT' };

/** Credit one record's price for `claimId`. The buyer must already be locked (`lockBuyer`). */
export async function creditClaim(tx: Tx, input: CreditInput): Promise<CreditResult> {
  const call = await tx.query<{
    unit: number | null;
    commissionBps: number | null;
    isSimulated: boolean;
  }>(
    `SELECT unit_price_micros AS unit, commission_bps AS "commissionBps", is_simulated AS "isSimulated"
       FROM api_calls WHERE id = $1`,
    [input.callId],
  );
  const c = call.rows[0];
  const unit = c?.unit ?? 0;
  if (!c || unit <= 0 || c.commissionBps === null)
    return { credited: false, why: 'NOTHING_TO_CREDIT' };

  if (!withinAbuseLimit(await abuseWindow(tx, input.buyerId), unit)) {
    return { credited: false, why: 'ABUSE_LIMIT' };
  }

  // Never past the price: 0 rows means the call is already fully credited (or wasn't charged).
  const upd = await tx.query<{ status: string; credited: number; price: number }>(
    `UPDATE api_calls SET credited_micros = credited_micros + $2
      WHERE id = $1 AND status IN ('CHARGED', 'PARTIALLY_CREDITED')
        AND credited_micros + $2 <= price_micros
      RETURNING status, credited_micros AS credited, price_micros AS price`,
    [input.callId, unit],
  );
  const row = upd.rows[0];
  if (!row) return { credited: false, why: 'NOTHING_TO_CREDIT' };

  const accounts = {
    buyer: await getOrCreateAccount(tx, 'BUYER_BALANCE', input.buyerId),
    publisher: await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', input.publisherId),
    platformRevenue: await getOrCreateAccount(tx, 'PLATFORM_REVENUE'),
  };
  const posted = await post(tx, {
    kind: 'CREDIT',
    idempotencyKey: `claim:${input.claimId}`,
    refType: 'claim',
    refId: input.claimId,
    entries: creditEntries(accounts, unit, c.commissionBps),
    isSimulated: c.isSimulated,
  });

  const next = row.credited >= row.price ? 'CREDITED' : 'PARTIALLY_CREDITED';
  if (next !== row.status) {
    await transition(
      tx,
      'api_calls',
      input.callId,
      row.status as 'CHARGED' | 'PARTIALLY_CREDITED',
      next,
    );
  }
  return { credited: true, creditMicros: unit, ledgerTxnId: posted.txn.id, callStatus: next };
}
