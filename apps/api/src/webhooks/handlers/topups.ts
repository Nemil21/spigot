import { audit } from '../../audit/audit.js';
import type { Tx } from '../../db/index.js';
import { transition } from '../../db/transition.js';
import { ApiError } from '../../http/errors.js';
import { decimalToCents } from '../../paypal/index.js';
import {
  captureTopup,
  creditTopupTx,
  TOPUP_COLUMNS,
  type CreditActor,
  type TopupRow,
} from '../../topups/index.js';
import type { PayPalWebhookEvent, WebhookContext } from '../paypal.js';

/**
 * Top-up webhooks (SP-059; api.md §Webhooks, features/08 §Manual top-up 6). Every path ends in
 * SP-018a's idempotent code, so this handler, the capture endpoint, the return URL and SP-019's
 * poller can all see the same top-up and it is credited once (data-model rule 6):
 * - `CHECKOUT.ORDER.APPROVED` (the buyer approved, then closed the tab before our capture call) →
 *   `captureTopup` (`PayPal-Request-Id: capture:<topupId>`, which PayPal replays) and credit.
 * - `PAYMENT.CAPTURE.COMPLETED` → `creditTopupTx(custom_id)` in the event's transaction, with what
 *   the capture says (amount, currency, fee, order id are checked against the row).
 * - `PAYMENT.CAPTURE.DENIED` / `DECLINED` → FAILED (+ auto top-up off if AUTO). `VAULT_MIT`
 *   top-ups are left to SP-047a's `auto-topup.ts` (same event, same transaction).
 * An event for an order or capture that isn't one of our top-ups (the sandbox app is shared) is
 * ignored without an alert.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPEN = new Set(['CREATED', 'AWAITING_APPROVAL', 'ABANDONED']);

export type TopupWebhookResult =
  | 'UNMATCHED'
  | 'NOT_OPEN'
  | 'VAULT_MIT'
  | 'FAILED'
  | 'CREDITED'
  | 'ALREADY_CREDITED'
  | 'MISMATCH'
  | 'NOT_CREDITABLE'
  | 'COMPLETED'
  | 'PENDING'
  | 'NOT_CAPTURED'
  | `CAPTURE_REFUSED:${string}`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function actorOf(event: PayPalWebhookEvent): CreditActor {
  return { actorType: 'PAYPAL_WEBHOOK', actorId: event.id };
}

/** `capture.supplementary_data.related_ids.order_id`. */
function captureOrderId(resource: Json): string | null {
  return str(obj(obj(resource.supplementary_data).related_ids).order_id);
}

function cents(amount: unknown): number | null {
  const value = str(obj(amount).value);
  if (!value) return null;
  try {
    return decimalToCents(value);
  } catch {
    return null;
  }
}

