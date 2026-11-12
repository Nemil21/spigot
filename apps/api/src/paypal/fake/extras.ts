import type { MoneyOutCall, PayPalResponse, PayPalTransport } from '../transport.js';
import { FAKE_PAYPAL_BASE, notFound, type FakeRequest, type Handled } from './http.js';
import { FakePayouts, type FakePayoutsOptions } from './payouts.js';
import { FakeRefunds, type FakeRefundsOptions } from './refunds.js';
import {
  FakeWebhooks,
  type EmitWebhookOptions,
  type FakeWebhookDelivery,
  type FakeWebhooksOptions,
} from './webhooks.js';

/**
 * The SP-001c part of FakePayPal: refunds, payouts and webhook verify behind one `fetch`, with the
 * same fault injection as Holdfast's fake. SP-001b's core fake (orders, capture, vault) forwards
 * the routes it doesn't own to `extras.fetch` (or `extras.handle`) and passes its captures in as
 * `captureOf`, so `fake.claimPayout`, `fake.emitWebhook`, … reach this object.
 */

export type ExtrasOp =
  'refund' | 'get_refund' | 'payout' | 'get_payout_batch' | 'get_payout_item' | 'verify_webhook';

export type ExtrasFault =
  /** Answer with this status and body; no state changes. */
  | { kind: 'status'; http: number; body?: unknown }
  /** Never answer (until the client's timeout aborts). No state changes. */
  | { kind: 'timeout' }
  /** Do the work, then lose the response (the client times out). */
  | { kind: 'drop_response' }
  /** Extra delay before this call. */
  | { kind: 'latency'; ms: number };

export interface ExtrasCall {
  op: ExtrasOp;
  method: string;
  path: string;
  requestId: string | null;
  http: number;
}

export interface FakePayPalExtrasOptions {
  refunds?: FakeRefundsOptions;
  payouts?: FakePayoutsOptions;
  webhooks?: FakeWebhooksOptions;
  /** Delay before every answer, so concurrent calls overlap. Default 0. */
  latencyMs?: number;
  /** Extra random delay in [0, jitterMs) per call. Default 0. */
  jitterMs?: number;
  /** Where routes this fake doesn't own go (SP-001b's core fake). Default: 404. */
  next?: typeof fetch;
}

function route(method: string, path: string): { op: ExtrasOp; id: string } | null {
  return (
    FakeRefunds.route(method, path) ??
    FakePayouts.route(method, path) ??
    FakeWebhooks.route(method, path)
  );
}

export class FakePayPalExtras {
  readonly refunds: FakeRefunds;
  readonly payouts: FakePayouts;
  readonly webhooks: FakeWebhooks;
  readonly calls: ExtrasCall[] = [];
  latencyMs: number;
  jitterMs: number;
  readonly #next: typeof fetch | undefined;
  readonly #faults = new Map<ExtrasOp | 'any', ExtrasFault[]>();

  constructor(opts: FakePayPalExtrasOptions = {}) {
    this.refunds = new FakeRefunds(opts.refunds);
    this.payouts = new FakePayouts(opts.payouts);
    this.webhooks = new FakeWebhooks(opts.webhooks);
    this.latencyMs = opts.latencyMs ?? 0;
    this.jitterMs = opts.jitterMs ?? 0;
    this.#next = opts.next;
  }

  // ------------------------------------------------------------------ helpers the tickets name

  /** `UNCLAIMED → SUCCESS` (SP-021). */
  claimPayout(itemId: string): void {
    this.payouts.claimPayout(itemId);
  }

  /** `UNCLAIMED → RETURNED` (SP-021). */
  returnPayout(itemId: string): void {
    this.payouts.returnPayout(itemId);
  }

  /** Refund `PENDING → COMPLETED` (SP-049). */
  completeRefund(refundId: string): void {
    this.refunds.completeRefund(refundId);
  }

  /** A signed webhook delivery the fake verifier accepts (SP-059). */
  emitWebhook(
    type: string,
    resource: Record<string, unknown>,
    opts?: EmitWebhookOptions,
  ): FakeWebhookDelivery {
    return this.webhooks.emitWebhook(type, resource, opts);
  }

  // ------------------------------------------------------------------ faults

  /** Queue `fault` for the next `times` calls of `op` (or of any call here). */
  failNext(op: ExtrasOp | 'any', fault: ExtrasFault, times = 1): this {
    const queue = this.#faults.get(op) ?? [];
    for (let i = 0; i < times; i++) queue.push(fault);
    this.#faults.set(op, queue);
    return this;
  }

