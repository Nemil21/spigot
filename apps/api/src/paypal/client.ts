import { isSandboxPayPalBase } from '../config.js';
import { classifyFailure, PayPalApiError, PayPalAuthError, type PayPalCall } from './errors.js';
import { moneyOut, type MoneyOutClient } from './moneyOut.js';
import * as orders from './orders.js';
import type { CaptureOrderOptions, CreateTopupOrderInput, PayPalOrdersClient } from './types.js';

/** One line per PayPal call. Never carries tokens, secrets, headers or bodies (they can echo PII). */
export interface PayPalLogEntry {
  call: PayPalCall;
  method: string;
  path: string;
  http: number;
  ms: number;
  requestId?: string | undefined;
  debugId?: string | undefined;
  issue?: string | undefined;
  /** 1 on the first try; 2 after a 401 token refresh. */
  attempt: number;
  error?: string | undefined;
}

export type PayPalLogger = (entry: PayPalLogEntry) => void;

export interface PayPalHttpOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for tests and `FakePayPal`. Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Clock for the token cache. Default `Date.now`. */
  now?: () => number;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  logger?: PayPalLogger;
}

/** A PayPal answer. `http` is 0 when no answer arrived (`timeout` says whether it timed out). */
export interface PayPalResponse {
  http: number;
  // Bodies are parsed defensively by the readers in orders.ts.
  json: Record<string, unknown>;
  debugId?: string | undefined;
  issue?: string | undefined;
  timeout?: boolean;
}

export interface RequestOptions {
  body?: unknown;
  /** Send this exact text instead of `JSON.stringify(body)` (webhook verify: byte-for-byte). */
  rawBody?: string;
  /** `PayPal-Request-Id`. Every mutating call sends one (data-model.md §Locking rule 5). */
  requestId?: string;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Refresh the token this long before PayPal says it expires. */
const TOKEN_SKEW_MS = 60_000;

/** Scrub anything that looks like a credential from a string before it can reach a log. */
export function redact(text: string): string {
  return text
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(
      /("?(?:access_token|client_secret|refresh_token)"?\s*[:=]\s*"?)[^"&\s,}]+/gi,
      '$1[redacted]',
    );
}

/** `details[0].issue`, else the error `name`, from a PayPal error body. */
export function issueOf(json: Record<string, unknown>): string | undefined {
  const details = json.details;
  if (Array.isArray(details)) {
    const issue = (details[0] as { issue?: unknown } | undefined)?.issue;
    if (typeof issue === 'string') return issue;
  }
  return typeof json.name === 'string' ? json.name : undefined;
}

/**
 * Low-level PayPal REST transport. The client secret is used only to mint the OAuth token here and
 * never leaves this object (no getters, never logged). SP-001c's refunds / payouts / webhooks
 * modules call `request()` on the same instance.
 */
export class PayPalHttp {
  readonly baseUrl: string;
  readonly #basic: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #log: PayPalLogger | undefined;
  #token: { value: string; expiresAt: number } | null = null;
  #pending: Promise<string> | null = null;

  constructor(opts: PayPalHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64');
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = opts.now ?? Date.now;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#log = opts.logger;
  }

