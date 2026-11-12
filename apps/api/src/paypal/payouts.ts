import type { PayoutItemStatus } from '@spigot/shared';
import {
  amountCents,
  assertId,
  assertPositiveCents,
  callError,
  centsToDecimal,
  is2xx,
  linkHref,
  obj,
  PayPalCallError,
  str,
  type Json,
  type PayPalResponse,
  type PayPalTransport,
} from './transport.js';

/**
 * Publisher payouts (api.md `pp.payout`, `pp.getPayoutBatch`; SP-020, SP-021).
 *
 * Sandbox facts:
 * - S10 (SP-003): POST → 201 `PENDING` → `PROCESSING` → `SUCCESS` in ≈ 33 s. An item to an
 *   unregistered email is `UNCLAIMED` (`errors.name: RECEIVER_UNREGISTERED`) while the batch is
 *   still `SUCCESS`. $0.25 `payout_item_fee` per item. Re-submitting a `sender_batch_id` is
 *   **400 `USER_BUSINESS_ERROR`** ("Batch with given sender_batch_id already exists") with no
 *   `payout_batch_id`, both straight away with the same `PayPal-Request-Id` and later with a new
 *   one: PayPal never replays a payout.
 * - Holdfast S7: above the available balance → `422 INSUFFICIENT_FUNDS`, no batch created. Paying
 *   the merchant's own account → batch `DENIED`, item `FAILED` `SELF_PAY_NOT_ALLOWED`.
 */

export interface PayoutItemInput {
  /** `payout_items.id`: sent as `sender_item_id`. */
  itemId: string;
  /** Receiver email (snapshot of the publisher's `payout_email`). */
  email: string;
  amountCents: number;
  /** e.g. "Spigot: 8,112 records sold, Nov 4–11". */
  note: string;
}

export interface PayoutInput {
  /** `payout_batches.id`: sent as `sender_batch_id` and as `PayPal-Request-Id`. */
  batchId: string;
  items: PayoutItemInput[];
  /** Default "Your Spigot earnings". */
  emailSubject?: string;
  emailMessage?: string;
}

/** PayPal accepted the batch (201). Items are PENDING until polled. */
export interface PayoutAccepted {
  payoutBatchId: string;
  senderBatchId: string;
  batchStatus: string;
}

export interface PayoutItemView {
  payoutItemId: string;
  /** Our `payout_items.id`. */
  senderItemId: string | null;
  payoutBatchId: string | null;
  /** Normalised for the payout item state machine (data-model.md). */
  status: PayoutItemStatus;
  /** PayPal's `transaction_status` as sent. */
  paypalStatus: string;
  /** `errors.name`, e.g. `RECEIVER_UNREGISTERED`, `SELF_PAY_NOT_ALLOWED`. */
  errorCode: string | null;
  receiver: string | null;
  amountCents: number | null;
  /** `payout_item_fee` → `payout_items.fee_cents`. */
  feeCents: number | null;
}

export interface PayoutBatchView {
  payoutBatchId: string;
  senderBatchId: string | null;
  /** `PENDING`, `PROCESSING`, `SUCCESS`, `DENIED`, `CANCELED`, … as PayPal sends it. */
  batchStatus: string;
  amountCents: number | null;
  feesCents: number | null;
  items: PayoutItemView[];
}

/**
 * `422 INSUFFICIENT_FUNDS` at POST: PayPal created **no batch**. A definite answer (SP-020: return
 * the items to payable, batch FAILED, alert, next run builds a new batch).
 */
export class PayPalInsufficientFunds extends PayPalCallError {
  constructor(
    readonly senderBatchId: string,
    debugId?: string,
  ) {
    super('payout', 422, 'TERMINAL', 'INSUFFICIENT_FUNDS', debugId);
    this.name = 'PayPalInsufficientFunds';
  }
}

