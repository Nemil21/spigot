import { ApiError } from '../http/errors.js';
import { checkClientKey } from '../meter/idempotency.js';
import type { TopupDeps } from './capture.js';
import { createTopup, MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from './createTopup.js';
import type { TopupRow } from './row.js';

export interface AgentTopup {
  topupId: string;
  /** `AWAITING_APPROVAL` for a new link; a finished top-up replayed by its key returns as is. */
  status: TopupRow['status'];
  orderId: string | null;
  /** The sandbox `checkoutnow?token=…` link the agent shows its human; `null` once finished. */
  approveUrl: string | null;
  amountCents: number;
  topup: TopupRow;
}

/** Agent keys get their own namespace in `unique(buyer_id, idempotency_key)`, apart from W11's. */
export function agentIdempotencyKey(key: string): string {
  return `mcp:${key}`;
}

/**
 * MCP `top_up` / `POST /v1/topups` without a vaulted method (features/08 §MCP `top_up`, P0): a
 * CAPTURE-intent wallet order (`trigger=MCP`, no vault yet) whose approval link the agent hands to
 * its human. PayPal sends them back to `/topups/return`, which captures and credits once
 * (SP-018a `handleTopupReturn`). The SP-022b tool / route call this.
 *
 * Idempotent per `(buyer, idempotencyKey)` like `createTopup`: a retried tool call gets the same
 * top-up and the same link (no-source wallet creates replay cleanly at PayPal, S7 step 3).
 */
export async function createTopupForAgent(
  deps: TopupDeps,
  buyerId: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<AgentTopup> {
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
  // Same rule as W11's `Idempotency-Key` (1–255 printable ASCII).
  checkClientKey(idempotencyKey);

  const created = await createTopup(deps, {
    buyerId,
    amountCents,
    method: 'PAYPAL_WALLET',
    saveForAutoTopup: false,
    idempotencyKey: agentIdempotencyKey(idempotencyKey),
    trigger: 'MCP',
  });
  const { topup } = created;
  // A W11 key that happens to be `mcp:<key>` names a portal top-up, not this agent's.
  if (topup.trigger !== 'MCP') {
    throw new ApiError(
      'IDEMPOTENCY_MISMATCH',
      'This idempotency key was already used for another top-up.',
      { topupId: topup.id },
    );
  }
  return {
    topupId: topup.id,
    status: topup.status,
    orderId: topup.paypalOrderId,
    approveUrl: created.approveUrl,
    amountCents: topup.amountCents,
    topup,
  };
}
