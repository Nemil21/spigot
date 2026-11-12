/**
 * What the SP-001c calls (refunds, payouts, webhook verify) need from the PayPal transport.
 *
 * This is the structural subset of SP-001b's `PayPalHttp.request` (Holdfast's client): token cache,
 * `PayPal-Request-Id`, `Prefer: return=representation`, timeouts, and network failures returned as
 * `http: 0` rather than thrown. The functions in `refunds.ts`, `payouts.ts` and `webhooks.ts` take
 * one as their first argument, so SP-001b's client and the fake's transport both fit.
 */

/** TRANSIENT: retry with the same request id. RECONCILE: state unknown, GET it. TERMINAL: final. */
export type PayPalErrorClass = 'TRANSIENT' | 'TERMINAL' | 'RECONCILE';

/** The SP-001c calls, as named in logs and errors. */
export type MoneyOutCall = 'refund' | 'get_refund' | 'payout' | 'get_payout' | 'verify_webhook';

export interface PayPalRequestOptions {
  body?: unknown;
  /**
   * Send this exact string as the request body instead of `JSON.stringify(body)`. Webhook verify
   * needs it: the event must reach PayPal byte for byte as it was delivered.
   */
  rawBody?: string;
  /** Sent as `PayPal-Request-Id`. */
  requestId?: string;
  headers?: Record<string, string>;
}

/** A PayPal answer. `http` is 0 when no answer arrived (`timeout` says whether it timed out). */
export interface PayPalResponse {
  http: number;
  json: Record<string, unknown>;
  debugId?: string | undefined;
  /** `details[0].issue`, else the error `name`. */
  issue?: string | undefined;
  timeout?: boolean | undefined;
}

export interface PayPalTransport {
  request(
    call: MoneyOutCall,
    method: 'GET' | 'POST',
    path: string,
    opts?: PayPalRequestOptions,
  ): Promise<PayPalResponse>;
}

/**
 * A PayPal call that didn't succeed. Same fields as SP-001b's `PayPalApiError`. Subclasses
 * (`PayPalInsufficientFunds`, `PayPalDuplicateBatch`, `PayPalRefundExceeded`) name the outcomes
 * callers act on.
 */
export class PayPalCallError extends Error {
  constructor(
    readonly call: MoneyOutCall,
    readonly http: number,
    readonly errorClass: PayPalErrorClass,
    readonly code: string,
    readonly debugId?: string | undefined,
  ) {
    super(`PayPal ${call} failed: ${http || 'no response'} ${code}`);
    this.name = 'PayPalCallError';
  }
}

/** No answer, timeout, 5xx, 429 or 408 → TRANSIENT; everything else is a definite answer. */
export function isTransient(res: Pick<PayPalResponse, 'http' | 'timeout'>): boolean {
  const { http } = res;
  return !!res.timeout || http === 0 || http >= 500 || http === 429 || http === 408;
}

export const is2xx = (res: PayPalResponse): boolean => res.http >= 200 && res.http < 300;

export const codeOf = (res: PayPalResponse): string =>
  res.issue ?? (res.http ? `HTTP_${res.http}` : res.timeout ? 'TIMEOUT' : 'NETWORK');

/** A generic failure: TRANSIENT when PayPal didn't answer, TERMINAL otherwise. */
export function callError(call: MoneyOutCall, res: PayPalResponse): PayPalCallError {
  return new PayPalCallError(
    call,
    res.http,
    isTransient(res) ? 'TRANSIENT' : 'TERMINAL',
    codeOf(res),
    res.debugId,
  );
}

// ---------------------------------------------------------------- defensive readers

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** `{value: "7.40"}` → 740; null when missing or malformed. */
export function amountCents(amount: unknown): number | null {
  const value = obj(amount).value;
  if (typeof value !== 'string') return null;
  try {
    return decimalToCents(value);
  } catch {
    return null;
  }
}

/** `"7.40"` → 740. Throws on anything that isn't a non-negative amount with ≤ 2 decimals. */
export function decimalToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new RangeError(`not a PayPal amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** 740 → `"7.40"`. */
export function centsToDecimal(cents: number): string {
  assertPositiveCents(cents, 'amountCents', true);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function assertPositiveCents(cents: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(cents) || cents < 0 || (!allowZero && cents === 0)) {
    throw new RangeError(`${name} must be a positive integer number of cents, got ${cents}`);
  }
}

export function assertId(id: string, name: string): void {
  if (typeof id !== 'string' || id.trim() === '') throw new TypeError(`${name} is required`);
}

/** The `href` of the link with this `rel`, if any. */
export function linkHref(links: unknown, rel: string): string | null {
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    if (obj(l).rel === rel) return str(obj(l).href);
  }
  return null;
}
