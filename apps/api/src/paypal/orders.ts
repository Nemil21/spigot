import type { PayPalHttp, PayPalResponse } from './client.js';
import { classifyFailure, ISSUE, PayPalApiError, type PayPalCall } from './errors.js';
import { assertCents, decimalToCents, paypalAmount } from './money.js';
import type {
  CaptureOrderOptions,
  CaptureView,
  CreateTopupOrderInput,
  MockResponseCode,
  OrderView,
  TopupResult,
  TopupSource,
  VaultRef,
} from './types.js';

export interface OrderSettings {
  allowRawCard: boolean;
  allowMockResponse: boolean;
  /** Extra tries with the same request id while PayPal doesn't answer. */
  retries: number;
  retryDelayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
}

/** What shows on the buyer's PayPal / card statement line for the order. */
export const TOPUP_DESCRIPTION = 'Spigot balance top-up';

/** `PayPal-Request-Id` for capturing a top-up's order (data-model.md §Locking rule 5). */
export function captureRequestId(topupId: string): string {
  return `capture:${nonEmpty(topupId, 'topupId')}`;
}

function nonEmpty(id: string, what: string): string {
  if (typeof id !== 'string' || id.trim() === '') throw new TypeError(`${what} is required`);
  return id;
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function cents(amount: unknown): number | null {
  const value = obj(amount).value;
  if (typeof value !== 'string') return null;
  try {
    return decimalToCents(value);
  } catch {
    return null;
  }
}

const is2xx = (res: PayPalResponse) => res.http >= 200 && res.http < 300;
const codeOf = (res: PayPalResponse) => res.issue ?? (res.http ? `HTTP_${res.http}` : 'NETWORK');

// ---------------------------------------------------------------------------------------------
// Body readers

export function readCapture(raw: unknown): CaptureView {
  const c = obj(raw);
  const breakdown = obj(c.seller_receivable_breakdown);
  return {
    id: str(c.id) ?? '',
    status: str(c.status) ?? 'UNKNOWN',
    amountCents: cents(c.amount),
    feeCents: cents(breakdown.paypal_fee),
    netCents: cents(breakdown.net_amount),
    reason: str(obj(c.status_details).reason),
    customId: str(c.custom_id),
  };
}

/** A vault PayPal says is `VAULTED` (`payment_source.card|paypal.attributes.vault`). */
export function vaultOf(order: unknown): VaultRef | null {
  const ps = obj(obj(order).payment_source);
  for (const kind of ['card', 'paypal'] as const) {
    const vault = obj(obj(obj(ps[kind]).attributes).vault);
    const id = str(vault.id);
    if (id && str(vault.status) === 'VAULTED') {
      return { id, kind, customerId: str(obj(vault.customer).id) };
    }
  }
  return null;
}

/** The buyer approval link: `rel=payer-action` (with a payment_source) or `rel=approve`. */
function approveUrlOf(order: Json): string | null {
  const links = arr(order.links).map(obj);
  const link =
    links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve');
  return link ? str(link.href) : null;
}

export function readOrder(raw: unknown): OrderView {
  const o = obj(raw);
  const unit = obj(arr(o.purchase_units)[0]);
  return {
    id: str(o.id) ?? '',
    status: str(o.status) ?? 'UNKNOWN',
    intent: str(o.intent),
    amountCents: cents(unit.amount),
    customId: str(unit.custom_id),
    approveUrl: approveUrlOf(o),
    captures: arr(obj(unit.payments).captures).map(readCapture),
    vault: vaultOf(o),
  };
}

/** Order statuses before a capture exists: the buyer still has to approve (or just did). */
const AWAITING = new Set(['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED']);
/** Capture statuses that mean the money was taken (later refunds don't undo the top-up event). */
const CAPTURED = new Set(['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

/**
 * Normalise an order (from create, capture or GET) into a `TopupResult`, judged by the capture's
 * status in the body. A COMPLETED capture wins over a PENDING one, which wins over a failed one.
 */
export function topupResultOf(order: OrderView, reconciled = false): TopupResult {
  if (!order.id) {
    return {
      status: 'NEEDS_RECONCILE',
      orderId: null,
      code: 'MALFORMED_RESPONSE',
      http: 0,
      errorClass: 'RECONCILE',
    };
  }
  const capture =
    order.captures.find((c) => CAPTURED.has(c.status)) ??
    order.captures.find((c) => c.status === 'PENDING') ??
    order.captures[0];
  const customId = capture?.customId ?? order.customId;
  if (capture?.id && CAPTURED.has(capture.status)) {
    return {
      status: 'COMPLETED',
      orderId: order.id,
      captureId: capture.id,
      amountCents: capture.amountCents,
      feeCents: capture.feeCents,
      vault: order.vault,
      customId,
      reconciled,
    };
  }
  if (capture?.id && capture.status === 'PENDING') {
    return {
      status: 'PENDING',
      orderId: order.id,
      captureId: capture.id,
      amountCents: capture.amountCents,
      reason: capture.reason,
      vault: order.vault,
      customId,
    };
  }
  if (capture) {
    return {
      status: 'DECLINED',
      orderId: order.id,
      captureId: capture.id || null,
      code: capture.reason ?? `CAPTURE_${capture.status}`,
      http: 0,
      errorClass: 'TERMINAL',
    };
  }
  if (AWAITING.has(order.status)) {
    return {
      status: 'AWAITING_APPROVAL',
      orderId: order.id,
      approveUrl: order.approveUrl,
      orderStatus: order.status,
    };
  }
  if (order.status === 'VOIDED') {
    return {
      status: 'DECLINED',
      orderId: order.id,
      captureId: null,
      code: 'ORDER_VOIDED',
      http: 0,
      errorClass: 'TERMINAL',
    };
  }
  return {
    status: 'NEEDS_RECONCILE',
    orderId: order.id,
    code: `ORDER_${order.status}`,
    http: 0,
    errorClass: 'RECONCILE',
  };
}

// ---------------------------------------------------------------------------------------------
// Request bodies

const MIT = {
  payment_initiator: 'MERCHANT',
  payment_type: 'UNSCHEDULED',
  usage: 'SUBSEQUENT',
} as const;

/** The `payment_source` for a top-up, or `undefined` for `none`. */
export function paymentSourceBody(source: TopupSource): Json | undefined {
  switch (source.kind) {
    case 'wallet':
      return {
        paypal: {
          ...(source.vault
            ? {
                attributes: {
                  vault: {
                    store_in_vault: 'ON_SUCCESS',
                    usage_type: 'MERCHANT',
                    customer_type: 'CONSUMER',
                  },
                },
              }
            : {}),
          experience_context: {
            return_url: source.returnUrl,
            cancel_url: source.cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            ...(source.brandName ? { brand_name: source.brandName } : {}),
          },
        },
      };
    case 'none':
      return undefined;
    case 'card':
      return {
        card: {
          ...source.card,
          ...(source.vault === false
            ? {}
            : { attributes: { vault: { store_in_vault: 'ON_SUCCESS' } } }),
        },
      };
    case 'card_vault':
      return { card: { vault_id: source.vaultId, stored_credential: MIT } };
    case 'wallet_vault':
      return { paypal: { vault_id: source.vaultId } };
  }
}

function mockHeaders(
  settings: OrderSettings,
  mock: MockResponseCode | null | undefined,
): Record<string, string> {
  if (!mock || !settings.allowMockResponse) return {};
  return { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: mock }) };
}

/** Retry with the same request id while PayPal doesn't answer (PayPal replays a landed call). */
async function withRetries(
  settings: OrderSettings,
  call: PayPalCall,
  send: () => Promise<PayPalResponse>,
): Promise<PayPalResponse> {
  let res = await send();
  for (let attempt = 1; attempt <= settings.retries; attempt++) {
    if (is2xx(res) || classifyFailure(call, res) !== 'TRANSIENT') return res;
    await settings.sleep(settings.retryDelayMs(attempt));
    res = await send();
  }
  return res;
}

function assertAmount(amountCents: number): void {
  assertCents(amountCents);
  if (amountCents <= 0) throw new RangeError('amountCents must be positive');
}

// ---------------------------------------------------------------------------------------------
// Calls

/**
 * `POST /v2/checkout/orders` `intent: CAPTURE` with `PayPal-Request-Id = custom_id = topupId`.
 * Card and vault sources capture at create (→ COMPLETED / PENDING / DECLINED); wallet and `none`
 * come back AWAITING_APPROVAL.
 *
 * S7 step 3: a `vault_id` or no-source create replayed with the same id returns the same order
 * (200); a raw-card replay is refused with 422 `TRANSACTION_REFUSED`, which is NEEDS_RECONCILE
 * (RECONCILE), never DECLINED: our `topups` row is the dedupe.
 */
export async function createTopupOrder(
  http: PayPalHttp,
  settings: OrderSettings,
  input: CreateTopupOrderInput,
): Promise<TopupResult> {
  const topupId = nonEmpty(input.topupId, 'topupId');
  assertAmount(input.amountCents);
  const rawCard = input.source.kind === 'card';
  if (rawCard && !settings.allowRawCard) {
    throw new Error('raw card sources are allowed only for SIM top-ups on the sandbox or the fake');
  }
  const paymentSource = paymentSourceBody(input.source);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        custom_id: topupId,
        description: TOPUP_DESCRIPTION,
        amount: paypalAmount(input.amountCents),
      },
    ],
    ...(paymentSource ? { payment_source: paymentSource } : {}),
  };
  const headers = mockHeaders(settings, input.mockResponse);
  const res = await withRetries(settings, 'order_create', () =>
    http.request('order_create', 'POST', '/v2/checkout/orders', {
      body,
      requestId: topupId,
      headers,
    }),
  );
  if (is2xx(res)) return topupResultOf(readOrder(res.json));
  const errorClass = classifyFailure('order_create', { ...res, rawCard });
  if (errorClass !== 'TERMINAL') {
    return {
      status: 'NEEDS_RECONCILE',
      orderId: null,
      code: codeOf(res),
      http: res.http,
      errorClass,
    };
  }
  return {
    status: 'DECLINED',
    orderId: null,
    captureId: null,
    code: codeOf(res),
    http: res.http,
    errorClass: 'TERMINAL',
  };
}

