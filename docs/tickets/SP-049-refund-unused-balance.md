# SP-049: Refund unused balance via PayPal Refunds (sweep, poll, locked slicing)

- **Priority:** P1 (spec P1 #3)
- **Wave:** 4
- **Estimate:** 2
- **Depends on:** SP-018a, SP-001c, SP-003
- **Spec refs:** features/10 §Refund of unused balance; api.md §`POST /api/buyer/refunds`; data-model.md §balance_refunds, §Postings (REFUND), rule 5

## Goal
A buyer cashes out unused balance to their original PayPal payment.

## Files / modules
`apps/api/src/refunds/refund.ts`, route `POST /api/buyer/refunds`, `GET /api/buyer/refunds`.

## Scope
- Allowed = `min(floor balance cents, Σ over COMPLETED top-ups ≤ 180 days of (amount − refunded))`; split newest first.
- Per slice: insert `balance_refunds` (id = `PayPal-Request-Id`), `ledger.post(REFUND, key 'refund:'+id)` **before** the PayPal call, then `pp.refundCapture`; COMPLETED → `topups.refunded_cents += amount`, top-up PARTIALLY_REFUNDED; PENDING → wait for webhook/poll; definite 4xx → reversal txn `refund_reversal:<id>`, FAILED with reason.
- Full cash-out disables auto top-up. Over the cap → 422 `REFUND_EXCEEDS_UNUSED` with explanation (e.g. balance came from credits).
- **Locked slicing:** lock the buyer's source `topups` rows `FOR UPDATE` (ordered by id) and compute refundable per capture as `amount − Σ(balance_refunds in REQUESTED, PENDING, COMPLETED)`, not just `refunded_cents`, so two parallel requests can't slice the same capture.
- Request-level `Idempotency-Key` stored on `balance_refunds` (SP-002 column).
- **Recovery sweep** (`refund-sweep.job.ts`, every 60 s): `REQUESTED` older than 1 min → replay `refundCapture` with the same request id; `PENDING` → `pp.getRefund` (SP-001c) until COMPLETED / FAILED; FAILED → `REFUND_REVERSAL` txn (key `refund_reversal:<id>`, SP-002 kind).
- Registers the `PAYMENT.CAPTURE.REFUNDED` handler as `webhooks/handlers/refunds.ts` for SP-059's dispatcher.

## Acceptance criteria
- [ ] Refund $7.40 of a $20 top-up: refund id stored, balance −$7.40, top-up PARTIALLY_REFUNDED (sandbox, S9).
- [ ] Ledger check passes after refunds and a failed refund.
- [ ] Crash between the REFUND ledger post and the PayPal call → the sweep completes the refund once (same request id).
- [ ] A `PENDING` refund is resolved by polling with no webhook.

## Race / idempotency tests (FakePayPal)
- Double-click (same Idempotency-Key) → one refund.
- Response lost after the refund happened → retry with the same request id → same refund id, one REFUND txn.
- Two parallel refunds whose sum exceeds the refundable amount → one succeeds, the other 422; balance never negative.

## Test plan
Integration (FakePayPal); sandbox once.
