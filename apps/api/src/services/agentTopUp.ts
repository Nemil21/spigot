// `POST /v1/topups` and MCP `top_up` (api.md §`POST /v1/topups`; features/08 §MCP `top_up`;
// SP-022b, SP-047b). Both call this, so idempotency and the response are identical on either
// channel.
//
// - **Saved method** (SP-047b): charge it now through SP-047a's `reserveVaultTopup`
//   (`trigger=MCP`) + `chargeVaultTopup`: the same buyer-row lock, one `VAULT_MIT` in flight and
//   the monthly cap as auto top-up (data-model rule 11), so an agent looping on `top_up` stops at
//   the cap (422 `AUTO_TOPUP_CAP_REACHED`, W15 copy, no PayPal call), not only at the rate limit.
//   COMPLETED → `{ status: 'COMPLETED', balanceMicros }`.
// - **No saved method, or it was declined** (SP-022b): SP-018b's `createTopupForAgent`, a CAPTURE-intent wallet order
//   whose approval link the agent hands to its human.
import { autoTopupCapReachedMessage, autoTopupDeclinedMessage } from '@spigot/shared';
import { ApiError } from '../http/errors.js';
import { autoKey, requestHash } from '../meter/idempotency.js';
import { AUTO_TOPUP_TIMEOUT_MS, chargeVaultTopup, reserveVaultTopup } from '../topups/autoTopup.js';
import {
  agentIdempotencyKey,
  createTopupForAgent,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  TOPUP_COLUMNS,
  type TopupDeps,
  type TopupRow,
} from '../topups/index.js';
import { balance } from './balance.js';

export interface AgentTopUpInput {
  buyerId: string;
  apiKeyId: string;
  amountCents: number;
  /**
   * The client's key (REST `Idempotency-Key`, MCP `idempotencyKey`, or MCP's
   * `mcp:<session>:<jsonrpc id>`). Undefined → `autoKey` over the amount and a minute bucket, so
   * an accidental double-send is one top-up while a deliberate one a minute later is a new one.
   */
  idempotencyKey?: string;
  now?: Date;
}

export interface AgentTopUpResult {
  topupId: string;
  /**
   * Vault: `COMPLETED` (credited), or `CREATED` while PayPal hasn't confirmed yet. Link:
   * `AWAITING_APPROVAL`. A replay of a finished top-up returns its final status.
   */
  status: string;
  /** `VAULT_MIT` (charged the saved method) or `PAYPAL_WALLET` (approval link). */
  method: string;
  amountCents: number;
  orderId: string | null;
  /** The PayPal approval link for the human; `null` for a vault charge or a finished top-up. */
  approveUrl: string | null;
  /** Set when the top-up has `COMPLETED`: the balance now. */
  balanceMicros?: number;
  /** A retry with the same key: this is the first call's top-up, nothing new was charged. */
  replay?: boolean;
}

/** How often a call that finds another vault top-up in flight re-checks. */
const IN_FLIGHT_POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function agentTopUp(
  deps: TopupDeps & { timeoutMs?: number },
  input: AgentTopUpInput,
): Promise<AgentTopUpResult> {
  const key =
    input.idempotencyKey ??
    autoKey(
      input.apiKeyId,
      requestHash({ op: 'topup', amountCents: input.amountCents }),
      input.now,
    );
  // A retry of a vault top-up replays it (or waits for it) even after a later decline: only a
  // new key falls back to the link.
  const prior = await topupByKey(deps, input.buyerId, agentIdempotencyKey(key));
  if (prior?.method === 'VAULT_MIT') {
    const replayed = await vaultTopUp(deps, input, key);
    if (replayed) return replayed;
  }
  const vaulted = await deps.db.pool.query<{ vaulted: boolean }>(
    // A method PayPal declined stays saved but isn't charged again (features/08 §Edge cases:
    // re-approve link) until the buyer saves a method or turns auto top-up back on in W11.
    `SELECT vault_id IS NOT NULL AND auto_topup_declined_at IS NULL AS vaulted
       FROM buyers WHERE id = $1`,
    [input.buyerId],
  );
  if (vaulted.rows[0]?.vaulted) {
    const fromVault = await vaultTopUp(deps, input, key);
    if (fromVault) return fromVault;
  }
  return linkTopUp(deps, input, key);
}

