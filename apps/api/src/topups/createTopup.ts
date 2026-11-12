import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { transition } from '../db/transition.js';
import { ApiError } from '../http/errors.js';
import {
  applyTopupResult,
  callPayPal,
  topupById,
  topupFailed,
  type CaptureOutcome,
  type TopupDeps,
} from './capture.js';
import { walletUrls } from './deps.js';
import { TOPUP_COLUMNS, type TopupRow } from './row.js';

/** $5–$500 (data-model §topups CHECK; features/08 fees note: minimum $5). */
export const MIN_TOPUP_CENTS = 500;
export const MAX_TOPUP_CENTS = 50_000;

export const createTopupBody = z.object({
  amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
  // `CARD`: JS SDK v6 card fields in W11 (SP-063). The server never sees the card number.
  method: z.enum(['PAYPAL_WALLET', 'CARD']),
  saveForAutoTopup: z.boolean().default(false),
});

export type CreateTopupBody = z.infer<typeof createTopupBody>;

export interface CreateTopupInput extends CreateTopupBody {
  buyerId: string;
  /** The client's `Idempotency-Key` (stored; `unique(buyer_id, idempotency_key)`). */
  idempotencyKey: string;
  trigger?: 'MANUAL' | 'MCP';
}

export interface CreatedTopup {
  topup: TopupRow;
  /** PayPal's buyer approval link (`rel=payer-action`), while the order awaits approval. */
  approveUrl: string | null;
  /**
   * Vault attributes were sent: a card with `saveForAutoTopup` (card vault is proven, S2 / S7
   * step 1), a wallet with `saveForAutoTopup` and `PAYPAL_WALLET_VAULT=on`.
   */
  vaultRequested: boolean;
  /** Set only if PayPal captured at create (not expected for a wallet order). */
  capture?: CaptureOutcome;
}

/**
 * `POST /api/buyer/topups` (features/08 §Manual top-up 2): insert `topups` CREATED (its `id` is
 * the order-create `PayPal-Request-Id` and `custom_id`), create the CAPTURE-intent order, then
 * CREATED → AWAITING_APPROVAL with the order id.
 *
 * `PAYPAL_WALLET` sends the wallet source (approval in PayPal's window). `CARD` (SP-063, features/08
 * §Manual top-up 7) sends a card source with **no number**: W11's JS SDK v6 card fields
 * `submit(orderId)` hands the card to PayPal, then the browser calls the capture endpoint, which
 * credits and saves the vaulted card (`vault_kind=CARD`, label "Visa ••1111").
 *
 * Idempotent per `(buyer, Idempotency-Key)`: a double click (even two racing requests) gets the
 * same row. A row still CREATED / AWAITING_APPROVAL re-sends the create with the same request id,
 * which PayPal replays (no-raw-card orders replay cleanly, S7 step 3), so both clicks also get the
 * same order and approval link. A finished row is returned as is.
 */
export async function createTopup(deps: TopupDeps, input: CreateTopupInput): Promise<CreatedTopup> {
  const { db, config } = deps;
  const vaultRequested =
    input.saveForAutoTopup && (input.method === 'CARD' || config.PAYPAL_WALLET_VAULT === 'on');
  const actor = { actorType: 'BUYER' as const, actorId: input.buyerId };

  let topup = await db.tx(async (tx) => {
    const { rows } = await tx.query<TopupRow>(
      `INSERT INTO topups (buyer_id, amount_cents, method, trigger, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (buyer_id, idempotency_key) DO NOTHING
       RETURNING ${TOPUP_COLUMNS}`,
      [
        input.buyerId,
        input.amountCents,
        input.method,
        input.trigger ?? 'MANUAL',
        input.idempotencyKey,
      ],
    );
    const row = rows[0];
    if (row) {
      await audit(tx, {
        ...actor,
        entity: 'topups',
        entityId: row.id,
        action: 'TOPUP_CREATED',
        data: {
          amountCents: row.amountCents,
          method: row.method,
          trigger: row.trigger,
          vaultRequested,
        },
      });
    }
    return row ?? null;
  });

  if (!topup) {
    // Same key: the first request's row (committed: the conflict waited for it).
    const { rows } = await db.pool.query<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM topups WHERE buyer_id = $1 AND idempotency_key = $2`,
      [input.buyerId, input.idempotencyKey],
    );
    topup = rows[0]!;
    if (topup.amountCents !== input.amountCents || topup.method !== input.method) {
      throw new ApiError(
        'IDEMPOTENCY_MISMATCH',
        'This Idempotency-Key was already used for a different top-up.',
        { topupId: topup.id },
      );
    }
    if (topup.status === 'FAILED') throw topupFailed(topup.id, topup.errorCode);
    if (topup.status !== 'CREATED' && topup.status !== 'AWAITING_APPROVAL') {
      return { topup, approveUrl: null, vaultRequested };
    }
  }

  const row = topup;
  const result = await callPayPal(row.id, () =>
    deps.pp.createTopupOrder({
      topupId: row.id,
      amountCents: row.amountCents,
      source:
        row.method === 'CARD'
          ? // 3DS (SCA_WHEN_REQUIRED) returns here if PayPal needs a redirect; it captures too.
            { kind: 'card_fields', ...walletUrls(config), vault: vaultRequested }
          : { kind: 'wallet', ...walletUrls(config), vault: vaultRequested, brandName: 'Spigot' },
    }),
  );

  if (result.status === 'AWAITING_APPROVAL') {
    // A `null` result means the other click moved it first (or it was already waiting): fine.
    await transition(db.pool, 'topups', row.id, 'CREATED', 'AWAITING_APPROVAL', {
      paypal_order_id: result.orderId,
      updated_at: new Date(),
    });
    const current = (await topupById(db, row.id)) ?? row;
    return { topup: current, approveUrl: result.approveUrl, vaultRequested };
  }

  // Wallet and card-fields orders don't capture at create; handle any other answer as capture does.
  if ((result.status === 'COMPLETED' || result.status === 'PENDING') && !row.paypalOrderId) {
    await db.pool.query(
      `UPDATE topups SET paypal_order_id = $2 WHERE id = $1 AND paypal_order_id IS NULL`,
      [row.id, result.orderId],
    );
  }
  const capture = await applyTopupResult(deps, row, result, actor);
  return { topup: capture.topup, approveUrl: null, vaultRequested, capture };
}
