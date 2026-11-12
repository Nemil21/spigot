import { PayPalRestClient, type PayPalRestClientOptions } from '../client.js';
import { centsToDecimal, decimalToCents } from '../money.js';

/**
 * `FakePayPal`: an in-memory PayPal REST API behind `PAYPAL_MODE=stub`, for race tests, dev seeds
 * and CI. It answers HTTP like the sandbox did (status codes, issue codes, replay behaviour from
 * Holdfast S1–S4 and S7), and `fake.client()` is the real `PayPalRestClient` over it, so the stub
 * and the sandbox share the client code and pass the same contract suite (test-harness.ts).
 *
 * Core (SP-001b): OAuth tokens, CAPTURE-intent orders (card and vault sources capture at create;
 * wallet / no-source orders wait for `approve()` then capture), vault ids for card and wallet,
 * `PayPal-Request-Id` replay, `seller_receivable_breakdown.paypal_fee`, PENDING captures and fault
 * injection (latency, 5xx, timeouts, declines, a response lost after the work was done).
 *
 * Extensions (SP-001c: refunds, payouts, webhooks) live in their own files and register routes
 * with `FakePayPal.extend(install)`; an install runs for every fake constructed afterwards.
 */

export const FAKE_PAYPAL_BASE = 'https://fake.paypal.local';
export const FAKE_CLIENT_ID = 'fake-client-id';
export const FAKE_CLIENT_SECRET = 'fake-client-secret';

export type FakeOp = 'token' | 'order_create' | 'capture' | 'get_order' | (string & {});

export type FakeFault =
  /** Answer with this status and issue; no state changes. */
  | { kind: 'status'; http: number; issue?: string }
  /** Never answer (until the client's timeout aborts). No state changes. */
  | { kind: 'timeout' }
  /** Do the work, then lose the response (the client times out). */
  | { kind: 'drop_response' }
  /** Instrument declined: capture → 403 with an empty body (S7); order create → 422. */
  | { kind: 'decline' }
  /** Extra delay before this one call. */
  | { kind: 'latency'; ms: number };

export interface FakeCall {
  op: FakeOp;
  method: string;
  path: string;
  requestId: string | null;
  prefer: string | null;
  mockResponse: string | null;
  http: number;
}

/** What a route handler answers. `body: undefined` sends an empty body (S7's 403 decline). */
export interface FakeAnswer {
  http: number;
  body?: unknown;
}

export interface FakeRequest {
  /** The path id the route matched (`''` when the route has none). */
  id: string;
  body: Record<string, unknown>;
  rawBody: string;
  headers: Headers;
  call: FakeCall;
}

/** A route an extension adds. `match` returns the path id, or null when the path isn't its. */
export interface FakeRoute {
  op: FakeOp;
  method: 'GET' | 'POST';
  match: (path: string) => string | null;
  handle: (req: FakeRequest) => FakeAnswer;
}

export interface FakeOrder {
  id: string;
  status: string;
  amountCents: number;
  customId: string | null;
  description: string | null;
  source: 'card' | 'paypal' | null;
  rawCard: boolean;
  vaultRequested: boolean;
  vault: { id: string; customerId: string } | null;
  captureIds: string[];
  createTime: string;
}

export interface FakeCapture {
  id: string;
  orderId: string;
  amountCents: number;
  feeCents: number;
  status: 'COMPLETED' | 'PENDING' | 'DECLINED' | (string & {});
  reason: string | null;
  customId: string | null;
  createTime: string;
}

export interface FakePayPalOptions {
  /** Delay before every answer (so concurrent calls overlap). Default 0. */
  latencyMs?: number;
  /** Extra random delay in [0, jitterMs) per call, to vary race order. Default 0. */
  jitterMs?: number;
  /** Clock for create times. */
  now?: () => Date;
  /** OAuth `expires_in` in seconds. Default 32400 (PayPal's 9 h). */
  tokenTtlSeconds?: number;
  /**
   * What a raw-card create replayed with the same request id gets. `replay` (default): the same
   * order, 200, as the sandbox answers CAPTURE-intent creates (SP-001b probe, Nov 12 2026).
   * `refuse`: 422 `TRANSACTION_REFUSED`, as Holdfast S7 saw for AUTHORIZE creates.
   */
  rawCardReplay?: 'replay' | 'refuse';
}

/** A PayPal-shaped error body: `{name, details: [{issue}]}`. */
export function fakeError(http: number, issue: string): FakeAnswer {
  const name =
    http === 404
      ? 'RESOURCE_NOT_FOUND'
      : http === 400
        ? 'INVALID_REQUEST'
        : http >= 500
          ? 'INTERNAL_SERVER_ERROR'
          : 'UNPROCESSABLE_ENTITY';
  return { http, body: { name, details: [{ issue }] } };
}

