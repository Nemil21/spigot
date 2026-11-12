import { centsToDecimal, decimalToCents, obj } from '../transport.js';
import {
  FAKE_PAYPAL_BASE,
  fakeError,
  makeIdFactory,
  notFound,
  parseBody,
  type FakeRequest,
  type Handled,
} from './http.js';

/**
 * Fake PayPal Refunds, matching SP-003 S9: partial refunds against a capture with a cumulative cap
 * (`422 REFUND_AMOUNT_EXCEEDED` above what's left), replay by `PayPal-Request-Id` (200, same
 * refund, replayed body ignored), and `PENDING` refunds a test settles with `completeRefund`.
 */

export interface FakeCaptureInfo {
  amountCents: number;
}

export type FakeRefundStatus = 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED';

export interface FakeRefund {
  id: string;
  captureId: string;
  amountCents: number;
  status: FakeRefundStatus;
  requestId: string | null;
  noteToPayer: string | null;
  createTime: string;
  updateTime: string;
}

export interface FakeRefundsOptions {
  /** Where refund ids start counting (see `FakePayPalOptions.seqStart`). Default 0. */
  seqStart?: number;
  /**
   * Look up a capture made by the core fake (SP-001b). Captures added with `addCapture` are
   * checked first.
   */
  captureOf?: (captureId: string) => FakeCaptureInfo | undefined;
  now?: () => Date;
}

/** Refunds that still hold part of the capture (FAILED / CANCELLED give it back). */
const HOLDS = new Set<FakeRefundStatus>(['COMPLETED', 'PENDING']);

const EXCEEDED_TEXT =
  'The refund amount must be less than or equal to the capture amount that has not yet been refunded.';

export class FakeRefunds {
  readonly #captureOf: FakeRefundsOptions['captureOf'];
  readonly #now: () => Date;
  readonly #id: (prefix: string) => string;
  readonly #captures = new Map<string, FakeCaptureInfo>();
  readonly #refunds = new Map<string, FakeRefund>();
  /** `captureId:requestId` → refund id. */
  readonly #byRequest = new Map<string, string>();
  #pendingNext = 0;

