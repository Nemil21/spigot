import {
  autoTopupCapReachedMessage,
  autoTopupDeclinedMessage,
  centsToMicros,
  type ErrorCode,
} from '@spigot/shared';
import { audit, type ActorType } from '../audit/audit.js';
import type { Db, Tx } from '../db/index.js';
import { transition } from '../db/transition.js';
import { ApiError } from '../http/errors.js';
import type { OnInsufficient, ShortBalance } from '../meter/charge.js';
import type { TopupResult, TopupSource } from '../paypal/index.js';
import { applyTopupResult, type TopupDeps } from './capture.js';
import { balanceOf, type CreditActor } from './creditTopup.js';
import { TOPUP_COLUMNS, type TopupRow } from './row.js';

/**
 * Auto top-up (features/08 §Auto top-up, features/07 §`chargeAndRecord` step 5, data-model rule
 * 11; SP-047a). When a paid call is short, SP-016's `chargeAndRecord` rolls back and calls the
 * `onInsufficient` hook **outside** any transaction. The hook:
 *
 * 1. **Tx A** (`reserveVaultTopup`): `SELECT … FROM buyers WHERE id=$1 FOR NO KEY UPDATE`, then
 *    re-read the balance. If another call's top-up already landed (`balance ≥ price`), skip to
 *    step 4.
 * 2. Still in tx A: require `auto_topup_enabled`, a vault, **no `VAULT_MIT` top-up `CREATED`** for
 *    this buyer (AUTO or MCP), this UTC month's `VAULT_MIT` sum + amount ≤ the cap, and
 *    `balance + amount ≥ price`. Insert `topups` (AUTO, VAULT_MIT, CREATED) and COMMIT: the buyer
 *    row is held for milliseconds, never during the PayPal call.
 * 3. Outside any transaction (`chargeVaultTopup`): `pp.createTopupOrder` with the vault id and
 *    `stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT}` (`PayPal-Request-Id` = topup id). A
 *    vault order captures at create → `creditTopup`. Given up on after 10 s (the buyer gets the
 *    402); the call keeps running and credits when PayPal answers, and SP-047c's sweep replays the
 *    same request id for a row left CREATED.
 * 4. `chargeAndRecord` retries the charge once.
 *
 * Lock order: tx A takes only the buyer row (the balance read and the `topups` insert take no
 * other row locks). Everything else that touches the buyer row (`creditTopupTx` saving the vault,
 * the decline below) takes it **last**, after `topups` / `ledger_accounts`, and tx A never waits on
 * those, so no cycle is possible.
 *
 * Tx A locks `FOR NO KEY UPDATE`, never `FOR UPDATE`. Foreign keys lock the buyer row too: every
 * insert referencing `buyers` (the metering transaction's `api_calls` row) and every second UPDATE
 * of a `topups` row in one transaction (`creditTopupTx`'s `ledger_txn_id`) takes `FOR KEY SHARE`
 * on it. The metering transaction takes it **first** and then `ledger_accounts`; a credit takes
 * `ledger_accounts` and then it. `FOR KEY SHARE` locks never conflict with each other, so those two
 * orders are harmless, but `FOR UPDATE` conflicts with them: a burst of reservations held and
 * queued on the row made a credit's FK check wait behind a reservation that waited on a charge
 * that waited on the credit's ledger row (40P01, main's red SP-047c burst test; the rolled-back
 * credit left a captured top-up uncredited until the sweep). `FOR NO KEY UPDATE` still serialises
 * reservations with each other and with every `UPDATE buyers`, and never blocks a foreign-key
 * check, so a FK check on `buyers` never waits.
 *
 * SP-047b's MCP `top_up` uses the same `reserveVaultTopup` (`trigger: 'MCP'`) and
 * `chargeVaultTopup`, so the cap and the one-in-flight rule cover both.
 */

/** Step 3's budget: past this the buyer gets the 402 and the top-up finishes in the background. */
export const AUTO_TOPUP_TIMEOUT_MS = 10_000;

