import { audit } from '../audit/audit.js';
import { transition } from '../db/transition.js';
import type { TopupResult } from '../paypal/index.js';
import { settleVaultTopup, vaultSource, type VaultRefRow } from '../topups/autoTopup.js';
import { TOPUP_COLUMNS, type CreditActor, type TopupRow } from '../topups/index.js';
import { nowOf, type JobDeps } from './deps.js';
import { POLL_BATCH } from './topupPoller.js';

/**
 * The orphaned `VAULT_MIT` sweep (SP-047c; features/08 §Auto top-up 6, data-model rule 11).
 *
 * A vault top-up whose create call timed out (the buyer got the 402 after 10 s), errored, or died
 * with its process is left `CREATED`, and a `CREATED` vault top-up blocks every other one for that
 * buyer (one in flight). Every 30 s, each `VAULT_MIT` row still `CREATED` 30 s after it was made:
 *
 * 1. replays `pp.createTopupOrder` with the **same** `PayPal-Request-Id` (the topup id). Vault
 *    orders replay cleanly (Holdfast S7): PayPal answers with the original order, so a create that
 *    went through is never charged twice, and one that never arrived is made now. The answer goes
 *    through SP-047a's `settleVaultTopup`: COMPLETED → `creditTopup`, PENDING → AWAITING_APPROVAL
 *    (SP-019's poller takes it from there), DECLINED → FAILED with auto top-up off;
 * 2. a row still unresolved 10 min after it was made → FAILED + `needs_reconcile` + an `ALERT`
 *    audit row. That frees the one-in-flight slot, so auto top-up works again; auto top-up stays
 *    **on** (nothing was declined). If PayPal did capture it after all, a late answer reaches
 *    `creditTopup`, which credits nothing for a FAILED row and alerts again: a person reconciles.
 *
 * Racing the original call's late answer is safe: both carry the same order and capture, and
 * `creditTopup` locks the row, so the buyer is credited once. A row already flagged
 * `needs_reconcile` (e.g. a capture that didn't match) isn't replayed, which would only write the
 * same alert every tick; it just waits for step 2.
 */

export const VAULT_SWEEP_EVERY_MS = 30_000;
/** A CREATED vault top-up this old has outlived its own call's 10 s budget: replay it. */
export const VAULT_ORPHAN_AFTER_MS = 30_000;
/** …and this old, give up: FAILED + `needs_reconcile` + alert. */
export const VAULT_GIVE_UP_AFTER_MS = 10 * 60_000;

export const VAULT_SWEEP_ACTOR: CreditActor = {
  actorType: 'SYSTEM',
  actorId: 'job:vault-topup-sweep',
};

export type VaultSweepOutcome =
  /** Credited now, or already credited (the original call's late answer won). */
  | 'COMPLETED'
  /** PayPal holds the capture: the row is AWAITING_APPROVAL with `pending_reason`. */
  | 'PENDING'
  /** PayPal declined the replay: FAILED, auto top-up off. */
  | 'DECLINED'
  /** Still CREATED (PayPal didn't answer, or the row is flagged): try again next tick. */
  | 'UNRESOLVED'
  /** Past 10 min: FAILED + `needs_reconcile` + alert. */
  | 'GAVE_UP';

export interface VaultSweepResult {
  swept: number;
  outcomes: Partial<Record<VaultSweepOutcome, number>>;
}

interface OrphanRow extends TopupRow {
  vaultId: string | null;
  vaultKind: VaultRefRow['kind'] | null;
}

export interface VaultSweepOptions {
  log?: (msg: string, data: Record<string, unknown>) => void;
}