/**
 * The `sender_batch_id` was already used: the batch **exists** at PayPal. RECONCILE. Carries
 * whatever PayPal returned: in S10 that was no `payout_batch_id` at all, so SP-020 sets
 * `needs_reconcile` when `payoutBatchId` is null.
 */
export class PayPalDuplicateBatch extends PayPalCallError {
  constructor(
    readonly senderBatchId: string,
    readonly payoutBatchId: string | null,
    http: number,
    code: string,
    debugId?: string,
  ) {
    super('payout', http, 'RECONCILE', code, debugId);
    this.name = 'PayPalDuplicateBatch';
  }
}

/** PayPal item `transaction_status` → our payout item status. */
const ITEM_STATUS: Record<string, PayoutItemStatus> = {
  SUCCESS: 'SUCCESS',
  UNCLAIMED: 'UNCLAIMED',
  RETURNED: 'RETURNED',
  FAILED: 'FAILED',
  BLOCKED: 'FAILED',
  DENIED: 'FAILED',
  REFUNDED: 'FAILED',
  REVERSED: 'FAILED',
  CANCELED: 'FAILED',
  CANCELLED: 'FAILED',
};

/** `PENDING`, `ONHOLD`, `NEW` and anything unknown stay PENDING (in flight; keep polling). */
export function normalisePayoutItemStatus(paypalStatus: string): PayoutItemStatus {
  return ITEM_STATUS[paypalStatus.toUpperCase()] ?? 'PENDING';
}

/** Payouts amounts use `currency`, not Orders' `currency_code`. */
export function payoutAmount(cents: number): { value: string; currency: 'USD' } {
  return { value: centsToDecimal(cents), currency: 'USD' };
}

const DUPLICATE_TEXT = /sender_batch_id/i;
const DUPLICATE_WORDS = /already|duplicate|used/i;

/** Every string an error body carries that might say "duplicate sender_batch_id". */
function errorTexts(json: Json): string[] {
  const texts = [json.name, json.message];
  if (Array.isArray(json.details)) {
    for (const d of json.details) texts.push(obj(d).issue, obj(d).description, obj(d).field);
  }
  return texts.filter((t): t is string => typeof t === 'string');
}

function isDuplicateBatch(res: PayPalResponse): boolean {
  if (res.http < 400 || res.http >= 500) return false;
  const texts = errorTexts(res.json);
  if (texts.includes('DUPLICATE_SENDER_BATCH_ID')) return true;
  return texts.some((t) => DUPLICATE_TEXT.test(t)) && texts.some((t) => DUPLICATE_WORDS.test(t));
}