  constructor(opts: FakeRefundsOptions = {}) {
    this.#id = makeIdFactory(opts.seqStart);
    this.#captureOf = opts.captureOf;
    this.#now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ test controls

  /** Register a capture that refunds can draw on (standalone use, without the core fake). */
  addCapture(captureId: string, amountCents: number): void {
    this.#captures.set(captureId, { amountCents });
  }

  /** The next `times` new refunds come back `PENDING` (e.g. an eCheck-funded capture). */
  pendingNext(times = 1): this {
    this.#pendingNext += times;
    return this;
  }

  /** PENDING → COMPLETED (what SP-049's poll or `PAYMENT.CAPTURE.REFUNDED` then sees). */
  completeRefund(refundId: string): void {
    this.#settle(refundId, 'COMPLETED');
  }

  /** PENDING → FAILED: the amount is refundable again. */
  failRefund(refundId: string): void {
    this.#settle(refundId, 'FAILED');
  }

  refund(refundId: string): Readonly<FakeRefund> | undefined {
    const r = this.#refunds.get(refundId);
    return r && { ...r };
  }

  refundsOf(captureId: string): Readonly<FakeRefund>[] {
    return [...this.#refunds.values()]
      .filter((r) => r.captureId === captureId)
      .map((r) => ({ ...r }));
  }

  /** Cents of the capture held by COMPLETED and PENDING refunds. */
  refundedCents(captureId: string): number {
    let sum = 0;
    for (const r of this.#refunds.values()) {
      if (r.captureId === captureId && HOLDS.has(r.status)) sum += r.amountCents;
    }
    return sum;
  }

  /** `COMPLETED`, `PARTIALLY_REFUNDED` or `REFUNDED`, from COMPLETED refunds (as GET capture shows). */
  captureRefundStatus(captureId: string): 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' {
    const capture = this.#capture(captureId);
    const done = this.refundsOf(captureId)
      .filter((r) => r.status === 'COMPLETED')
      .reduce((s, r) => s + r.amountCents, 0);
    if (!capture || done === 0) return 'COMPLETED';
    return done >= capture.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }

  // ------------------------------------------------------------------ HTTP

  static route(method: string, path: string): { op: 'refund' | 'get_refund'; id: string } | null {
    let m: RegExpExecArray | null;
    if (method === 'POST' && (m = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path))) {
      return { op: 'refund', id: decodeURIComponent(m[1] ?? '') };
    }
    if (method === 'GET' && (m = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path))) {
      return { op: 'get_refund', id: decodeURIComponent(m[1] ?? '') };
    }
    return null;
  }

  handle(req: FakeRequest): Handled | null {
    const route = FakeRefunds.route(req.method, req.path);
    if (!route) return null;
    if (route.op === 'get_refund') {
      const r = this.#refunds.get(route.id);
      return r ? { http: 200, body: this.#body(r) } : notFound();
    }
    return this.#refund(route.id, req);
  }

  #capture(captureId: string): FakeCaptureInfo | undefined {
    return this.#captures.get(captureId) ?? this.#captureOf?.(captureId);
  }

  /**
   * One synchronous step from "check what's left" to "record the refund", so parallel refunds
   * against one capture can't both pass the cap (the event loop serialises them).
   */
  #refund(captureId: string, req: FakeRequest): Handled {
    const capture = this.#capture(captureId);
    if (!capture) return notFound();

    const replayKey = req.requestId ? `${captureId}:${req.requestId}` : null;
    const priorId = replayKey ? this.#byRequest.get(replayKey) : undefined;
    const prior = priorId ? this.#refunds.get(priorId) : undefined;
    // S9: same request id → 200 with the original refund, whatever the new body says.
    if (prior) return { http: 200, body: this.#body(prior) };

    const body = parseBody(req.rawBody);
    const remaining = capture.amountCents - this.refundedCents(captureId);
    let cents = remaining;
    if (body.amount !== undefined) {
      const amount = obj(body.amount);
      if (typeof amount.value !== 'string') {
        return fakeError(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER');
      }
      if (amount.currency_code !== undefined && amount.currency_code !== 'USD') {
        return fakeError(422, 'UNPROCESSABLE_ENTITY', 'CURRENCY_MISMATCH');
      }
      try {
        cents = decimalToCents(amount.value);
      } catch {
        return fakeError(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE');
      }
      if (cents <= 0) return fakeError(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE');
    }
    if (remaining <= 0) {
      return fakeError(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_FULLY_REFUNDED');
    }
    if (cents > remaining) {
      return fakeError(422, 'UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED', EXCEEDED_TEXT);
    }

    const now = this.#now().toISOString();
    const status: FakeRefundStatus = this.#pendingNext > 0 ? 'PENDING' : 'COMPLETED';
    if (this.#pendingNext > 0) this.#pendingNext--;
    const refund: FakeRefund = {
      id: this.#id('RF'),
      captureId,
      amountCents: cents,
      status,
      requestId: req.requestId,
      noteToPayer: typeof body.note_to_payer === 'string' ? body.note_to_payer : null,
      createTime: now,
      updateTime: now,
    };
    this.#refunds.set(refund.id, refund);
    if (replayKey) this.#byRequest.set(replayKey, refund.id);
    return { http: 201, body: this.#body(refund) };
  }

  #settle(refundId: string, to: 'COMPLETED' | 'FAILED'): void {
    const r = this.#refunds.get(refundId);
    if (!r) throw new Error(`fake: no refund ${refundId}`);
    if (r.status !== 'PENDING')
      throw new Error(`fake: refund ${refundId} is ${r.status}, not PENDING`);
    r.status = to;
    r.updateTime = this.#now().toISOString();
  }

  #body(r: FakeRefund) {
    return {
      id: r.id,
      status: r.status,
      ...(r.status === 'PENDING' ? { status_details: { reason: 'ECHECK' } } : {}),
      amount: { currency_code: 'USD', value: centsToDecimal(r.amountCents) },
      ...(r.noteToPayer ? { note_to_payer: r.noteToPayer } : {}),
      create_time: r.createTime,
      update_time: r.updateTime,
      links: [
        { rel: 'self', method: 'GET', href: `${FAKE_PAYPAL_BASE}/v2/payments/refunds/${r.id}` },
        {
          rel: 'up',
          method: 'GET',
          href: `${FAKE_PAYPAL_BASE}/v2/payments/captures/${r.captureId}`,
        },
      ],
    };
  }
}