  clearFaults(): void {
    this.#faults.clear();
  }

  // ------------------------------------------------------------------ HTTP

  /** True when this fake owns the route. */
  owns(method: string, path: string): boolean {
    return route(method.toUpperCase(), path) !== null;
  }

  /** Answer one request synchronously, with no faults or latency; null if not our route. */
  handle(req: FakeRequest): Handled | null {
    return this.refunds.handle(req) ?? this.payouts.handle(req) ?? this.webhooks.handle(req);
  }

  /**
   * A `fetch` for this fake. It doesn't check OAuth tokens: SP-001b's core fake does that before
   * forwarding here.
   */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const r = route(method, url.pathname);
    if (!r) {
      if (this.#next) return this.#next(input, init);
      return respond(notFound());
    }
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? undefined;
    const req: FakeRequest = {
      method,
      path: url.pathname,
      headers,
      rawBody: typeof init?.body === 'string' ? init.body : '',
      requestId: headers.get('paypal-request-id'),
    };
    const call: ExtrasCall = {
      op: r.op,
      method,
      path: url.pathname,
      requestId: req.requestId,
      http: 0,
    };

    await delay(this.latencyMs + Math.floor(Math.random() * this.jitterMs), signal);
    const fault = this.#faults.get(r.op)?.shift() ?? this.#faults.get('any')?.shift();
    if (fault?.kind === 'latency') await delay(fault.ms, signal);
    if (fault?.kind === 'timeout') {
      this.calls.push(call);
      return hang(signal);
    }
    const result: Handled =
      fault?.kind === 'status'
        ? { http: fault.http, body: fault.body }
        : (this.handle(req) ?? notFound());
    call.http = result.http;
    this.calls.push(call);
    if (fault?.kind === 'drop_response') return hang(signal);
    return respond(result);
  };

  /** A token-free transport over this fake (tests, until SP-001b's client wraps the core fake). */
  transport(opts: { timeoutMs?: number } = {}): PayPalTransport {
    return fetchTransport(this.fetch, FAKE_PAYPAL_BASE, opts);
  }
}

function respond(result: Handled): Response {
  if (result.body === undefined || result.http === 204)
    return new Response(null, { status: result.http });
  return new Response(JSON.stringify(result.body), {
    status: result.http,
    headers: { 'content-type': 'application/json' },
  });
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function hang(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const fail = () => reject(signal?.reason ?? new DOMException('timed out', 'TimeoutError'));
    if (signal?.aborted) return fail();
    if (signal) signal.addEventListener('abort', fail, { once: true });
    else setTimeout(fail, 60_000);
  });
}

function issueOf(json: Record<string, unknown>): string | undefined {
  const details = json.details;
  if (Array.isArray(details)) {
    const issue = (details[0] as { issue?: unknown } | undefined)?.issue;
    if (typeof issue === 'string') return issue;
  }
  return typeof json.name === 'string' ? json.name : undefined;
}

/**
 * A minimal `PayPalTransport` over any `fetch`: `PayPal-Request-Id`, `Prefer:
 * return=representation`, a timeout, and network failures as `http: 0`. No OAuth. Tests only;
 * production uses SP-001b's `PayPalHttp`, which has the same `request` shape.
 */
export function fetchTransport(
  fetchFn: typeof fetch,
  baseUrl: string,
  opts: { timeoutMs?: number } = {},
): PayPalTransport {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  return {
    async request(_call: MoneyOutCall, method, path, o = {}): Promise<PayPalResponse> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(o.requestId ? { 'PayPal-Request-Id': o.requestId } : {}),
        ...o.headers,
      };
      const body = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
      let res: Response;
      let text: string;
      try {
        res = await fetchFn(baseUrl + path, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const timeout = name === 'TimeoutError' || name === 'AbortError';
        return { http: 0, json: {}, timeout, issue: timeout ? 'TIMEOUT' : 'NETWORK' };
      }
      let json: Record<string, unknown> = {};
      try {
        const v: unknown = text ? JSON.parse(text) : {};
        if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Record<string, unknown>;
      } catch {
        json = {};
      }
      const debugId = typeof json.debug_id === 'string' ? json.debug_id : undefined;
      return { http: res.status, json, debugId, issue: res.ok ? undefined : issueOf(json) };
    },
  };
}
