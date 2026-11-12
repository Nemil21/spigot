import { centsToDecimal, decimalToCents, obj } from '../transport.js';
import {
  FAKE_PAYPAL_BASE,
  fakeDebugId,
  makeIdFactory,
  notFound,
  parseBody,
  fakeError,
  type FakeRequest,
  type Handled,
} from './http.js';

/**
 * Fake PayPal Payouts v1, matching SP-003 S10 and Holdfast S7:
 * - POST → 201 `PENDING`. Batch GETs move it `PENDING` → `PROCESSING` → `SUCCESS`. Items end
 *   `SUCCESS`, or `UNCLAIMED` (`RECEIVER_UNREGISTERED`) for an unregistered email, and the batch is
 *   still `SUCCESS`. $0.25 `payout_item_fee` per item.
 * - A `sender_batch_id` that was already used → 400 `USER_BUSINESS_ERROR` with no
 *   `payout_batch_id`, **whatever the `PayPal-Request-Id`** (PayPal never replays a payout).
 * - Above `balanceCents` → 422 `INSUFFICIENT_FUNDS`, no batch.
 * - To `merchantEmail` (paying ourselves) → item `FAILED` `SELF_PAY_NOT_ALLOWED`; if every item
 *   fails, the batch is `DENIED`.
 */

export type FakePayoutItemStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'UNCLAIMED'
  | 'FAILED'
  | 'RETURNED'
  | 'BLOCKED'
  | 'DENIED'
  | 'REFUNDED'
  | 'ONHOLD';

export interface FakePayoutItem {
  id: string;
  batchId: string;
  senderItemId: string | null;
  receiver: string;
  amountCents: number;
  note: string | null;
  status: FakePayoutItemStatus;
  errorName: string | null;
  /** What it settles to when the batch settles. */
  outcome: { status: FakePayoutItemStatus; errorName: string | null };
}

export interface FakePayoutBatch {
  id: string;
  senderBatchId: string;
  emailSubject: string | null;
  status: string;
  createTime: string;
  itemIds: string[];
  gets: number;
}

export interface FakePayoutsOptions {
  /** Payable balance; a batch above it is `422 INSUFFICIENT_FUNDS`. Default unlimited. */
  balanceCents?: number;
  /** The merchant's own email: items to it fail `SELF_PAY_NOT_ALLOWED`. */
  merchantEmail?: string;
  /** Emails with no PayPal account: their items end `UNCLAIMED`. */
  unregisteredEmails?: Iterable<string>;
  /** Batch GETs before a PENDING batch settles (the first GETs see PENDING, then PROCESSING). */
  settlesAfterGets?: number;
  /** Fee per item. Default 25 (S10). */
  feeCents?: number;
  now?: () => Date;
}

const DUPLICATE_ISSUE = 'Batch with given sender_batch_id already exists';
const ERRORS_LINK = 'https://developer.paypal.com/docs/api/payments.payouts-batch/#errors';
/** Items whose money went back to the sender. */
const MONEY_BACK = new Set<FakePayoutItemStatus>([
  'FAILED',
  'RETURNED',
  'BLOCKED',
  'DENIED',
  'REFUNDED',
]);

export class FakePayouts {
  balanceCents: number;
  merchantEmail: string | undefined;
  readonly unregisteredEmails: Set<string>;
  settlesAfterGets: number;
  feeCents: number;
  /** Batches PayPal actually created (a duplicate or refused POST doesn't count). */
  batchesCreated = 0;

  readonly #now: () => Date;
  readonly #id = makeIdFactory();
  readonly #batches = new Map<string, FakePayoutBatch>();
  readonly #bySender = new Map<string, string>();
  readonly #items = new Map<string, FakePayoutItem>();
  #insufficientNext = 0;