/**
 * `POST /v2/checkout/orders/{id}/capture` (no body) with `PayPal-Request-Id: capture:<topupId>`.
 * A same-id replay returns the original capture. Any other 4xx (except 401) is settled by GETting
 * the order (S7 §RECONCILE mapping): captured → COMPLETED `reconciled` with the original capture id
 * · not approved → AWAITING_APPROVAL · otherwise DECLINED. A mocked decline (403, empty body) is
 * DECLINED once the GET shows no capture.
 */
export async function captureOrder(
  http: PayPalHttp,
  settings: OrderSettings,
  orderId: string,
  topupId: string,
  opts: CaptureOrderOptions = {},
): Promise<TopupResult> {
  nonEmpty(orderId, 'orderId');
  const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`;
  const requestId = captureRequestId(topupId);
  const headers = mockHeaders(settings, opts.mockResponse);
  const res = await withRetries(settings, 'capture', () =>
    http.request('capture', 'POST', path, { requestId, headers }),
  );
  if (is2xx(res)) return topupResultOf(readOrder(res.json));

  const errorClass = classifyFailure('capture', res);
  const code = codeOf(res);
  if (errorClass === 'TRANSIENT') {
    return { status: 'NEEDS_RECONCILE', orderId, code, http: res.http, errorClass };
  }
  const declined = {
    status: 'DECLINED' as const,
    orderId,
    captureId: null,
    code,
    http: res.http,
    errorClass: 'TERMINAL' as const,
  };
  if (res.http === 401) return { ...declined, code: 'AUTHENTICATION_FAILURE' };

  let order: OrderView;
  try {
    order = await getOrder(http, orderId);
  } catch (err) {
    const getClass = err instanceof PayPalApiError ? err.errorClass : 'TRANSIENT';
    // The order can't be found at all: the capture can't have happened.
    if (getClass === 'TERMINAL') return declined;
    // The capture may have landed; we can't see it. Never call that a decline.
    return {
      status: 'NEEDS_RECONCILE',
      orderId,
      code,
      http: res.http,
      errorClass: getClass === 'TRANSIENT' ? 'TRANSIENT' : 'RECONCILE',
    };
  }
  const found = topupResultOf(order, true);
  if (found.status === 'COMPLETED' || found.status === 'PENDING') return found;
  if (
    found.status === 'AWAITING_APPROVAL' &&
    errorClass === 'RECONCILE' &&
    (res.issue === ISSUE.ORDER_NOT_APPROVED ||
      res.issue === ISSUE.PAYER_ACTION_REQUIRED ||
      order.status !== 'APPROVED')
  ) {
    return found;
  }
  if (found.status === 'DECLINED') return { ...found, http: res.http };
  return declined;
}

/** `GET /v2/checkout/orders/{id}`: return-URL handler and poller fallback. */
export async function getOrder(http: PayPalHttp, orderId: string): Promise<OrderView> {
  const res = await http.request(
    'get',
    'GET',
    `/v2/checkout/orders/${encodeURIComponent(nonEmpty(orderId, 'orderId'))}`,
  );
  if (is2xx(res)) return readOrder(res.json);
  throw new PayPalApiError('get', res.http, classifyFailure('get', res), codeOf(res), res.debugId);
}
