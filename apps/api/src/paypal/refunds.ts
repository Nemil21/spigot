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
  type PayPalResponse,
  type PayPalTransport,
} from './transport.js';

/**
 * Refunds of unused buyer balance (api.md `pp.refundCapture`, `pp.getRefund`; SP-049).
 *
 * Sandbox facts (SP-003 S9): a partial refund is 201 `COMPLETED`; a replay with the same
 * `PayPal-Request-Id` is **200 with the same refund**, and PayPal ignores the replayed body (a
 * different amount still returns the original refund); a refund above what is left on the capture
 * is `422 REFUND_AMOUNT_EXCEEDED`. So insert `balance_refunds` first and always retry with its id.
 */

export type RefundStatus = 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED';

export interface RefundView {
  refundId: string;
  status: RefundStatus;
  amountCents: number | null;
  /** The refunded capture (its `rel=up` link), when PayPal says. */
  captureId: string | null;
  /** `status_details.reason` (e.g. `ECHECK`) for PENDING / FAILED refunds. */
  statusReason: string | null;
  /** True when PayPal answered 200 to a POST: this request id had already refunded. */
  replayed: boolean;
}

export interface RefundCaptureOptions {
  noteToPayer?: string;
}

/** Issues meaning "the capture hasn't that much left to refund". */
const EXCEEDED_ISSUES = new Set(['REFUND_AMOUNT_EXCEEDED', 'CAPTURE_FULLY_REFUNDED']);

/**
 * The refund was refused because it's more than the capture has left (`422
 * REFUND_AMOUNT_EXCEEDED`). TERMINAL: no refund happened, so post the `refund_reversal`, then
 * re-read the capture, because the slicing was wrong.
 */
export class PayPalRefundExceeded extends PayPalCallError {
  constructor(
    readonly captureId: string,
    readonly requestedCents: number,
    code: string,
    debugId?: string,
  ) {
    super('refund', 422, 'TERMINAL', code, debugId);
    this.name = 'PayPalRefundExceeded';
  }
}

const REFUND_STATUSES = new Set<RefundStatus>(['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED']);

function refundStatus(v: unknown): RefundStatus {
  // An unknown status is not final: treat it as PENDING so the sweep keeps polling.
  return REFUND_STATUSES.has(v as RefundStatus) ? (v as RefundStatus) : 'PENDING';
}

function captureIdFromLinks(links: unknown): string | null {
  const href = linkHref(links, 'up');
  const m = href ? /\/captures\/([^/?#]+)/.exec(href) : null;
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function readRefund(res: PayPalResponse, fallbackCaptureId: string | null): RefundView | null {
  const json = res.json;
  const refundId = str(json.id);
  if (!refundId) return null;
  return {
    refundId,
    status: refundStatus(json.status),
    amountCents: amountCents(json.amount),
    captureId: captureIdFromLinks(json.links) ?? fallbackCaptureId,
    statusReason: str(obj(json.status_details).reason),
    replayed: res.http === 200,
  };
}

/**
 * `POST /v2/payments/captures/{captureId}/refund` with `PayPal-Request-Id = refundId`
 * (`balance_refunds.id`). Returns the refund (COMPLETED or PENDING; poll PENDING with
 * `getRefund`). Throws `PayPalRefundExceeded` for an over-refund, `PayPalCallError` TRANSIENT
 * when PayPal didn't answer (retry with the **same** `refundId`), TERMINAL for other refusals.
 */
export async function refundCapture(
  http: PayPalTransport,
  captureId: string,
  amountCents: number,
  refundId: string,
  opts: RefundCaptureOptions = {},
): Promise<RefundView> {
  assertId(captureId, 'captureId');
  assertId(refundId, 'refundId');
  assertPositiveCents(amountCents, 'amountCents');
  const res = await http.request(
    'refund',
    'POST',
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    {
      requestId: refundId,
      body: {
        amount: { value: centsToDecimal(amountCents), currency_code: 'USD' },
        ...(opts.noteToPayer ? { note_to_payer: opts.noteToPayer } : {}),
      },
    },
  );
  if (is2xx(res)) {
    const view = readRefund(res, captureId);
    if (view) return view;
    // PayPal said yes but we can't read the refund id: GET it by request id later.
    throw new PayPalCallError('refund', res.http, 'RECONCILE', 'MALFORMED_RESPONSE', res.debugId);
  }
  if (res.http === 422 && res.issue && EXCEEDED_ISSUES.has(res.issue)) {
    throw new PayPalRefundExceeded(captureId, amountCents, res.issue, res.debugId);
  }
  throw callError('refund', res);
}

/** `GET /v2/payments/refunds/{refundId}` (PayPal's refund id): SP-049's PENDING poll. */
export async function getRefund(http: PayPalTransport, refundId: string): Promise<RefundView> {
  assertId(refundId, 'refundId');
  const res = await http.request(
    'get_refund',
    'GET',
    `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
  );
  if (is2xx(res)) {
    const view = readRefund(res, null);
    if (view) return { ...view, replayed: false };
    throw new PayPalCallError('get_refund', res.http, 'RECONCILE', 'MALFORMED_RESPONSE');
  }
  throw callError('get_refund', res);
}