  constructor(opts: FakePayoutsOptions = {}) {
    this.balanceCents = opts.balanceCents ?? Number.MAX_SAFE_INTEGER;
    this.merchantEmail = opts.merchantEmail?.toLowerCase();
    this.unregisteredEmails = new Set(
      [...(opts.unregisteredEmails ?? [])].map((e) => e.toLowerCase()),
    );
    this.settlesAfterGets = opts.settlesAfterGets ?? 2;
    this.feeCents = opts.feeCents ?? 25;
    this.#now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ test controls

  /** The next `times` POSTs answer `422 INSUFFICIENT_FUNDS` whatever the balance. */
  insufficientFundsNext(times = 1): this {
    this.#insufficientNext += times;
    return this;
  }

  /** Settle the batch now (as if PayPal finished processing). */
  settleBatch(payoutBatchId: string): void {
    const batch = this.#batch(payoutBatchId);
    if (batch.status !== 'PENDING' && batch.status !== 'PROCESSING') return;
    for (const id of batch.itemIds) {
      const item = this.#items.get(id)!;
      if (item.status === 'PENDING')
        this.#setItem(item, item.outcome.status, item.outcome.errorName);
    }
    this.#refreshBatch(batch, true);
  }

  /** The receiver signed up and claimed: `UNCLAIMED → SUCCESS`. */
  claimPayout(itemId: string): void {
    const item = this.#unclaimed(itemId);
    this.#setItem(item, 'SUCCESS', null);
  }

  /** Unclaimed for 30 days: `UNCLAIMED → RETURNED` (the money comes back to the merchant). */
  returnPayout(itemId: string): void {
    const item = this.#unclaimed(itemId);
    this.#setItem(item, 'RETURNED', 'RECEIVER_UNREGISTERED');
  }

  /** Force any item status (e.g. `BLOCKED`, `FAILED`) for tests. */
  setItemStatus(
    itemId: string,
    status: FakePayoutItemStatus,
    errorName: string | null = null,
  ): void {
    const item = this.#items.get(itemId);
    if (!item) throw new Error(`fake: no payout item ${itemId}`);
    this.#setItem(item, status, errorName);
    this.#refreshBatch(this.#batch(item.batchId), false);
  }

  batch(payoutBatchId: string): Readonly<FakePayoutBatch> | undefined {
    const b = this.#batches.get(payoutBatchId);
    return b && { ...b, itemIds: [...b.itemIds] };
  }

  batchBySenderId(senderBatchId: string): Readonly<FakePayoutBatch> | undefined {
    const id = this.#bySender.get(senderBatchId);
    return id ? this.batch(id) : undefined;
  }

  item(itemId: string): Readonly<FakePayoutItem> | undefined {
    const i = this.#items.get(itemId);
    return i && { ...i, outcome: { ...i.outcome } };
  }

  itemsOf(payoutBatchId: string): Readonly<FakePayoutItem>[] {
    return (this.#batches.get(payoutBatchId)?.itemIds ?? []).map((id) => this.item(id)!);
  }

  // ------------------------------------------------------------------ HTTP

  static route(
    method: string,
    path: string,
  ): { op: 'payout' | 'get_payout_batch' | 'get_payout_item'; id: string } | null {
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/v1/payments/payouts') return { op: 'payout', id: '' };
    if (method === 'GET' && (m = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(path))) {
      return { op: 'get_payout_batch', id: decodeURIComponent(m[1] ?? '') };
    }
    if (method === 'GET' && (m = /^\/v1\/payments\/payouts-item\/([^/]+)$/.exec(path))) {
      return { op: 'get_payout_item', id: decodeURIComponent(m[1] ?? '') };
    }
    return null;
  }

  handle(req: FakeRequest): Handled | null {
    const route = FakePayouts.route(req.method, req.path);
    if (!route) return null;
    switch (route.op) {
      case 'payout':
        return this.#create(parseBody(req.rawBody));
      case 'get_payout_batch': {
        const batch = this.#batches.get(route.id);
        if (!batch) return notFound();
        this.#tick(batch);
        return { http: 200, body: this.#batchBody(batch) };
      }
      case 'get_payout_item': {
        const item = this.#items.get(route.id);
        return item ? { http: 200, body: this.#itemBody(item) } : notFound();
      }
    }
  }

  /** Validate, check the duplicate and the balance, then create: one synchronous step. */
  #create(body: Record<string, unknown>): Handled {
    const header = obj(body.sender_batch_header);
    const senderBatchId = typeof header.sender_batch_id === 'string' ? header.sender_batch_id : '';
    const rawItems = Array.isArray(body.items) ? body.items.map(obj) : [];
    if (!senderBatchId || rawItems.length === 0) {
      return fakeError(
        400,
        'VALIDATION_ERROR',
        'MISSING_REQUIRED_PARAMETER',
        'Invalid request - see details.',
      );
    }
    const items: {
      receiver: string;
      cents: number;
      note: string | null;
      senderItemId: string | null;
    }[] = [];
    for (const raw of rawItems) {
      const amount = obj(raw.amount);
      let cents: number;
      try {
        cents = typeof amount.value === 'string' ? decimalToCents(amount.value) : NaN;
      } catch {
        cents = NaN;
      }
      if (
        typeof raw.receiver !== 'string' ||
        !raw.receiver ||
        !(cents > 0) ||
        amount.currency !== 'USD'
      ) {
        return fakeError(
          400,
          'VALIDATION_ERROR',
          'INVALID_PARAMETER_VALUE',
          'Invalid request - see details.',
        );
      }
      items.push({
        receiver: raw.receiver,
        cents,
        note: typeof raw.note === 'string' ? raw.note : null,
        senderItemId: typeof raw.sender_item_id === 'string' ? raw.sender_item_id : null,
      });
    }

    // S10: a used sender_batch_id is refused even with the same PayPal-Request-Id.
    if (this.#bySender.has(senderBatchId)) {
      return {
        http: 400,
        body: {
          name: 'USER_BUSINESS_ERROR',
          message: 'User business error.',
          debug_id: fakeDebugId(),
          information_link: ERRORS_LINK,
          details: [{ field: 'SENDER_BATCH_ID', location: 'body', issue: DUPLICATE_ISSUE }],
          links: [],
        },
      };
    }

    const total = items.reduce((s, i) => s + i.cents, 0);
    if (this.#insufficientNext > 0 || total > this.balanceCents) {
      if (this.#insufficientNext > 0) this.#insufficientNext--;
      return {
        http: 422,
        body: {
          name: 'INSUFFICIENT_FUNDS',
          message: 'Sender does not have sufficient funds. Please add funds and retry.',
          debug_id: fakeDebugId(),
          information_link: ERRORS_LINK,
          links: [],
        },
      };
    }

    this.balanceCents -= total;
    this.batchesCreated++;
    const batch: FakePayoutBatch = {
      id: this.#id('B'),
      senderBatchId,
      emailSubject: typeof header.email_subject === 'string' ? header.email_subject : null,
      status: 'PENDING',
      createTime: this.#now().toISOString(),
      itemIds: [],
      gets: 0,
    };
    for (const i of items) {
      const email = i.receiver.toLowerCase();
      const outcome: FakePayoutItem['outcome'] =
        this.merchantEmail && email === this.merchantEmail
          ? { status: 'FAILED', errorName: 'SELF_PAY_NOT_ALLOWED' }
          : this.unregisteredEmails.has(email)
            ? { status: 'UNCLAIMED', errorName: 'RECEIVER_UNREGISTERED' }
            : { status: 'SUCCESS', errorName: null };
      const item: FakePayoutItem = {
        id: this.#id('I'),
        batchId: batch.id,
        senderItemId: i.senderItemId,
        receiver: i.receiver,
        amountCents: i.cents,
        note: i.note,
        status: 'PENDING',
        errorName: null,
        outcome,
      };
      this.#items.set(item.id, item);
      batch.itemIds.push(item.id);
    }
    this.#batches.set(batch.id, batch);
    this.#bySender.set(senderBatchId, batch.id);
    return {
      http: 201,
      body: {
        batch_header: {
          payout_batch_id: batch.id,
          batch_status: 'PENDING',
          sender_batch_header: {
            sender_batch_id: senderBatchId,
            ...(batch.emailSubject ? { email_subject: batch.emailSubject } : {}),
          },
        },
        links: [
          {
            rel: 'self',
            method: 'GET',
            href: `${FAKE_PAYPAL_BASE}/v1/payments/payouts/${batch.id}`,
          },
        ],
      },
    };
  }

  /** One GET: PENDING for the first gets, PROCESSING, then settled after `settlesAfterGets`. */
  #tick(batch: FakePayoutBatch): void {
    if (batch.status !== 'PENDING' && batch.status !== 'PROCESSING') return;
    batch.gets++;
    if (batch.gets > this.settlesAfterGets) this.settleBatch(batch.id);
    else if (batch.gets === this.settlesAfterGets) batch.status = 'PROCESSING';
  }

  #batch(id: string): FakePayoutBatch {
    const b = this.#batches.get(id);
    if (!b) throw new Error(`fake: no payout batch ${id}`);
    return b;
  }

  #unclaimed(itemId: string): FakePayoutItem {
    const item = this.#items.get(itemId);
    if (!item) throw new Error(`fake: no payout item ${itemId}`);
    if (item.status !== 'UNCLAIMED') {
      throw new Error(`fake: payout item ${itemId} is ${item.status}, not UNCLAIMED`);
    }
    return item;
  }

  #setItem(item: FakePayoutItem, status: FakePayoutItemStatus, errorName: string | null): void {
    const wasBack = MONEY_BACK.has(item.status);
    const isBack = MONEY_BACK.has(status);
    if (!wasBack && isBack) this.balanceCents += item.amountCents;
    if (wasBack && !isBack) this.balanceCents -= item.amountCents;
    item.status = status;
    item.errorName = errorName;
  }

