/** A `topups` row as the top-up code reads it (data-model §topups). */
export interface TopupRow {
  id: string;
  buyerId: string;
  amountCents: number;
  currency: string;
  method: 'PAYPAL_WALLET' | 'CARD' | 'VAULT_MIT' | null;
  trigger: 'MANUAL' | 'AUTO' | 'MCP' | 'SIM';
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  status:
    | 'CREATED'
    | 'AWAITING_APPROVAL'
    | 'COMPLETED'
    | 'PARTIALLY_REFUNDED'
    | 'REFUNDED'
    | 'FAILED'
    | 'ABANDONED';
  ledgerTxnId: string | null;
  errorCode: string | null;
  idempotencyKey: string | null;
  pendingReason: string | null;
  paypalFeeCents: number | null;
  needsReconcile: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const TOPUP_COLUMNS = `id, buyer_id AS "buyerId", amount_cents AS "amountCents", currency, method,
  trigger, paypal_order_id AS "paypalOrderId", paypal_capture_id AS "paypalCaptureId", status,
  ledger_txn_id AS "ledgerTxnId", error_code AS "errorCode", idempotency_key AS "idempotencyKey",
  pending_reason AS "pendingReason", paypal_fee_cents AS "paypalFeeCents",
  needs_reconcile AS "needsReconcile", created_at AS "createdAt", updated_at AS "updatedAt"`;

/** The public view of a top-up (W11's table, `GET /api/buyer/topups`). */
export function topupView(t: TopupRow) {
  return {
    topupId: t.id,
    amountCents: t.amountCents,
    currency: t.currency,
    method: t.method,
    trigger: t.trigger,
    status: t.status,
    orderId: t.paypalOrderId,
    captureId: t.paypalCaptureId,
    errorCode: t.errorCode,
    pendingReason: t.pendingReason,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