/** SP-022b: a wallet order and its approval link (no saved method, or a key used for a link). */
async function linkTopUp(
  deps: TopupDeps,
  input: AgentTopUpInput,
  key: string,
): Promise<AgentTopUpResult> {
  const t = await createTopupForAgent(deps, input.buyerId, input.amountCents, key);
  const out: AgentTopUpResult = {
    topupId: t.topupId,
    status: t.status,
    method: t.topup.method ?? 'PAYPAL_WALLET',
    amountCents: t.amountCents,
    orderId: t.orderId,
    approveUrl: t.approveUrl,
  };
  if (t.status === 'COMPLETED') {
    out.balanceMicros = (await balance({ db: deps.db.pool }, input.buyerId)).balanceMicros;
  }
  return out;
}

/**
 * The saved-method charge. Returns null when the key already names a link top-up or the vault went
 * away meanwhile (the caller falls back to the link). Throws `AUTO_TOPUP_CAP_REACHED` at the cap,
 * `TOPUP_FAILED` on a decline (auto top-up is now off, W11 shows the declined banner) and
 * `STATE_CONFLICT` while another vault top-up is still in flight past the wait budget.
 */
async function vaultTopUp(
  deps: TopupDeps & { timeoutMs?: number },
  input: AgentTopUpInput,
  key: string,
): Promise<AgentTopUpResult | null> {
  const { buyerId, amountCents } = input;
  if (
    !Number.isInteger(amountCents) ||
    amountCents < MIN_TOPUP_CENTS ||
    amountCents > MAX_TOPUP_CENTS
  ) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Top-ups are $${MIN_TOPUP_CENTS / 100}–$${MAX_TOPUP_CENTS / 100}.`,
      { minCents: MIN_TOPUP_CENTS, maxCents: MAX_TOPUP_CENTS },
    );
  }
  const idempotencyKey = agentIdempotencyKey(key);
  const budget = deps.timeoutMs ?? AUTO_TOPUP_TIMEOUT_MS;
  const deadline = Date.now() + budget;

  for (;;) {
    // A retry of the same key replays the first top-up, never a second charge.
    const prior = await topupByKey(deps, buyerId, idempotencyKey);
    if (prior) {
      if (prior.method !== 'VAULT_MIT') return null;
      // The first call is still charging: wait for its answer rather than report CREATED.
      if (
        prior.status === 'CREATED' &&
        Date.now() - prior.createdAt.getTime() < AUTO_TOPUP_TIMEOUT_MS &&
        Date.now() + IN_FLIGHT_POLL_MS < deadline
      ) {
        await sleep(IN_FLIGHT_POLL_MS);
        continue;
      }
      return replay(deps, prior, amountCents);
    }

    let r;
    try {
      r = await reserveVaultTopup(deps.db, {
        buyerId,
        trigger: 'MCP',
        amountCents,
        idempotencyKey,
        ...(input.now ? { now: input.now } : {}),
      });
    } catch (err) {
      // The same key reserved meanwhile (`unique(buyer_id, idempotency_key)`): replay it.
      if ((err as { code?: string }).code === '23505') continue;
      throw err;
    }

    switch (r.kind) {
      case 'NO_VAULT':
        return null;
      case 'CAP_REACHED':
        throw new ApiError(
          'AUTO_TOPUP_CAP_REACHED',
          autoTopupCapReachedMessage({ monthlyCapCents: r.monthlyCapCents }),
          {
            monthlyCapCents: r.monthlyCapCents,
            usedThisMonthCents: r.usedCents,
            remainingThisMonthCents: Math.max(0, r.monthlyCapCents - r.usedCents),
            amountCents: r.amountCents,
          },
        );
      case 'IN_FLIGHT':
        // Wait for a top-up that can still land (its own call gives up after the timeout).
        if (r.ageMs >= AUTO_TOPUP_TIMEOUT_MS || Date.now() + IN_FLIGHT_POLL_MS >= deadline) {
          throw new ApiError(
            'STATE_CONFLICT',
            'A top-up from your saved PayPal method is already in progress. Call get_balance in ' +
              'a minute before topping up again.',
            { topupId: r.topupId },
          );
        }
        await sleep(IN_FLIGHT_POLL_MS);
        continue;
      case 'BALANCE_OK':
      case 'DISABLED':
      case 'WOULD_NOT_HELP':
        // Only for AUTO or a priced call; an MCP reservation never returns these.
        throw new Error(`agentTopUp: unexpected reservation ${r.kind}`);
      case 'RESERVED': {
        const out = await chargeVaultTopup(deps, r, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          actor: { actorType: 'MCP_CLIENT', actorId: buyerId },
        });
        const base = {
          topupId: r.topup.id,
          method: 'VAULT_MIT',
          amountCents: r.topup.amountCents,
          approveUrl: null,
        };
        switch (out.status) {
          case 'COMPLETED':
            return {
              ...base,
              status: 'COMPLETED',
              orderId: out.topup.paypalOrderId,
              balanceMicros: out.balanceMicros,
            };
          case 'DECLINED':
            throw new ApiError(
              'TOPUP_FAILED',
              autoTopupDeclinedMessage({ method: out.vaultKind }),
              {
                topupId: out.topupId,
                paypalCode: out.code,
              },
            );
          case 'PENDING':
            return { ...base, status: out.topup.status, orderId: out.topup.paypalOrderId };
          default:
            // TIMEOUT / ERROR: the row stays CREATED; the call or SP-047c's sweep credits it once.
            return { ...base, status: 'CREATED', orderId: null };
        }
      }
    }
  }
}

async function topupByKey(
  deps: TopupDeps,
  buyerId: string,
  idempotencyKey: string,
): Promise<TopupRow | null> {
  const { rows } = await deps.db.pool.query<TopupRow>(
    `SELECT ${TOPUP_COLUMNS} FROM topups WHERE buyer_id = $1 AND idempotency_key = $2`,
    [buyerId, idempotencyKey],
  );
  return rows[0] ?? null;
}

async function replay(
  deps: TopupDeps,
  t: TopupRow,
  amountCents: number,
): Promise<AgentTopUpResult> {
  if (t.trigger !== 'MCP' || t.amountCents !== amountCents) {
    throw new ApiError(
      'IDEMPOTENCY_MISMATCH',
      'This idempotency key was already used for a different top-up.',
      { topupId: t.id },
    );
  }
  if (t.status === 'FAILED') {
    // The retried call was declined: say so again, as `createTopup` does for its FAILED replays.
    const { rows } = await deps.db.pool.query<{ kind: 'CARD' | 'PAYPAL' | null }>(
      `SELECT vault_kind AS kind FROM buyers WHERE id = $1`,
      [t.buyerId],
    );
    throw new ApiError(
      'TOPUP_FAILED',
      autoTopupDeclinedMessage(rows[0]?.kind ? { method: rows[0].kind } : {}),
      { topupId: t.id, paypalCode: t.errorCode, replay: true },
    );
  }
  const out: AgentTopUpResult = {
    topupId: t.id,
    status: t.status,
    method: 'VAULT_MIT',
    amountCents: t.amountCents,
    orderId: t.paypalOrderId,
    approveUrl: null,
    replay: true,
  };
  if (t.status === 'COMPLETED') {
    out.balanceMicros = (await balance({ db: deps.db.pool }, t.buyerId)).balanceMicros;
  }
  return out;
}