/** A `payout_batch_id` anywhere PayPal might put one (S10's duplicate error had none). */
function batchIdIn(json: Json): string | null {
  const fromHeader = str(obj(json.batch_header).payout_batch_id) ?? str(json.payout_batch_id);
  if (fromHeader) return fromHeader;
  const href = linkHref(json.links, 'self') ?? linkHref(json.links, 'batch');
  const m = href ? /\/payouts\/([^/?#]+)/.exec(href) : null;
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function validate(input: PayoutInput): void {
  assertId(input.batchId, 'batchId');
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new RangeError('a payout needs at least one item');
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    assertId(item.itemId, 'itemId');
    assertId(item.email, 'email');
    assertPositiveCents(item.amountCents, 'amountCents');
    if (seen.has(item.itemId)) throw new RangeError(`duplicate itemId ${item.itemId}`);
    seen.add(item.itemId);
  }
}

/**
 * `POST /v1/payments/payouts`: one batch, one EMAIL item per publisher; `sender_batch_id` =
 * `PayPal-Request-Id` = `batchId`.
 *
 * Throws:
 * - `PayPalInsufficientFunds`: 422, no batch created.
 * - `PayPalDuplicateBatch`: the batch already exists (a retry after a lost response). Never a
 *   second payout.
 * - `PayPalCallError` TRANSIENT: no answer, 5xx, 429. Retry with the **same** `batchId`.
 * - `PayPalCallError` TERMINAL: any other refusal (validation).
 * - `PayPalCallError` RECONCILE: a 2xx we couldn't read a batch id from.
 */
export async function payout(http: PayPalTransport, input: PayoutInput): Promise<PayoutAccepted> {
  validate(input);
  const res = await http.request('payout', 'POST', '/v1/payments/payouts', {
    requestId: input.batchId,
    body: {
      sender_batch_header: {
        sender_batch_id: input.batchId,
        email_subject: input.emailSubject ?? 'Your Spigot earnings',
        ...(input.emailMessage ? { email_message: input.emailMessage } : {}),
      },
      items: input.items.map((item) => ({
        recipient_type: 'EMAIL',
        receiver: item.email,
        amount: payoutAmount(item.amountCents),
        note: item.note,
        sender_item_id: item.itemId,
      })),
    },
  });
  if (is2xx(res)) {
    const header = obj(res.json.batch_header);
    const payoutBatchId = str(header.payout_batch_id);
    if (payoutBatchId) {
      return {
        payoutBatchId,
        senderBatchId: str(obj(header.sender_batch_header).sender_batch_id) ?? input.batchId,
        batchStatus: str(header.batch_status) ?? 'PENDING',
      };
    }
    throw new PayPalCallError('payout', res.http, 'RECONCILE', 'MALFORMED_RESPONSE', res.debugId);
  }
  if (res.http === 422 && errorTexts(res.json).includes('INSUFFICIENT_FUNDS')) {
    throw new PayPalInsufficientFunds(input.batchId, res.debugId);
  }
  if (isDuplicateBatch(res)) {
    throw new PayPalDuplicateBatch(
      input.batchId,
      batchIdIn(res.json),
      res.http,
      str(res.json.name) ?? 'DUPLICATE_SENDER_BATCH_ID',
      res.debugId,
    );
  }
  throw callError('payout', res);
}

function readItem(raw: unknown): PayoutItemView {
  const i = obj(raw);
  const paypalStatus = str(i.transaction_status) ?? 'PENDING';
  const payoutItem = obj(i.payout_item);
  return {
    payoutItemId: str(i.payout_item_id) ?? '',
    senderItemId: str(payoutItem.sender_item_id) ?? str(i.sender_item_id),
    payoutBatchId: str(i.payout_batch_id),
    status: normalisePayoutItemStatus(paypalStatus),
    paypalStatus,
    errorCode: str(obj(i.errors).name),
    receiver: str(payoutItem.receiver),
    amountCents: amountCents(payoutItem.amount),
    feeCents: amountCents(i.payout_item_fee),
  };
}

async function getJson(http: PayPalTransport, path: string): Promise<Json> {
  const res = await http.request('get_payout', 'GET', path);
  if (is2xx(res)) return res.json;
  throw callError('get_payout', res);
}

/** `GET /v1/payments/payouts/{payout_batch_id}`: batch status, totals and every item. */
export async function getPayoutBatch(
  http: PayPalTransport,
  payoutBatchId: string,
): Promise<PayoutBatchView> {
  assertId(payoutBatchId, 'payoutBatchId');
  const json = await getJson(http, `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
  const header = obj(json.batch_header);
  return {
    payoutBatchId: str(header.payout_batch_id) ?? payoutBatchId,
    senderBatchId: str(obj(header.sender_batch_header).sender_batch_id),
    batchStatus: str(header.batch_status) ?? 'PENDING',
    amountCents: amountCents(header.amount),
    feesCents: amountCents(header.fees),
    items: Array.isArray(json.items) ? json.items.map(readItem) : [],
  };
}

/** `GET /v1/payments/payouts-item/{payout_item_id}`. */
export async function getPayoutItem(
  http: PayPalTransport,
  payoutItemId: string,
): Promise<PayoutItemView> {
  assertId(payoutItemId, 'payoutItemId');
  return readItem(
    await getJson(http, `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`),
  );
}