/** One sweep tick: the oldest orphaned `VAULT_MIT` rows first, one at a time. */
export async function sweepOrphanedVaultTopups(
  deps: JobDeps,
  opts: VaultSweepOptions = {},
): Promise<VaultSweepResult> {
  const now = nowOf(deps);
  const { rows } = await deps.db.pool.query<OrphanRow>(
    `SELECT t.*, b.vault_id AS "vaultId", b.vault_kind AS "vaultKind"
       FROM (SELECT ${TOPUP_COLUMNS} FROM topups
              WHERE method = 'VAULT_MIT' AND status = 'CREATED' AND created_at <= $1
              ORDER BY created_at LIMIT $2) t
       JOIN buyers b ON b.id = t."buyerId"
      ORDER BY t."createdAt"`,
    [new Date(now - VAULT_ORPHAN_AFTER_MS), POLL_BATCH],
  );
  const outcomes: VaultSweepResult['outcomes'] = {};
  for (const row of rows) {
    const o = await sweepVaultTopup(deps, row, now, opts);
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }
  return { swept: rows.length, outcomes };
}

async function sweepVaultTopup(
  deps: JobDeps,
  row: OrphanRow,
  now: number,
  opts: VaultSweepOptions,
): Promise<VaultSweepOutcome> {
  const log = opts.log ?? defaultLog;
  // No vault any more (the buyer removed it): nothing to replay against; wait for step 2.
  if (!row.needsReconcile && row.vaultId) {
    const vault: VaultRefRow = { id: row.vaultId, kind: row.vaultKind ?? 'CARD' };
    let result: TopupResult | null = null;
    try {
      result = await deps.pp.createTopupOrder({
        topupId: row.id,
        amountCents: row.amountCents,
        source: vaultSource(vault),
      });
    } catch (err) {
      log('replay failed', { topupId: row.id, err: errText(err) });
    }
    if (result) {
      const out = await settleVaultTopup(deps, row, vault, result, VAULT_SWEEP_ACTOR);
      if (out.status === 'COMPLETED' || out.status === 'PENDING' || out.status === 'DECLINED') {
        return out.status;
      }
      log('replay unresolved', { topupId: row.id, code: out.status === 'ERROR' ? out.code : null });
    }
  }
  if (now - row.createdAt.getTime() >= VAULT_GIVE_UP_AFTER_MS) {
    return (await giveUp(deps, row)) ? 'GAVE_UP' : settledMeanwhile(deps, row.id);
  }
  return 'UNRESOLVED';
}

/**
 * CREATED → FAILED + `needs_reconcile`, with `TOPUP_FAILED` and an `ALERT`, in one transaction.
 * False when the row left CREATED meanwhile (a late answer credited it first).
 */
async function giveUp(deps: JobDeps, row: OrphanRow): Promise<boolean> {
  return deps.db.tx(async (tx) => {
    const failed = await transition(tx, 'topups', row.id, 'CREATED', 'FAILED', {
      needs_reconcile: true,
      error_code: row.errorCode ?? 'VAULT_TOPUP_UNRESOLVED',
      updated_at: new Date(),
    });
    if (!failed) return false;
    const data = {
      code: 'VAULT_TOPUP_UNRESOLVED',
      method: 'VAULT_MIT',
      trigger: row.trigger,
      orderId: row.paypalOrderId,
      amountCents: row.amountCents,
    };
    await audit(tx, {
      ...VAULT_SWEEP_ACTOR,
      entity: 'topups',
      entityId: row.id,
      action: 'TOPUP_FAILED',
      paypalId: row.paypalOrderId,
      data: { ...data, needsReconcile: true },
    });
    await audit(tx, {
      ...VAULT_SWEEP_ACTOR,
      entity: 'topups',
      entityId: row.id,
      action: 'ALERT',
      paypalId: row.paypalOrderId,
      data: { alert: 'VAULT_TOPUP_UNRESOLVED', topupId: row.id, ...data },
    });
    return true;
  });
}

async function settledMeanwhile(deps: JobDeps, topupId: string): Promise<VaultSweepOutcome> {
  const { rows } = await deps.db.pool.query<{ status: TopupRow['status'] }>(
    `SELECT status FROM topups WHERE id = $1`,
    [topupId],
  );
  const status = rows[0]?.status;
  if (status === 'AWAITING_APPROVAL') return 'PENDING';
  if (status === 'FAILED') return 'DECLINED';
  return status === 'CREATED' ? 'UNRESOLVED' : 'COMPLETED';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultLog(msg: string, data: Record<string, unknown>): void {
  console.warn(`[vault-topup-sweep] ${msg} ${JSON.stringify(data)}`);
}