/**
 * How often a call queued behind another call's in-flight top-up re-checks. It waits only while
 * that top-up is younger than `AUTO_TOPUP_TIMEOUT_MS`; an older CREATED row is an orphan.
 */
const IN_FLIGHT_POLL_MS = 50;

/**
 * `VAULT_MIT` top-ups that count against `monthly_topup_cap_cents`: everything not known to have
 * failed. An in-flight CREATED one counts, and so does one refunded later (the cap limits what we
 * charge the saved method, not what the buyer keeps).
 */
export const VAULT_MIT_CAP_STATUSES = [
  'CREATED',
  'AWAITING_APPROVAL',
  'COMPLETED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

/** The calendar month (UTC) containing `now`: `[start, end)`. */
export function utcMonthWindow(now: Date): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

/** Whether `amountCents` more fits this month's cap (rule 11). */
export function fitsMonthlyCap(args: {
  usedCents: number;
  amountCents: number;
  monthlyCapCents: number;
}): boolean {
  return args.usedCents + args.amountCents <= args.monthlyCapCents;
}

export interface ReserveVaultTopupInput {
  buyerId: string;
  /** `AUTO` (a short paid call, SP-047a) or `MCP` (the agent's `top_up` from the vault, SP-047b). */
  trigger: 'AUTO' | 'MCP';
  /** Default `buyers.auto_topup_amount_cents`. */
  amountCents?: number;
  /** The short call's price. Set → skip if the balance already covers it, refuse if `amount` wouldn't. */
  priceMicros?: number;
  /**
   * `buyers.auto_topup_threshold_micros` (SP-047c's after-charge trigger). Set → skip
   * (`BALANCE_OK`) unless the balance, re-read under the lock, is still below it.
   */
  whenBelowMicros?: number;
  /**
   * Stored as `topups.idempotency_key` (SP-047b's MCP `top_up`: `mcp:<key>`). A second reservation
   * with the same key fails on `unique(buyer_id, idempotency_key)` (23505, nothing written): the
   * caller replays the first top-up instead of charging twice.
   */
  idempotencyKey?: string;
  /** Clock for the cap's month (tests). */
  now?: Date;
}

export interface VaultRefRow {
  id: string;
  kind: 'CARD' | 'PAYPAL';
}

export type Reservation =
  /** A `topups` row (VAULT_MIT, CREATED) is committed: run `chargeVaultTopup` next. */
  | {
      kind: 'RESERVED';
      topup: TopupRow;
      vault: VaultRefRow;
      balanceMicros: number;
      /**
       * `npm run demo:decline` flagged this buyer (`mock_decline_next`, consumed here by the next
       * AUTO reservation): send `PayPal-Mock-Response INSTRUMENT_DECLINED` on the create. The client
       * drops the header unless sandbox + DEMO_MODE + ALLOW_MOCK_DECLINE.
       */
      mockDecline?: boolean;
    }
  /** The balance already covers `priceMicros` (another call's top-up landed). */
  | { kind: 'BALANCE_OK'; balanceMicros: number }
  /** `trigger: 'AUTO'` and the buyer turned auto top-up off. */
  | { kind: 'DISABLED' }
  /** No saved PayPal method. */
  | { kind: 'NO_VAULT' }
  /** Another `VAULT_MIT` top-up (AUTO or MCP) is CREATED for this buyer; `ageMs` since it was. */
  | { kind: 'IN_FLIGHT'; topupId: string; ageMs: number }
  | { kind: 'CAP_REACHED'; monthlyCapCents: number; usedCents: number; amountCents: number }
  /** `balance + amount < price`: a top-up wouldn't make this call affordable. */
  | { kind: 'WOULD_NOT_HELP'; balanceMicros: number; amountCents: number };

interface BuyerVaultRow {
  enabled: boolean;
  amountCents: number;
  capCents: number;
  vaultId: string | null;
  vaultKind: 'CARD' | 'PAYPAL' | null;
  mockDeclineNext: boolean;
}

/** Steps 1–2: tx A. Holds the buyer row only for this transaction (milliseconds). */
export async function reserveVaultTopup(
  db: Db,
  input: ReserveVaultTopupInput,
): Promise<Reservation> {
  return db.tx(async (tx) => {
    // NO KEY UPDATE, never UPDATE: see the lock order above (FOR UPDATE blocks FK checks).
    const { rows } = await tx.query<BuyerVaultRow>(
      `SELECT auto_topup_enabled AS enabled, auto_topup_amount_cents AS "amountCents",
              monthly_topup_cap_cents AS "capCents", vault_id AS "vaultId", vault_kind AS "vaultKind",
              mock_decline_next AS "mockDeclineNext"
         FROM buyers WHERE id = $1 FOR NO KEY UPDATE`,
      [input.buyerId],
    );
    const b = rows[0];
    if (!b) throw new Error(`reserveVaultTopup: unknown buyer ${input.buyerId}`);

    // Re-read under the lock: a call queued behind another's top-up sees the new balance here.
    const balanceMicros = await balanceOf(tx, input.buyerId);
    if (input.priceMicros !== undefined && balanceMicros >= input.priceMicros) {
      return { kind: 'BALANCE_OK', balanceMicros };
    }
    if (input.whenBelowMicros !== undefined && balanceMicros >= input.whenBelowMicros) {
      return { kind: 'BALANCE_OK', balanceMicros };
    }
    if (input.trigger === 'AUTO' && !b.enabled) return { kind: 'DISABLED' };
    if (!b.vaultId) return { kind: 'NO_VAULT' };

    // Age by the database clock: the row's `created_at` is too.
    const inFlight = await tx.query<{ id: string; ageMs: number }>(
      `SELECT id, (extract(epoch FROM clock_timestamp() - created_at) * 1000)::float8 AS "ageMs"
         FROM topups
        WHERE buyer_id = $1 AND method = 'VAULT_MIT' AND status = 'CREATED'
        ORDER BY created_at
        LIMIT 1`,
      [input.buyerId],
    );
    const flying = inFlight.rows[0];
    if (flying) return { kind: 'IN_FLIGHT', topupId: flying.id, ageMs: Number(flying.ageMs) };

    const amountCents = input.amountCents ?? b.amountCents;
    const { start, end } = utcMonthWindow(input.now ?? new Date());
    const used = await tx.query<{ cents: number }>(
      `SELECT coalesce(sum(amount_cents), 0)::int AS cents FROM topups
        WHERE buyer_id = $1 AND method = 'VAULT_MIT' AND status = ANY($2)
          AND created_at >= $3 AND created_at < $4`,
      [input.buyerId, VAULT_MIT_CAP_STATUSES, start, end],
    );
    const usedCents = used.rows[0]?.cents ?? 0;
    if (!fitsMonthlyCap({ usedCents, amountCents, monthlyCapCents: b.capCents })) {
      return { kind: 'CAP_REACHED', monthlyCapCents: b.capCents, usedCents, amountCents };
    }
    if (
      input.priceMicros !== undefined &&
      balanceMicros + centsToMicros(amountCents) < input.priceMicros
    ) {
      return { kind: 'WOULD_NOT_HELP', balanceMicros, amountCents };
    }

    const inserted = await tx.query<TopupRow>(
      `INSERT INTO topups (buyer_id, amount_cents, method, trigger, idempotency_key)
       VALUES ($1, $2, 'VAULT_MIT', $3, $4)
       RETURNING ${TOPUP_COLUMNS}`,
      [input.buyerId, amountCents, input.trigger, input.idempotencyKey ?? null],
    );
    const topup = inserted.rows[0]!;
    // demo:decline's flag is one-shot and only for an AUTO top-up (features/15 §Demo hooks).
    const mockDecline = input.trigger === 'AUTO' && b.mockDeclineNext;
    if (mockDecline) {
      await tx.query(`UPDATE buyers SET mock_decline_next = false WHERE id = $1`, [input.buyerId]);
    }
    await audit(tx, {
      actorType: actorTypeOf(input.trigger),
      actorId: input.buyerId,
      entity: 'topups',
      entityId: topup.id,
      action: 'TOPUP_CREATED',
      data: {
        amountCents,
        method: 'VAULT_MIT',
        trigger: input.trigger,
        vaultKind: b.vaultKind,
        monthUsedCents: usedCents,
        monthlyCapCents: b.capCents,
        ...(input.priceMicros !== undefined ? { shortCallPriceMicros: input.priceMicros } : {}),
        ...(input.whenBelowMicros !== undefined ? { thresholdMicros: input.whenBelowMicros } : {}),
        ...(mockDecline ? { mockDecline: true } : {}),
      },
    });
    return {
      kind: 'RESERVED',
      topup,
      vault: { id: b.vaultId, kind: b.vaultKind ?? 'CARD' },
      balanceMicros,
      ...(mockDecline ? { mockDecline: true } : {}),
    };
  });
}

export type VaultChargeOutcome =
  | { status: 'COMPLETED'; topup: TopupRow; balanceMicros: number }
  /** PayPal is holding the capture: the poller / webhook credits it later. */
  | { status: 'PENDING'; topup: TopupRow }
  /** Top-up FAILED and `auto_topup_enabled=false`. */
  | { status: 'DECLINED'; topupId: string; code: string; vaultKind: 'CARD' | 'PAYPAL' }
  /** No answer within the budget; the call goes on in the background. */
  | { status: 'TIMEOUT'; topupId: string }
  /** PayPal didn't confirm (row left CREATED for SP-047c's sweep) or the capture didn't match. */
  | { status: 'ERROR'; topupId: string; code: string };

export interface VaultChargeOptions {
  /** Default `AUTO_TOPUP_TIMEOUT_MS`. */
  timeoutMs?: number;
  actor?: CreditActor;
}

/** The PayPal source for a vaulted method: card MIT (`stored_credential`) or a vaulted wallet. */
export function vaultSource(vault: VaultRefRow): TopupSource {
  return vault.kind === 'PAYPAL'
    ? { kind: 'wallet_vault', vaultId: vault.id }
    : { kind: 'card_vault', vaultId: vault.id };
}

/** Step 3: charge the vault for a reserved top-up. Never call inside a transaction. */
export async function chargeVaultTopup(
  deps: TopupDeps,
  r: Extract<Reservation, { kind: 'RESERVED' }>,
  opts: VaultChargeOptions = {},
): Promise<VaultChargeOutcome> {
  const { topup, vault } = r;
  const actor = opts.actor ?? { actorType: 'SYSTEM' as const };
  const work: Promise<VaultChargeOutcome> = (async () => {
    let result: TopupResult;
    try {
      result = await deps.pp.createTopupOrder({
        topupId: topup.id,
        amountCents: topup.amountCents,
        source: vaultSource(vault),
        ...(r.mockDecline ? { mockResponse: 'INSTRUMENT_DECLINED' as const } : {}),
      });
    } catch {
      // Auth failure or a bug: nothing is known. The row stays CREATED for the sweep (SP-047c).
      return { status: 'ERROR', topupId: topup.id, code: 'PAYPAL_ERROR' };
    }
    return settleVaultTopup(deps, topup, vault, result, actor);
  })();

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), opts.timeoutMs ?? AUTO_TOPUP_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([work, timedOut]);
    if (first !== 'TIMEOUT') return first;
    // Keep going: a late COMPLETED still credits (once: `creditTopup` locks the row).
    work.catch(() => {});
    return { status: 'TIMEOUT', topupId: topup.id };
  } finally {
    clearTimeout(timer);
  }
}