  /** S10: a settled batch is SUCCESS even with UNCLAIMED items; DENIED only if every item failed. */
  #refreshBatch(batch: FakePayoutBatch, settling: boolean): void {
    const items = batch.itemIds.map((id) => this.#items.get(id)!);
    if (!settling && items.some((i) => i.status === 'PENDING')) return;
    batch.status = items.every((i) => MONEY_BACK.has(i.status) && i.status !== 'RETURNED')
      ? 'DENIED'
      : 'SUCCESS';
  }

  #itemFee(item: FakePayoutItem): number {
    return item.status === 'PENDING' ||
      item.status === 'SUCCESS' ||
      item.status === 'UNCLAIMED' ||
      item.status === 'RETURNED'
      ? this.feeCents
      : 0;
  }

  #itemBody(item: FakePayoutItem) {
    const money = (cents: number) => ({ currency: 'USD', value: centsToDecimal(cents) });
    return {
      payout_item_id: item.id,
      ...(item.status === 'SUCCESS' ? { transaction_id: `T${item.id}` } : {}),
      transaction_status: item.status,
      payout_item_fee: money(this.#itemFee(item)),
      payout_batch_id: item.batchId,
      payout_item: {
        recipient_type: 'EMAIL',
        amount: money(item.amountCents),
        ...(item.note ? { note: item.note } : {}),
        receiver: item.receiver,
        ...(item.senderItemId ? { sender_item_id: item.senderItemId } : {}),
      },
      ...(item.errorName ? { errors: { name: item.errorName, message: item.errorName } } : {}),
      links: [
        {
          rel: 'item',
          method: 'GET',
          href: `${FAKE_PAYPAL_BASE}/v1/payments/payouts-item/${item.id}`,
        },
      ],
    };
  }

  #batchBody(batch: FakePayoutBatch) {
    const items = batch.itemIds.map((id) => this.#items.get(id)!);
    const money = (cents: number) => ({ currency: 'USD', value: centsToDecimal(cents) });
    return {
      batch_header: {
        payout_batch_id: batch.id,
        batch_status: batch.status,
        time_created: batch.createTime,
        sender_batch_header: {
          sender_batch_id: batch.senderBatchId,
          ...(batch.emailSubject ? { email_subject: batch.emailSubject } : {}),
        },
        amount: money(items.reduce((s, i) => s + i.amountCents, 0)),
        fees: money(items.reduce((s, i) => s + this.#itemFee(i), 0)),
      },
      items: items.map((i) => this.#itemBody(i)),
      links: [
        { rel: 'self', method: 'GET', href: `${FAKE_PAYPAL_BASE}/v1/payments/payouts/${batch.id}` },
      ],
    };
  }
}
