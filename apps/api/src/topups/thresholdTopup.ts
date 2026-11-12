import {
  AUTO_TOPUP_TIMEOUT_MS,
  chargeVaultTopup,
  reserveVaultTopup,
  type AutoTopupDeps,
} from './autoTopup.js';

/**
 * Auto top-up below the threshold (features/08 §Auto top-up, data-model §buyers
 * `auto_topup_threshold_micros`, rule 11; SP-047c). SP-047a tops up only when a paid call is
 * already short; this tops up **before** that happens: after a CHARGE commits and leaves
 * `balance < auto_topup_threshold_micros` ("top up when below $2"), the call that made the charge
 * enqueues one vault top-up and returns at once. The buyer's next calls find the money there and
 * never see a 402.
 *
 * It is the same `reserveVaultTopup` (buyer row lock, one `VAULT_MIT` in flight, the monthly cap)
 * with `whenBelowMicros`: the balance is re-read under the lock, so a burst of charges below the
 * threshold makes one top-up, and one that queued behind it sees the new balance and skips. A
 * short call racing this (SP-047a's in-request path, still the fallback when a call can't wait)
 * finds this top-up in flight and waits for it instead of starting a second one.
 *
 * "Enqueue" is an in-process promise, not a durable queue: if the process dies mid-call the
 * `topups` row is left CREATED and SP-047c's orphan sweep (`jobs/vault-topup-sweep.job.ts`)
 * replays it; if it dies before the reservation, the next charge below the threshold triggers it
 * again.
 */

export type ThresholdTopupOutcome =
  | { result: 'TOPPED_UP'; topupId: string; amountCents: number; balanceMicros: number }
  | { result: 'DECLINED'; topupId: string; code: string }
  | {
      result: 'SKIPPED';
      reason:
        | 'NOT_BELOW'
        | 'DISABLED'
        | 'NO_VAULT'
        | 'IN_FLIGHT'
        | 'CAP_REACHED'
        | 'WOULD_NOT_HELP'
        | 'TIMEOUT'
        | 'PENDING'
        | 'ERROR';
      topupId?: string;
    };

export interface ChargedBalance {
  buyerId: string;
  /** The buyer's balance right after the CHARGE committed. */
  balanceMicros: number;
}

interface BuyerThresholdRow {
  enabled: boolean;
  thresholdMicros: number;
  hasVault: boolean;
}

/**
 * Top up if the charge left the balance below the buyer's threshold. A plain read first (no lock)
 * so the common case, a balance above the threshold, costs one primary-key lookup.
 */
export async function thresholdTopUp(
  deps: AutoTopupDeps,
  charged: ChargedBalance,
): Promise<ThresholdTopupOutcome> {
  const { rows } = await deps.db.pool.query<BuyerThresholdRow>(
    `SELECT auto_topup_enabled AS enabled, auto_topup_threshold_micros::float8 AS "thresholdMicros",
            vault_id IS NOT NULL AS "hasVault"
       FROM buyers WHERE id = $1`,
    [charged.buyerId],
  );
  const b = rows[0];
  if (!b || !b.enabled) return { result: 'SKIPPED', reason: 'DISABLED' };
  if (!b.hasVault) return { result: 'SKIPPED', reason: 'NO_VAULT' };
  const thresholdMicros = Number(b.thresholdMicros);
  if (charged.balanceMicros >= thresholdMicros) return { result: 'SKIPPED', reason: 'NOT_BELOW' };

  const r = await reserveVaultTopup(deps.db, {
    buyerId: charged.buyerId,
    trigger: 'AUTO',
    whenBelowMicros: thresholdMicros,
  });
  switch (r.kind) {
    case 'BALANCE_OK':
      return { result: 'SKIPPED', reason: 'NOT_BELOW' };
    case 'IN_FLIGHT':
      // Someone else's top-up (this trigger, a short call, MCP) is on its way: never a second.
      return { result: 'SKIPPED', reason: 'IN_FLIGHT', topupId: r.topupId };
    case 'DISABLED':
    case 'NO_VAULT':
    case 'CAP_REACHED':
    case 'WOULD_NOT_HELP':
      return { result: 'SKIPPED', reason: r.kind };
    case 'RESERVED': {
      const out = await chargeVaultTopup(deps, r, {
        timeoutMs: deps.timeoutMs ?? AUTO_TOPUP_TIMEOUT_MS,
        actor: { actorType: deps.actorType ?? 'SYSTEM', actorId: charged.buyerId },
      });
      switch (out.status) {
        case 'COMPLETED':
          return {
            result: 'TOPPED_UP',
            topupId: out.topup.id,
            amountCents: out.topup.amountCents,
            balanceMicros: out.balanceMicros,
          };
        case 'DECLINED':
          // `failVaultTopupTx` turned auto top-up off (W11's declined banner), as for a short call.
          return { result: 'DECLINED', topupId: out.topupId, code: out.code };
        case 'PENDING':
          return { result: 'SKIPPED', reason: 'PENDING', topupId: out.topup.id };
        default:
          return { result: 'SKIPPED', reason: out.status, topupId: out.topupId };
      }
    }
  }
}

/** Threshold top-ups running in this process, by buyer: one per buyer at a time. */
const running = new Map<string, Promise<ThresholdTopupOutcome | null>>();

/**
 * Fire-and-forget `thresholdTopUp` after a committed charge. Never throws and never delays the
 * caller. A buyer whose threshold top-up is already running in this process is skipped (the
 * database's one-in-flight rule covers other processes).
 */
export function enqueueThresholdTopup(
  deps: AutoTopupDeps & { log?: (msg: string, data: Record<string, unknown>) => void },
  charged: ChargedBalance,
): void {
  if (running.has(charged.buyerId)) return;
  const log = deps.log ?? defaultLog;
  const p = thresholdTopUp(deps, charged)
    .catch((err: unknown) => {
      log('threshold top-up failed', {
        buyerId: charged.buyerId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    })
    .finally(() => running.delete(charged.buyerId));
  running.set(charged.buyerId, p);
}

/** Wait for every threshold top-up started so far (tests; graceful shutdown). */
export async function settleThresholdTopups(): Promise<void> {
  while (running.size > 0) await Promise.allSettled([...running.values()]);
}

function defaultLog(msg: string, data: Record<string, unknown>): void {
  console.warn(`[auto-topup] ${msg} ${JSON.stringify(data)}`);
}
