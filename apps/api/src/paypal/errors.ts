import type { MoneyOutCall } from './transport.js';

/**
 * PayPal failure classification (api.md §PayPal calls used; spikes/s7-results.md §RECONCILE
 * mapping). Every money ticket branches on these three classes, never on raw HTTP codes.
 */

/**
 * - `TRANSIENT`: no answer (network, timeout), 5xx, 429, 408. Retry with the **same**
 *   `PayPal-Request-Id`; PayPal replays the original result if the first try landed.
 * - `RECONCILE`: the money is in an unknown state. GET it and act on what PayPal says; never treat
 *   it as a decline. The caller marks the row `needs_reconcile` when the GET can't settle it.
 * - `TERMINAL`: a definite answer (decline, validation, bad config). Don't retry the same request.
 */
export type ErrorClass = 'TRANSIENT' | 'RECONCILE' | 'TERMINAL';

/**
 * The call a failed response came from; classification depends on it. Includes SP-001c's
 * `MoneyOutCall` names, so `PayPalHttp` is the `PayPalTransport` its modules call.
 */
export type PayPalCall = 'token' | 'order_create' | 'capture' | 'get' | MoneyOutCall;

/** What a failed response looked like. `http` is 0 when no response arrived (network, timeout). */
export interface FailureInfo {
  http: number;
  /** `details[0].issue`, else the top-level `name`, when the body had one. */
  issue?: string | undefined;
  timeout?: boolean | undefined;
  /** Order create only: the request carried raw card data (not replay-safe, S7 step 3). */
  rawCard?: boolean | undefined;
}

/** Issue codes the client acts on (Holdfast S7 + PayPal Orders v2 docs). */
export const ISSUE = {
  INSTRUMENT_DECLINED: 'INSTRUMENT_DECLINED',
  TRANSACTION_REFUSED: 'TRANSACTION_REFUSED',
  ORDER_ALREADY_CAPTURED: 'ORDER_ALREADY_CAPTURED',
  ORDER_NOT_APPROVED: 'ORDER_NOT_APPROVED',
  PAYER_ACTION_REQUIRED: 'PAYER_ACTION_REQUIRED',
  DUPLICATE_INVOICE_ID: 'DUPLICATE_INVOICE_ID',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
} as const;

/**
 * Classify a non-2xx answer **by status first** (S7: a mocked `INSTRUMENT_DECLINED` capture came
 * back as 403 with an empty body, so the issue code can't be relied on):
 * - no answer / 5xx / 429 / 408 → TRANSIENT;
 * - any 422 on capture → RECONCILE (already captured with another id, not approved yet, …: GET the
 *   order to find out), except an explicit `INSTRUMENT_DECLINED`;
 * - order create: `DUPLICATE_INVOICE_ID`, and `TRANSACTION_REFUSED` on a raw-card source → RECONCILE
 *   (S7 step 3: a raw-card create replayed with the same request id is refused; that is not a
 *   decline). A refused `vault_id` charge is a real decline (TERMINAL);
 * - everything else (403 decline, 400 validation, 401 credentials, 404) → TERMINAL.
 */
export function classifyFailure(call: PayPalCall, info: FailureInfo): ErrorClass {
  const { http, issue } = info;
  if (info.timeout || http === 0 || http >= 500 || http === 429 || http === 408) return 'TRANSIENT';
  if (call === 'capture' && http === 422 && issue !== ISSUE.INSTRUMENT_DECLINED) return 'RECONCILE';
  if (call === 'order_create' && issue === ISSUE.DUPLICATE_INVOICE_ID) return 'RECONCILE';
  if (call === 'order_create' && issue === ISSUE.TRANSACTION_REFUSED && info.rawCard) {
    return 'RECONCILE';
  }
  return 'TERMINAL';
}

/**
 * A typed PayPal failure. Reads (`getOrder`) throw it; mutating calls return a result object with
 * the same `errorClass` / `code` instead, so callers can't forget to handle a decline.
 */
export class PayPalApiError extends Error {
  constructor(
    readonly call: PayPalCall,
    readonly http: number,
    readonly errorClass: ErrorClass,
    readonly code: string,
    readonly debugId?: string | undefined,
  ) {
    super(`PayPal ${call} failed: ${http || 'no response'} ${code}`);
    this.name = 'PayPalApiError';
  }
}

/** Bad credentials or a refused token call: configuration, not a payment outcome. */
export class PayPalAuthError extends PayPalApiError {
  constructor(http: number, code: string, debugId?: string) {
    super('token', http, 'TERMINAL', code, debugId);
    this.name = 'PayPalAuthError';
  }
}
