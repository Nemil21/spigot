import type { ErrorClass } from './errors.js';

/** Published PayPal sandbox test card. Raw card data only on the server-side SIM path. */
export interface TestCard {
  number: string;
  /** `YYYY-MM`. */
  expiry: string;
  security_code: string;
  name: string;
}

/**
 * How a top-up is paid (api.md `pp.createTopupOrder`). Request bodies follow Holdfast S1/S2/S7
 * and SP-003 S7/S8 for CAPTURE intent.
 * - `wallet`: PayPal approval redirect (`rel=payer-action`), then `captureOrder`. `vault: true`
 *   adds `store_in_vault: ON_SUCCESS` (MERCHANT / CONSUMER); callers gate it on
 *   `PAYPAL_WALLET_VAULT`.
 * - `none`: no `payment_source` (JS SDK v6 buttons approve it in the browser), then `captureOrder`.
 * - `card`: raw test card, captured at create, vaulted `ON_SUCCESS` unless `vault: false`.
 *   Server-side SIM top-ups only; refused unless the client allows raw cards (sandbox / stub).
 * - `card_vault`: merchant-initiated charge on a vaulted card, no buyer present (auto top-up):
 *   `stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT}`. Captured at create.
 * - `wallet_vault`: charge on a vaulted PayPal wallet (`paypal.vault_id`). Captured at create.
 */
export type TopupSource =
  | { kind: 'wallet'; returnUrl: string; cancelUrl: string; vault?: boolean; brandName?: string }
  | { kind: 'none' }
  | { kind: 'card'; card: TestCard; vault?: boolean }
  | { kind: 'card_vault'; vaultId: string }
  | { kind: 'wallet_vault'; vaultId: string };

/** Values allowed in `PayPal-Mock-Response` (sandbox demo aid). */
export type MockResponseCode = 'INSTRUMENT_DECLINED';

export interface CreateTopupOrderInput {
  /** `topups.id`: sent as `PayPal-Request-Id` and `custom_id`. Insert the row before calling. */
  topupId: string;
  amountCents: number;
  source: TopupSource;
  /**
   * Demo-only decline (SP-047b `demo:decline`). Sent only when the client allows mock responses
   * (sandbox base + `DEMO_MODE` + `ALLOW_MOCK_DECLINE`). Set it from server state, **never** from
   * request input.
   */
  mockResponse?: MockResponseCode | null;
}

export interface CaptureOrderOptions {
  /** Same rules as `CreateTopupOrderInput.mockResponse`. */
  mockResponse?: MockResponseCode | null;
}

/** A vaulted payment method PayPal returned (`payment_source.<kind>.attributes.vault`). */
export interface VaultRef {
  id: string;
  kind: 'card' | 'paypal';
  /** PayPal's vault customer id, when returned. */
  customerId: string | null;
}

/**
 * The normalised outcome of `createTopupOrder`, `captureOrder` and `topupResultOf(getOrder(…))`.
 * Judged by the response **body** (the capture's status), never by the HTTP code alone.
 * - `COMPLETED`: money captured. `feeCents` is `seller_receivable_breakdown.paypal_fee`.
 *   `reconciled` = a 422 was resolved by GETting the order (e.g. captured earlier with another id).
 * - `PENDING`: capture exists but PayPal is holding it (`reason` from `status_details`). Credit
 *   only when a later GET or webhook shows COMPLETED.
 * - `AWAITING_APPROVAL`: no capture yet; send the buyer to `approveUrl` (`rel=payer-action`, else
 *   `rel=approve`). `orderStatus` APPROVED means the buyer is done and `captureOrder` is due.
 * - `DECLINED`: a definite no (TERMINAL). Safe to mark the top-up FAILED.
 * - `NEEDS_RECONCILE`: unknown. `TRANSIENT` → retry with the same ids; `RECONCILE` → mark
 *   `needs_reconcile` and resolve from our own row / a GET (e.g. raw-card create replay, S7).
 */
export type TopupResult =
  | {
      status: 'COMPLETED';
      orderId: string;
      captureId: string;
      amountCents: number | null;
      feeCents: number | null;
      vault: VaultRef | null;
      customId: string | null;
      reconciled: boolean;
    }
  | {
      status: 'PENDING';
      orderId: string;
      captureId: string;
      amountCents: number | null;
      reason: string | null;
      vault: VaultRef | null;
      customId: string | null;
    }
  | {
      status: 'AWAITING_APPROVAL';
      orderId: string;
      approveUrl: string | null;
      orderStatus: string;
    }
  | {
      status: 'DECLINED';
      orderId: string | null;
      captureId: string | null;
      code: string;
      http: number;
      errorClass: 'TERMINAL';
    }
  | {
      status: 'NEEDS_RECONCILE';
      orderId: string | null;
      code: string;
      http: number;
      errorClass: 'TRANSIENT' | 'RECONCILE';
    };

export type TopupStatus = TopupResult['status'];

export interface CaptureView {
  id: string;
  status: string;
  amountCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  /** `status_details.reason` (PENDING / DECLINED captures). */
  reason: string | null;
  customId: string | null;
}

/** `GET /v2/checkout/orders/{id}`, read defensively. */
export interface OrderView {
  id: string;
  status: string;
  intent: string | null;
  amountCents: number | null;
  customId: string | null;
  approveUrl: string | null;
  captures: CaptureView[];
  vault: VaultRef | null;
}

/**
 * The order calls of the PayPal client. `PayPalRestClient` (client.ts) implements them and binds
 * SP-001c's refunds / payouts / webhook verify (`MoneyOutClient`) on the same transport.
 */
export interface PayPalOrdersClient {
  /** `POST /v2/checkout/orders`, `intent: CAPTURE`, `PayPal-Request-Id: topupId`. */
  createTopupOrder(input: CreateTopupOrderInput): Promise<TopupResult>;
  /** `POST /v2/checkout/orders/{id}/capture`, `PayPal-Request-Id: capture:<topupId>`. */
  captureOrder(orderId: string, topupId: string, opts?: CaptureOrderOptions): Promise<TopupResult>;
  /** `GET /v2/checkout/orders/{id}`. Throws `PayPalApiError` on failure. */
  getOrder(orderId: string): Promise<OrderView>;
}

export type { ErrorClass };
