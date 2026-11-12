# SP-001c: PayPal refunds, payouts and webhook verify + FakePayPal statuses and `emitWebhook`

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a
- **Soft deps (build against, verify on merge):** SP-003
- **Spec refs:** api.md §PayPal calls used (refundCapture, payout, getPayoutBatch, verifyWebhook); README §New PayPal spikes S9–S11; spikes/s7-results.md

## Goal
The rest of the PayPal surface (refunds, payouts, webhook verify) and the fake behaviour the payout, refund and webhook tickets test against.

## Files / modules
New files only (SP-001b owns the shared ones): `apps/api/src/paypal/refunds.ts`, `payouts.ts`, `webhooks.ts`, `fake/refunds.ts`, `fake/payouts.ts`, `fake/webhooks.ts`, and their contract tests. Registration in `paypal/index.ts` is a one-line export each (rebase on SP-001b if it merged first).

## Scope
- `pp.refundCapture(captureId, amountCents, refundId)` and `pp.getRefund(refundId)` (`GET /v2/payments/refunds/{id}`; SP-049's PENDING poll).
- `pp.payout({batchId, items[]})` and `pp.getPayoutBatch(payoutBatchId)`; normalised item statuses and `payout_item_fee`.
- `pp.verifyWebhook(headers, rawBody)`: verify against the **raw request body** string, never re-serialised JSON.
- Fake: partial refunds with a cumulative cap and replay by request id, refund `PENDING → COMPLETED` helper; payout batches with item statuses `SUCCESS`, `UNCLAIMED`, `FAILED`, `RETURNED` and helpers `fake.claimPayout(itemId)` (UNCLAIMED → SUCCESS) and `fake.returnPayout(itemId)` (UNCLAIMED → RETURNED); duplicate `sender_batch_id` error with the body S10 records; `INSUFFICIENT_FUNDS` and `SELF_PAY_NOT_ALLOWED` injection; `fake.emitWebhook(type, resource)` producing a signed event the fake verifier accepts.

## Acceptance criteria
- [ ] Payout `422 INSUFFICIENT_FUNDS` maps to a distinct `PayPalInsufficientFunds` error (no batch created).
- [ ] Duplicate `sender_batch_id` maps to `PayPalDuplicateBatch` with whatever ids PayPal returns (possibly none).
- [ ] Refund replay with the same id → one refund; refunds over the captured amount → 422.
- [ ] A webhook verified from the raw body passes; the same payload re-serialised with different spacing fails in the fake exactly as the sandbox would.

## Race / idempotency tests (FakePayPal)
- Two parallel refunds with different ids whose sum exceeds the capture → one succeeds, one 422.
- Payout response lost after PayPal accepted the batch → retry with the same `sender_batch_id` → duplicate error, no second payout.

## Test plan
Unit + contract (fake in CI, sandbox locally once).

## Notes & risks
Soft dependency on SP-003 (S9, S10): align the fake with the recorded duplicate-batch and refund replay bodies when they land.