  /** Cached OAuth token, valid until `expires_in − 60 s`. Concurrent callers share one fetch. */
  async token(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt) return this.#token.value;
    this.#pending ??= this.#fetchToken().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  /** Drop the cached token if it is still `value` (a 401 means PayPal no longer accepts it). */
  invalidate(value: string): void {
    if (this.#token?.value === value) this.#token = null;
  }

  async #fetchToken(): Promise<string> {
    const started = this.#now();
    const path = '/v1/oauth2/token';
    let res: Response;
    let json: Record<string, unknown>;
    try {
      res = await this.#fetch(this.baseUrl + path, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.#basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      json = await readJson(res);
    } catch (err) {
      const timeout = isTimeout(err);
      this.#emit({
        call: 'token',
        method: 'POST',
        path,
        http: 0,
        ms: this.#now() - started,
        attempt: 1,
        error: errorText(err),
      });
      throw new PayPalApiError('token', 0, 'TRANSIENT', timeout ? 'TIMEOUT' : 'NETWORK');
    }
    const debugId = res.headers.get('paypal-debug-id') ?? undefined;
    this.#emit({
      call: 'token',
      method: 'POST',
      path,
      http: res.status,
      ms: this.#now() - started,
      attempt: 1,
      debugId,
    });
    const value = json.access_token;
    if (!res.ok || typeof value !== 'string') {
      const code = typeof json.error === 'string' ? json.error : `HTTP_${res.status}`;
      if (classifyFailure('token', { http: res.status }) === 'TRANSIENT') {
        throw new PayPalApiError('token', res.status, 'TRANSIENT', code, debugId);
      }
      // 401 here means bad credentials: a configuration error, not a payment outcome.
      throw new PayPalAuthError(res.status, code, debugId);
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 0;
    this.#token = { value, expiresAt: this.#now() + expiresIn * 1000 - TOKEN_SKEW_MS };
    return value;
  }

  /**
   * One PayPal call with `Prefer: return=representation`. A 401 refreshes the token once and
   * retries with the **same** request id. Never throws for network errors or timeouts: those come
   * back as `http: 0` so callers classify them TRANSIENT. Throws `PayPalAuthError` only when the
   * token can't be minted for a non-transient reason (bad credentials).
   */
  async request(
    call: PayPalCall,
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOptions = {},
  ): Promise<PayPalResponse> {
    for (let attempt = 1; ; attempt++) {
      let token: string;
      try {
        token = await this.token();
      } catch (err) {
        if (err instanceof PayPalApiError && err.errorClass === 'TRANSIENT') {
          return { http: 0, json: {}, timeout: err.code === 'TIMEOUT', issue: err.code };
        }
        throw err;
      }
      const res = await this.#send(call, method, path, token, opts, attempt);
      if (res.http === 401 && attempt === 1) {
        this.invalidate(token);
        continue;
      }
      return res;
    }
  }

  async #send(
    call: PayPalCall,
    method: string,
    path: string,
    token: string,
    opts: RequestOptions,
    attempt: number,
  ): Promise<PayPalResponse> {
    const started = this.#now();
    const headers: Record<string, string> = {
      ...opts.headers,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.requestId ? { 'PayPal-Request-Id': opts.requestId } : {}),
    };
    const base = { call, method, path, requestId: opts.requestId, attempt };
    let res: Response;
    let json: Record<string, unknown>;
    try {
      res = await this.#fetch(this.baseUrl + path, {
        method,
        headers,
        body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      // A body cut off mid-read (timeout) is the same as no answer: the outcome is unknown.
      json = await readJson(res);
    } catch (err) {
      const timeout = isTimeout(err);
      this.#emit({ ...base, http: 0, ms: this.#now() - started, error: errorText(err) });
      return { http: 0, json: {}, timeout, issue: timeout ? 'TIMEOUT' : 'NETWORK' };
    }
    const debugId =
      res.headers.get('paypal-debug-id') ??
      (typeof json.debug_id === 'string' ? json.debug_id : undefined);
    const issue = res.ok ? undefined : issueOf(json);
    this.#emit({ ...base, http: res.status, ms: this.#now() - started, debugId, issue });
    return { http: res.status, json, debugId, issue };
  }

  #emit(entry: PayPalLogEntry): void {
    if (!this.#log) return;
    try {
      this.#log({ ...entry, error: entry.error === undefined ? undefined : redact(entry.error) });
    } catch {
      // Logging must never break a money call.
    }
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export interface PayPalRestClientOptions extends PayPalHttpOptions {
  /**
   * Allow raw test-card sources (`source.kind: 'card'`): the server-side SIM top-up only. Ignored
   * unless the base is a PayPal sandbox or the fake. Default false.
   */
  allowRawCard?: boolean;
  /**
   * Send `PayPal-Mock-Response` when a call asks for it. Pass `mockDeclinesAllowed(config)`.
   * Ignored unless the base is a PayPal sandbox or the fake. Default false.
   */
  allowMockResponse?: boolean;
  /** Extra tries with the same request id when PayPal doesn't answer (5xx / timeout). Default 2. */
  retries?: number;
  /** Wait before retry `n` (1-based). Default 500 ms × n. */
  retryDelayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Bases besides PayPal's sandbox hosts that count as non-live (the fake's). */
  testBases?: readonly string[];
  /** `PAYPAL_WEBHOOK_ID`, for `verifyWebhook`. */
  webhookId?: string | undefined;
}

/**
 * The PayPal client (`pp`): the order calls here plus SP-001c's refunds, payouts and webhook
 * verify (moneyOut.ts), all over one `PayPalHttp` (one token cache).
 */
export class PayPalRestClient implements PayPalOrdersClient, MoneyOutClient {
  readonly http: PayPalHttp;
  readonly settings: orders.OrderSettings;
  readonly refundCapture: MoneyOutClient['refundCapture'];
  readonly getRefund: MoneyOutClient['getRefund'];
  readonly payout: MoneyOutClient['payout'];
  readonly getPayoutBatch: MoneyOutClient['getPayoutBatch'];
  readonly getPayoutItem: MoneyOutClient['getPayoutItem'];
  readonly verifyWebhook: MoneyOutClient['verifyWebhook'];

  constructor(opts: PayPalRestClientOptions) {
    this.http = new PayPalHttp(opts);
    // Raw cards and mock responses never reach a live base, whatever the caller asked for.
    const nonLive =
      isSandboxPayPalBase(this.http.baseUrl) ||
      (opts.testBases ?? []).some((b) => b.replace(/\/+$/, '') === this.http.baseUrl);
    this.settings = {
      allowRawCard: nonLive && (opts.allowRawCard ?? false),
      allowMockResponse: nonLive && (opts.allowMockResponse ?? false),
      retries: opts.retries ?? 2,
      retryDelayMs: opts.retryDelayMs ?? ((n) => 500 * n),
      sleep: opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    };
    const out = moneyOut(this.http, opts.webhookId);
    this.refundCapture = out.refundCapture;
    this.getRefund = out.getRefund;
    this.payout = out.payout;
    this.getPayoutBatch = out.getPayoutBatch;
    this.getPayoutItem = out.getPayoutItem;
    this.verifyWebhook = out.verifyWebhook;
  }

  createTopupOrder(input: CreateTopupOrderInput) {
    return orders.createTopupOrder(this.http, this.settings, input);
  }
  captureOrder(orderId: string, topupId: string, opts?: CaptureOrderOptions) {
    return orders.captureOrder(this.http, this.settings, orderId, topupId, opts);
  }
  getOrder(orderId: string) {
    return orders.getOrder(this.http, orderId);
  }
}