/** Apply a vault create's answer (the first call's or SP-047c's sweep replay) to its row. */
export async function settleVaultTopup(
  deps: TopupDeps,
  topup: TopupRow,
  vault: VaultRefRow,
  result: TopupResult,
  actor: CreditActor,
): Promise<VaultChargeOutcome> {
  if (result.status === 'DECLINED') {
    await deps.db.tx((tx) =>
      failVaultTopupTx(tx, topup.id, { code: result.code, orderId: result.orderId, actor }),
    );
    return { status: 'DECLINED', topupId: topup.id, code: result.code, vaultKind: vault.kind };
  }
  if ((result.status === 'COMPLETED' || result.status === 'PENDING') && !topup.paypalOrderId) {
    await deps.db.pool.query(
      `UPDATE topups SET paypal_order_id = $2 WHERE id = $1 AND paypal_order_id IS NULL`,
      [topup.id, result.orderId],
    );
  }
  try {
    const applied = await applyTopupResult(deps, topup, result, actor);
    return applied.status === 'COMPLETED'
      ? { status: 'COMPLETED', topup: applied.topup, balanceMicros: applied.balanceMicros }
      : { status: 'PENDING', topup: applied.topup };
  } catch (err) {
    if (err instanceof ApiError) return { status: 'ERROR', topupId: topup.id, code: err.code };
    throw err;
  }
}