export const fakeAmount = (cents: number) => ({
  currency_code: 'USD',
  value: centsToDecimal(cents),
});

/** The US sandbox merchant's standard rate: 3.49% + $0.49 (only the shape matters to Spigot). */
export function fakeFeeCents(amountCents: number): number {
  return Math.round(amountCents * 0.0349) + 49;
}

type Installer = (fake: FakePayPal) => void;

export class FakePayPal {
  static readonly #installers: Installer[] = [];

  /** Register an extension (SP-001c's `fake/*.ts`). Runs in every fake constructed afterwards. */
  static extend(install: Installer): void {
    if (!FakePayPal.#installers.includes(install)) FakePayPal.#installers.push(install);
  }

  readonly calls: FakeCall[] = [];
  latencyMs: number;
  jitterMs: number;
  tokensIssued = 0;

  readonly #now: () => Date;
  readonly #tokenTtl: number;
  readonly #rawCardReplay: 'replay' | 'refuse';
  #seq = 0;
  readonly #validTokens = new Set<string>();
  readonly #orders = new Map<string, FakeOrder>();
  readonly #captures = new Map<string, FakeCapture>();
  readonly #vaults = new Map<string, { kind: 'card' | 'paypal'; customerId: string }>();
  readonly #replays = new Map<string, FakeAnswer>();
  readonly #faults = new Map<FakeOp | 'any', FakeFault[]>();
  readonly #routes: FakeRoute[] = [];
  #pendNext: string[] = [];

  constructor(opts: FakePayPalOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
    this.jitterMs = opts.jitterMs ?? 0;
    this.#now = opts.now ?? (() => new Date());
    this.#tokenTtl = opts.tokenTtlSeconds ?? 32_400;
    this.#rawCardReplay = opts.rawCardReplay ?? 'replay';
    for (const install of FakePayPal.#installers) install(this);
  }

  /** A `PayPalRestClient` wired to this fake (raw test cards and mock responses allowed). */
  client(opts: Partial<PayPalRestClientOptions> = {}): PayPalRestClient {
    return new PayPalRestClient({
      baseUrl: FAKE_PAYPAL_BASE,
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      fetch: this.fetch,
      allowRawCard: true,
      allowMockResponse: true,
      sleep: async () => {},
      ...opts,
      testBases: [FAKE_PAYPAL_BASE],
    });
  }

  // ------------------------------------------------------------------ extension API

  /** Add a route (extensions). Core routes are matched first. */
  route(route: FakeRoute): void {
    this.#routes.push(route);
  }

  /** A fresh PayPal-looking id: `prefix` + 8 base-36 characters. */
  newId(prefix: string): string {
    return `${prefix}${(++this.#seq).toString(36).toUpperCase().padStart(8, '0')}`;
  }

  now(): Date {
    return this.#now();
  }

  /**
   * Same `PayPal-Request-Id` on the same endpoint and resource → the stored answer (201 becomes
   * 200, as PayPal does). Only 2xx answers are stored, so a failed call can be retried.
   */
  replayable(call: FakeCall, op: FakeOp, id: string, run: () => FakeAnswer): FakeAnswer {
    if (!call.requestId) return run();
    const key = `${op}:${id}:${call.requestId}`;
    const prior = this.#replays.get(key);
    if (prior) return prior.http === 201 ? { http: 200, body: prior.body } : prior;
    const result = run();
    if (result.http < 300) this.#replays.set(key, result);
    return result;
  }

  // ------------------------------------------------------------------ test controls

  /** Queue `fault` for the next `times` calls of `op` (or of any call except the token). */
  failNext(op: FakeOp | 'any', fault: FakeFault, times = 1): this {
    const queue = this.#faults.get(op) ?? [];
    for (let i = 0; i < times; i++) queue.push(fault);
    this.#faults.set(op, queue);
    return this;
  }

  clearFaults(): void {
    this.#faults.clear();
  }

  /** The next `times` captures come back PENDING with `status_details.reason = reason`. */
  pendNextCapture(reason = 'PENDING_REVIEW', times = 1): this {
    for (let i = 0; i < times; i++) this.#pendNext.push(reason);
    return this;
  }

  /** The buyer approved the order (wallet return, or JS SDK approval for a no-source order). */
  approve(orderId: string): void {
    const order = this.#orders.get(orderId);
    if (!order) throw new Error(`fake: no order ${orderId}`);
    if (order.status !== 'PAYER_ACTION_REQUIRED' && order.status !== 'CREATED') {
      throw new Error(`fake: order ${orderId} is ${order.status}, not awaiting approval`);
    }
    order.status = 'APPROVED';
    order.source ??= 'paypal';
  }

  /** Settle a PENDING capture (what the poller / webhook would later see). */
  settleCapture(captureId: string, status: 'COMPLETED' | 'DECLINED' = 'COMPLETED'): void {
    const capture = this.#captures.get(captureId);
    if (!capture) throw new Error(`fake: no capture ${captureId}`);
    if (capture.status !== 'PENDING')
      throw new Error(`fake: capture ${captureId} is ${capture.status}`);
    capture.status = status;
    capture.reason = status === 'DECLINED' ? 'DECLINED' : null;
  }

  /** Put a payment method in the vault directly (tests that start from a saved card / wallet). */
  seedVault(kind: 'card' | 'paypal'): string {
    const id = this.newId('VAULT');
    this.#vaults.set(id, { kind, customerId: this.newId('CUST') });
    return id;
  }

  /** Make every issued token invalid; the next call gets a 401. */
  revokeTokens(): void {
    this.#validTokens.clear();
  }

  order(id: string): Readonly<FakeOrder> | undefined {
    const o = this.#orders.get(id);
    return o && { ...o, captureIds: [...o.captureIds] };
  }

  orders(): Readonly<FakeOrder>[] {
    return [...this.#orders.values()].map((o) => ({ ...o, captureIds: [...o.captureIds] }));
  }

  /** Captures, optionally only those of one order. */
  captures(orderId?: string): Readonly<FakeCapture>[] {
    return [...this.#captures.values()]
      .filter((c) => orderId === undefined || c.orderId === orderId)
      .map((c) => ({ ...c }));
  }

  // ------------------------------------------------------------------ HTTP

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? undefined;
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const route = this.#match(method, url.pathname);
    const call: FakeCall = {
      op: route?.op ?? 'unknown',
      method,
      path: url.pathname,
      requestId: headers.get('paypal-request-id'),
      prefer: headers.get('prefer'),
      mockResponse: headers.get('paypal-mock-response'),
      http: 0,
    };

    await this.#delay(this.latencyMs + Math.floor(Math.random() * this.jitterMs), signal);
    const fault = route ? this.#takeFault(route.op) : undefined;
    if (fault?.kind === 'latency') await this.#delay(fault.ms, signal);

    let result: FakeAnswer;
    if (!route) {
      result = fakeError(404, 'RESOURCE_NOT_FOUND');
    } else if (route.op === 'token') {
      result = this.#token(headers.get('authorization'));
    } else if (!this.#authorized(headers.get('authorization'))) {
      result = {
        http: 401,
        body: { name: 'AUTHENTICATION_FAILURE', details: [{ issue: 'INVALID_TOKEN' }] },
      };
    } else if (fault?.kind === 'timeout') {
      this.calls.push(call);
      return this.#hang(signal);
    } else if (fault?.kind === 'status') {
      result = fakeError(
        fault.http,
        fault.issue ?? (fault.http >= 500 ? 'INTERNAL_SERVER_ERROR' : 'UNPROCESSABLE_ENTITY'),
      );
    } else if (fault?.kind === 'decline' && route.op === 'capture') {
      result = { http: 403 };
    } else if (fault?.kind === 'decline') {
      result = fakeError(422, 'INSTRUMENT_DECLINED');
    } else {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = rawBody ? JSON.parse(rawBody) : {};
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        return this.#respond(call, fakeError(400, 'MALFORMED_REQUEST_JSON'));
      }
      result = route.handle({ id: route.id, body, rawBody, headers, call });
    }

    if (fault?.kind === 'drop_response') {
      call.http = result.http;
      this.calls.push(call);
      return this.#hang(signal);
    }
    return this.#respond(call, result);
  };

  #respond(call: FakeCall, result: FakeAnswer): Response {
    call.http = result.http;
    this.calls.push(call);
    if (result.body === undefined || result.http === 204) {
      return new Response(null, { status: result.http });
    }
    return new Response(JSON.stringify(result.body), {
      status: result.http,
      headers: { 'content-type': 'application/json', 'paypal-debug-id': `fake${++this.#seq}` },
    });
  }

  #coreRoutes: FakeRoute[] = [
    {
      op: 'token',
      method: 'POST',
      match: (p) => (p === '/v1/oauth2/token' ? '' : null),
      handle: () => fakeError(500, 'UNREACHABLE'),
    },
    {
      op: 'order_create',
      method: 'POST',
      match: (p) => (p === '/v2/checkout/orders' ? '' : null),
      handle: (req) => this.#createOrder(req),
    },
    {
      op: 'capture',
      method: 'POST',
      match: (p) => /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(p)?.[1] ?? null,
      handle: (req) =>
        this.replayable(req.call, 'capture', req.id, () =>
          this.#captureOrder(req.id, req.call.mockResponse),
        ),
    },
    {
      op: 'get_order',
      method: 'GET',
      match: (p) => /^\/v2\/checkout\/orders\/([^/]+)$/.exec(p)?.[1] ?? null,
      handle: (req) => {
        const order = this.#orders.get(req.id);
        return order
          ? { http: 200, body: this.#orderBody(order) }
          : fakeError(404, 'INVALID_RESOURCE_ID');
      },
    },
  ];

  #match(method: string, path: string): (FakeRoute & { id: string }) | null {
    for (const route of [...this.#coreRoutes, ...this.#routes]) {
      if (route.method !== method) continue;
      const id = route.match(path);
      if (id !== null) return { ...route, id: decodeURIComponent(id) };
    }
    return null;
  }

  #takeFault(op: FakeOp): FakeFault | undefined {
    return (
      this.#faults.get(op)?.shift() ??
      (op === 'token' ? undefined : this.#faults.get('any')?.shift())
    );
  }

  #delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
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

  #hang(signal: AbortSignal | undefined): Promise<Response> {
    return new Promise((_, reject) => {
      const fail = () => reject(signal?.reason ?? new DOMException('timed out', 'TimeoutError'));
      if (signal?.aborted) return fail();
      if (signal) signal.addEventListener('abort', fail, { once: true });
      else setTimeout(fail, 60_000);
    });
  }

