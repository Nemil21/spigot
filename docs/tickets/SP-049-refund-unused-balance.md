# SP-049: Refund unused balance via PayPal Refunds

- **Priority:** P1 (spec P1 #3)
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-018
- **Spec refs:** features/10 §Refund of unused balance; api.md §`POST /api/buyer/refunds`; data-model.md §balance_refunds, §Postings (REFUND), rule 5

## Goal
A buyer cashes out unused balance to their original PayPal payment.

## Files / modules
`apps/api/src/refunds/refund.ts`, route `POST /api/buyer/refunds`, `GET /api/buyer/refunds`.

## Scope
- Allowed = `min(floor balance cents, Σ over COMPLETED top-ups ≤ 180 days of (amount − refunded))`; split newest first.
- Per slice: insert `balance_refunds` (id = `PayPal-Request-Id`), `ledger.post(REFUND, key 'refund:'+id)` **before** the PayPal call, then `pp.refundCapture`; COMPLETED → `topups.refunded_cents += amount`, top-up PARTIALLY_REFUNDED; PENDING → wait for webhook/poll; definite 4xx → reversal txn `refund_reversal:<id>`, FAILED with reason.
- Full cash-out disables auto top-up. Over the cap → 422 `REFUND_EXCEEDS_UNUSED` with explanation (e.g. balance came from credits).

## Acceptance criteria
- [ ] Refund $7.40 of a $20 top-up: refund id stored, balance −$7.40, top-up PARTIALLY_REFUNDED (sandbox, S9).
- [ ] Ledger check passes after refunds and a failed refund.

## Race / idempotency tests (FakePayPal)
- Double-click (same Idempotency-Key) → one refund.
- Response lost after the refund happened → retry with the same request id → same refund id, one REFUND txn.
- Two parallel refunds whose sum exceeds the refundable amount → one succeeds, the other 422; balance never negative.

## Test plan
Integration (FakePayPal); sandbox once.