/** Our top-up by id (a uuid `custom_id`), else by PayPal order id. `lock` → `FOR UPDATE`. */
async function findTopup(
  tx: Tx,
  customId: string | null,
  orderId: string | null,
  lock: boolean,
): Promise<TopupRow | null> {
  const forUpdate = lock ? ' FOR UPDATE' : '';
  if (customId && UUID.test(customId)) {
    const { rows } = await tx.query<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM topups WHERE id = $1${forUpdate}`,
      [customId],
    );
    if (rows[0]) return rows[0];
  }
  if (orderId) {
    const { rows } = await tx.query<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM topups WHERE paypal_order_id = $1${forUpdate}`,
      [orderId],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/** `CHECKOUT.ORDER.APPROVED`: the resource is the order. */
async function orderApproved(
  tx: Tx,
  event: PayPalWebhookEvent,
  ctx: WebhookContext,
): Promise<TopupWebhookResult> {
  const order = event.resource;
  const unit = obj(Array.isArray(order.purchase_units) ? order.purchase_units[0] : undefined);
  const topup = await findTopup(tx, str(unit.custom_id), str(order.id), false);
  if (!topup) return 'UNMATCHED';
  if (!OPEN.has(topup.status) || !topup.paypalOrderId) return 'NOT_OPEN';
  try {
    // PayPal call, then crediting in its own transaction (never under this event's lock on a
    // top-up row). If this event's transaction then rolls back, the retry replays the same
    // capture request id and finds the top-up already credited.
    const out = await captureTopup(
      { db: ctx.db, pp: ctx.pp, config: ctx.config },
      topup,
      actorOf(event),
    );
    return out.status;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    // PayPal unreachable / unclear: leave the event for the next tick (same request id).
    if (err.code === 'PAYPAL_ERROR') throw err;
    // Declined (now FAILED), not approved after all, or a capture we couldn't match (flagged).
    return `CAPTURE_REFUSED:${err.code}`;
  }
}

/** `PAYMENT.CAPTURE.COMPLETED`: the resource is the capture. */
async function captureCompleted(tx: Tx, event: PayPalWebhookEvent): Promise<TopupWebhookResult> {
  const capture = event.resource;
  const captureId = str(capture.id);
  if (!captureId || (str(capture.status) ?? 'COMPLETED') !== 'COMPLETED') return 'NOT_CAPTURED';
  const customId = str(capture.custom_id);
  const orderId = captureOrderId(capture);
  // Look up without a lock: `creditTopupTx` takes it, and does every check.
  const topup = await findTopup(tx, customId, orderId, false);
  if (!topup) return 'UNMATCHED';
  const amount = obj(capture.amount);
  const credit = await creditTopupTx(
    tx,
    topup.id,
    {
      captureId,
      amountCents: cents(amount),
      currency: str(amount.currency_code),
      feeCents: cents(obj(capture.seller_receivable_breakdown).paypal_fee),
      orderId,
      customId,
      vault: null,
    },
    actorOf(event),
  );
  return credit.result;
}

/** `PAYMENT.CAPTURE.DENIED` / `DECLINED` for a non-vault top-up. */
async function captureDenied(tx: Tx, event: PayPalWebhookEvent): Promise<TopupWebhookResult> {
  const capture = event.resource;
  const orderId = captureOrderId(capture);
  const topup = await findTopup(tx, str(capture.custom_id), orderId, true);
  if (!topup) return 'UNMATCHED';
  if (topup.method === 'VAULT_MIT') return 'VAULT_MIT'; // SP-047a's auto-topup.ts
  const code =
    event.event_type === 'PAYMENT.CAPTURE.DENIED' ? 'CAPTURE_DENIED' : 'CAPTURE_DECLINED';
  const failed = await transition(
    tx,
    'topups',
    topup.id,
    ['CREATED', 'AWAITING_APPROVAL'],
    'FAILED',
    {
      error_code: code,
      paypal_order_id: topup.paypalOrderId ?? orderId,
      updated_at: new Date(),
    },
  );
  if (!failed) return 'NOT_OPEN';
  const autoOff = topup.trigger === 'AUTO';
  if (autoOff) {
    await tx.query(
      `UPDATE buyers SET auto_topup_enabled = false, updated_at = now() WHERE id = $1`,
      [topup.buyerId],
    );
  }
  await audit(tx, {
    ...actorOf(event),
    entity: 'topups',
    entityId: topup.id,
    action: 'TOPUP_FAILED',
    paypalId: str(capture.id) ?? topup.paypalOrderId ?? orderId,
    data: {
      code,
      eventId: event.id,
      orderId: topup.paypalOrderId ?? orderId,
      captureId: str(capture.id),
      ...(autoOff ? { autoTopupDisabled: true } : {}),
    },
  });
  return 'FAILED';
}

const handler = {
  eventTypes: [
    'CHECKOUT.ORDER.APPROVED',
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.DECLINED',
  ] as const,

  handle(tx: Tx, event: PayPalWebhookEvent, ctx: WebhookContext): Promise<TopupWebhookResult> {
    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED':
        return orderApproved(tx, event, ctx);
      case 'PAYMENT.CAPTURE.COMPLETED':
        return captureCompleted(tx, event);
      default:
        return captureDenied(tx, event);
    }
  },
};

export default handler;