  #token(authorization: string | null): FakeAnswer {
    const expected = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`;
    if (authorization !== expected) return { http: 401, body: { error: 'invalid_client' } };
    const token = `fake-token-${++this.tokensIssued}`;
    this.#validTokens.add(token);
    return {
      http: 200,
      body: { access_token: token, token_type: 'Bearer', expires_in: this.#tokenTtl },
    };
  }

  #authorized(authorization: string | null): boolean {
    return !!authorization && this.#validTokens.has(authorization.replace(/^Bearer /, ''));
  }

  // ------------------------------------------------------------------ orders

  #createOrder(req: FakeRequest): FakeAnswer {
    const { body, call } = req;
    const unit = (Array.isArray(body.purchase_units) ? body.purchase_units[0] : undefined) as
      Record<string, unknown> | undefined;
    const value = (unit?.amount as { value?: unknown } | undefined)?.value;
    if (body.intent !== 'CAPTURE' || !unit || typeof value !== 'string') {
      return fakeError(400, 'INVALID_PARAMETER_VALUE');
    }
    let amountCents: number;
    try {
      amountCents = decimalToCents(value);
    } catch {
      return fakeError(400, 'INVALID_PARAMETER_VALUE');
    }
    const source = (body.payment_source ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const card = source.card;
    const paypal = source.paypal;
    const rawCard = !!card && typeof card.number === 'string';

    if (call.requestId) {
      const prior = this.#replays.get(`order_create::${call.requestId}`);
      // Same request id → the same order with 200 (no-source and vault_id: S7 step 3; raw card
      // with CAPTURE intent: SP-001b probe). `rawCardReplay: 'refuse'` models S7's AUTHORIZE-era
      // 422 TRANSACTION_REFUSED for raw cards.
      if (prior) {
        if (rawCard && this.#rawCardReplay === 'refuse') {
          return fakeError(422, 'TRANSACTION_REFUSED');
        }
        const order = this.#orders.get((prior.body as { id: string }).id);
        return { http: 200, body: order ? this.#orderBody(order) : prior.body };
      }
    }

    const vaultId = (card?.vault_id ?? paypal?.vault_id) as string | undefined;
    const vaulted = vaultId ? this.#vaults.get(vaultId) : undefined;
    if (vaultId && (!vaulted || vaulted.kind !== (card ? 'card' : 'paypal'))) {
      return fakeError(422, 'INVALID_RESOURCE_ID');
    }
    const capturesNow = rawCard || !!vaultId;
    if (capturesNow && mockCode(call.mockResponse) === 'INSTRUMENT_DECLINED') {
      return fakeError(422, 'INSTRUMENT_DECLINED');
    }

    const vaultAttr = ((card ?? paypal)?.attributes as { vault?: unknown } | undefined)?.vault;
    const order: FakeOrder = {
      id: this.newId('ORD'),
      status: 'CREATED',
      amountCents,
      customId: typeof unit.custom_id === 'string' ? unit.custom_id : null,
      description: typeof unit.description === 'string' ? unit.description : null,
      source: card ? 'card' : paypal ? 'paypal' : null,
      rawCard,
      vaultRequested: !!vaultAttr,
      vault: vaulted && vaultId ? { id: vaultId, customerId: vaulted.customerId } : null,
      captureIds: [],
      createTime: this.#now().toISOString(),
    };
    this.#orders.set(order.id, order);

    if (capturesNow) {
      // Card and vault sources capture at create (CAPTURE intent).
      this.#newCapture(order);
    } else if (paypal) {
      order.status = 'PAYER_ACTION_REQUIRED';
    }
    const result = { http: 201, body: this.#orderBody(order) };
    if (call.requestId) this.#replays.set(`order_create::${call.requestId}`, result);
    return result;
  }

  #captureOrder(orderId: string, mock: string | null): FakeAnswer {
    const order = this.#orders.get(orderId);
    if (!order) return fakeError(404, 'INVALID_RESOURCE_ID');
    // S7: a mocked decline on capture came back as 403 with an empty body.
    if (mockCode(mock) === 'INSTRUMENT_DECLINED') return { http: 403 };
    if (order.captureIds.length) return fakeError(422, 'ORDER_ALREADY_CAPTURED');
    if (order.status !== 'APPROVED') return fakeError(422, 'ORDER_NOT_APPROVED');
    this.#newCapture(order);
    return { http: 201, body: this.#orderBody(order) };
  }

  #newCapture(order: FakeOrder): FakeCapture {
    const pending = this.#pendNext.shift();
    const capture: FakeCapture = {
      id: this.newId('CAP'),
      orderId: order.id,
      amountCents: order.amountCents,
      feeCents: fakeFeeCents(order.amountCents),
      status: pending ? 'PENDING' : 'COMPLETED',
      reason: pending ?? null,
      customId: order.customId,
      createTime: this.#now().toISOString(),
    };
    this.#captures.set(capture.id, capture);
    order.captureIds.push(capture.id);
    order.status = 'COMPLETED';
    if (order.vaultRequested && !order.vault && order.source) {
      const id = this.newId('VAULT');
      const customerId = this.newId('CUST');
      this.#vaults.set(id, { kind: order.source, customerId });
      order.vault = { id, customerId };
    }
    return capture;
  }

  #captureBody(c: FakeCapture) {
    return {
      id: c.id,
      status: c.status,
      ...(c.reason ? { status_details: { reason: c.reason } } : {}),
      amount: fakeAmount(c.amountCents),
      final_capture: true,
      custom_id: c.customId ?? undefined,
      seller_receivable_breakdown: {
        gross_amount: fakeAmount(c.amountCents),
        paypal_fee: fakeAmount(c.feeCents),
        net_amount: fakeAmount(c.amountCents - c.feeCents),
      },
      create_time: c.createTime,
      links: [
        { rel: 'self', href: `${FAKE_PAYPAL_BASE}/v2/payments/captures/${c.id}` },
        { rel: 'up', href: `${FAKE_PAYPAL_BASE}/v2/checkout/orders/${c.orderId}` },
      ],
    };
  }

  #orderBody(o: FakeOrder) {
    const captures = o.captureIds.map((id) => this.#captures.get(id)!).filter(Boolean);
    const vault = o.vault
      ? {
          attributes: {
            vault: { id: o.vault.id, status: 'VAULTED', customer: { id: o.vault.customerId } },
          },
        }
      : {};
    const awaiting = o.status === 'PAYER_ACTION_REQUIRED' || o.status === 'CREATED';
    return {
      id: o.id,
      intent: 'CAPTURE',
      status: o.status,
      create_time: o.createTime,
      ...(o.source ? { payment_source: { [o.source]: vault } } : {}),
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: o.customId ?? undefined,
          description: o.description ?? undefined,
          amount: fakeAmount(o.amountCents),
          ...(captures.length
            ? { payments: { captures: captures.map((c) => this.#captureBody(c)) } }
            : {}),
        },
      ],
      links: [
        { rel: 'self', href: `${FAKE_PAYPAL_BASE}/v2/checkout/orders/${o.id}` },
        ...(awaiting
          ? [
              {
                rel: o.status === 'PAYER_ACTION_REQUIRED' ? 'payer-action' : 'approve',
                href: `${FAKE_PAYPAL_BASE}/checkoutnow?token=${o.id}`,
              },
            ]
          : []),
      ],
    };
  }
}

function mockCode(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    const code = (JSON.parse(header) as { mock_application_codes?: unknown })
      .mock_application_codes;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}