/**
 * A declined vault top-up: `→ FAILED` with the PayPal code, `auto_topup_enabled=false` (the saved
 * method is no good until the buyer updates it; W11 shows the declined banner), audit
 * `TOPUP_FAILED`. One transaction, `topups` row first, then the buyer row (the lock order above).
 * Also SP-059's `PAYMENT.CAPTURE.DENIED` handler for a vault top-up PayPal held then denied.
 * Returns false when the row isn't an open `VAULT_MIT` top-up (nothing written).
 */
export async function failVaultTopupTx(
  tx: Tx,
  topupId: string,
  args: { code: string; orderId?: string | null; actor: CreditActor },
): Promise<boolean> {
  const { rows } = await tx.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups WHERE id = $1 FOR UPDATE`,
    [topupId],
  );
  const topup = rows[0];
  if (!topup || topup.method !== 'VAULT_MIT') return false;
  const failed = await transition(
    tx,
    'topups',
    topupId,
    ['CREATED', 'AWAITING_APPROVAL'],
    'FAILED',
    {
      error_code: args.code,
      paypal_order_id: topup.paypalOrderId ?? args.orderId ?? null,
      updated_at: new Date(),
    },
  );
  if (!failed) return false;
  // `auto_topup_declined_at` drives W11's declined banner until the buyer saves the card again.
  await tx.query(
    `UPDATE buyers SET auto_topup_enabled = false, auto_topup_declined_at = now(), updated_at = now()
      WHERE id = $1`,
    [topup.buyerId],
  );
  await audit(tx, {
    ...args.actor,
    entity: 'topups',
    entityId: topupId,
    action: 'TOPUP_FAILED',
    paypalId: topup.paypalOrderId ?? args.orderId ?? null,
    data: {
      code: args.code,
      method: 'VAULT_MIT',
      trigger: topup.trigger,
      orderId: topup.paypalOrderId ?? args.orderId ?? null,
      autoTopupDisabled: true,
    },
  });
  return true;
}

export type AutoTopupOutcome =
  /** This call charged the vault; retry the charge. */
  | { result: 'TOPPED_UP'; topupId: string; amountCents: number; balanceMicros: number }
  /** The balance covers the call now (another call's top-up landed); retry the charge. */
  | { result: 'BALANCE_OK'; balanceMicros: number }
  | { result: 'CAP_REACHED'; monthlyCapCents: number }
  | { result: 'DECLINED'; topupId: string; code: string; vaultKind: 'CARD' | 'PAYPAL' }
  /** Off, no vault, wouldn't help, still in flight, timed out, pending or errored: plain 402. */
  | {
      result: 'SKIPPED';
      reason:
        'DISABLED' | 'NO_VAULT' | 'WOULD_NOT_HELP' | 'IN_FLIGHT' | 'TIMEOUT' | 'PENDING' | 'ERROR';
      topupId?: string;
    };

export interface AutoTopupDeps extends TopupDeps {
  /** Total budget for the hook, including waiting on another call's top-up. Default 10 s. */
  timeoutMs?: number;
  actorType?: ActorType;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The whole hook for one short call. A call that finds another `VAULT_MIT` top-up in flight
 * waits for it (re-checking under the lock) instead of starting a second one, so 20 parallel
 * short calls make one $20 top-up and then all charge.
 */
export async function autoTopUp(
  deps: AutoTopupDeps,
  short: Pick<ShortBalance, 'buyerId' | 'priceMicros'>,
): Promise<AutoTopupOutcome> {
  const budget = deps.timeoutMs ?? AUTO_TOPUP_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  for (;;) {
    const r = await reserveVaultTopup(deps.db, {
      buyerId: short.buyerId,
      trigger: 'AUTO',
      priceMicros: short.priceMicros,
    });
    switch (r.kind) {
      case 'BALANCE_OK':
        return { result: 'BALANCE_OK', balanceMicros: r.balanceMicros };
      case 'CAP_REACHED':
        return { result: 'CAP_REACHED', monthlyCapCents: r.monthlyCapCents };
      case 'DISABLED':
      case 'NO_VAULT':
      case 'WOULD_NOT_HELP':
        return { result: 'SKIPPED', reason: r.kind };
      case 'IN_FLIGHT':
        // Wait only for a top-up that can still land: past `AUTO_TOPUP_TIMEOUT_MS` its own call
        // has given up and the row waits for SP-047c's sweep, so skip at once (rule 11) rather
        // than poll the buyer row lock for the whole budget.
        if (r.ageMs >= AUTO_TOPUP_TIMEOUT_MS || Date.now() + IN_FLIGHT_POLL_MS >= deadline) {
          return { result: 'SKIPPED', reason: 'IN_FLIGHT', topupId: r.topupId };
        }
        await sleep(IN_FLIGHT_POLL_MS);
        continue;
      case 'RESERVED': {
        const out = await chargeVaultTopup(deps, r, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          actor: { actorType: deps.actorType ?? 'SYSTEM', actorId: short.buyerId },
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
            return {
              result: 'DECLINED',
              topupId: out.topupId,
              code: out.code,
              vaultKind: out.vaultKind,
            };
          case 'PENDING':
            return { result: 'SKIPPED', reason: 'PENDING', topupId: out.topup.id };
          default:
            return { result: 'SKIPPED', reason: out.status, topupId: out.topupId };
        }
      }
    }
  }
}

export interface AutoTopupHook {
  onInsufficient: OnInsufficient;
  /** What the hook did for this call (null until it ran). */
  outcome(): AutoTopupOutcome | null;
  /** Cents this call topped up (`Spigot-Auto-Topup`), or null. */
  toppedUpCents(): number | null;
}

/** SP-016's `onInsufficient` for one paid call, remembering what happened for the response. */
export function autoTopupHook(deps: AutoTopupDeps): AutoTopupHook {
  let outcome: AutoTopupOutcome | null = null;
  return {
    async onInsufficient(short) {
      outcome = await autoTopUp(deps, short);
      return outcome.result === 'TOPPED_UP' || outcome.result === 'BALANCE_OK';
    },
    outcome: () => outcome,
    toppedUpCents: () => (outcome?.result === 'TOPPED_UP' ? outcome.amountCents : null),
  };
}

/**
 * The 402 error for a call auto top-up couldn't save: `AUTO_TOPUP_CAP_REACHED` (W15 cap copy) or,
 * after a decline, `TOPUP_FAILED` (W15 "auto top-up declined" copy). Null → the usual
 * `INSUFFICIENT_BALANCE`.
 */
export function autoTopupError(
  outcome: AutoTopupOutcome | null,
): { code: ErrorCode; message: string } | null {
  if (outcome?.result === 'CAP_REACHED') {
    return {
      code: 'AUTO_TOPUP_CAP_REACHED',
      message: autoTopupCapReachedMessage({ monthlyCapCents: outcome.monthlyCapCents }),
    };
  }
  if (outcome?.result === 'DECLINED') {
    return {
      code: 'TOPUP_FAILED',
      message: autoTopupDeclinedMessage({ method: outcome.vaultKind }),
    };
  }
  return null;
}

function actorTypeOf(trigger: 'AUTO' | 'MCP'): ActorType {
  return trigger === 'MCP' ? 'MCP_CLIENT' : 'SYSTEM';
}
