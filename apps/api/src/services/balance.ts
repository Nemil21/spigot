// `GET /v1/balance` and MCP `get_balance` (api.md; SP-017a). Read-only.
import type { Queryable } from '../db/pool.js';

export interface AutoTopupStatus {
  enabled: boolean;
  thresholdMicros: number;
  amountCents: number;
  /** Monthly cap minus this UTC month's auto (vault MIT) top-ups, floored at 0. */
  remainingThisMonthCents: number;
  /** A saved PayPal method exists, so an auto top-up could actually run. */
  hasSavedMethod: boolean;
}

export interface BuyerBalance {
  balanceMicros: number;
  autoTopup: AutoTopupStatus;
}

/**
 * Vault MIT top-ups that count against the monthly cap: everything not known to have failed
 * (an in-flight CREATED one counts, so the figure never over-promises).
 */
const CAP_STATUSES = [
  'CREATED',
  'AWAITING_APPROVAL',
  'COMPLETED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

export async function balance(deps: { db: Queryable }, buyerId: string): Promise<BuyerBalance> {
  const { rows } = await deps.db.query<{
    balance: number | null;
    enabled: boolean;
    threshold: number;
    amount: number;
    cap: number;
    vault: boolean;
    used: number;
  }>(
    `SELECT (SELECT balance_micros FROM ledger_accounts
              WHERE kind = 'BUYER_BALANCE' AND owner_id = b.id) AS balance,
            b.auto_topup_enabled AS enabled, b.auto_topup_threshold_micros AS threshold,
            b.auto_topup_amount_cents AS amount, b.monthly_topup_cap_cents AS cap,
            b.vault_id IS NOT NULL AS vault,
            (SELECT coalesce(sum(t.amount_cents), 0)::int FROM topups t
              WHERE t.buyer_id = b.id AND t.method = 'VAULT_MIT' AND t.status = ANY($2)
                AND t.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS used
       FROM buyers b WHERE b.id = $1`,
    [buyerId, CAP_STATUSES],
  );
  const r = rows[0];
  if (!r) throw new Error(`balance: unknown buyer ${buyerId}`);
  return {
    balanceMicros: r.balance ?? 0,
    autoTopup: {
      enabled: r.enabled,
      thresholdMicros: r.threshold,
      amountCents: r.amount,
      remainingThisMonthCents: Math.max(0, r.cap - r.used),
      hasSavedMethod: r.vault,
    },
  };
}

/**
 * Whether a call at `priceMicros` would trigger an auto top-up (SP-047a): the balance is short,
 * auto top-up is on with a saved method, and the configured amount fits this month's cap.
 */
export function wouldAutoTopUp(b: BuyerBalance, priceMicros: number): boolean {
  const a = b.autoTopup;
  return (
    priceMicros > b.balanceMicros &&
    a.enabled &&
    a.hasSavedMethod &&
    a.amountCents <= a.remainingThisMonthCents
  );
}
