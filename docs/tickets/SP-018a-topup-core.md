# SP-018a: Top-up core: wallet order, capture, `creditTopup` (amount check), return URL

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1.5
- **Depends on:** SP-001b, SP-005, SP-007a
- **Spec refs:** features/08-paypal-topup-vault.md §Manual top-up, §Edge cases; api.md §`POST /api/buyer/topups`, §capture, §`GET /topups/return`; data-model.md §topups, §Top-up state machine, rules 5–6

## Goal
A buyer funds a prepaid balance through PayPal, credited exactly once no matter how many paths see the completed capture.

## Files / modules
`apps/api/src/topups/` — `createTopup.ts`, `capture.ts`, `creditTopup.ts`, `returnHandler.ts` (SIM card top-ups and agent approval links are SP-018b); routes `POST /api/buyer/topups`, `POST /api/buyer/topups/:id/capture`, `GET /topups/return`, `GET /api/buyer/topups`.

## Scope
- `POST /api/buyer/topups {amountCents 500–50000, method: 'PAYPAL_WALLET', saveForAutoTopup}` (Idempotency-Key required) → insert `topups` CREATED (`id` = `PayPal-Request-Id`) → `pp.createTopupOrder` wallet source (+ vault attributes if `saveForAutoTopup`) → `AWAITING_APPROVAL` + `orderId` (+ `approveUrl`). Double click with the same key → same top-up.
- `POST /api/buyer/topups/:id/capture` → `pp.captureOrder(orderId, 'capture:'+id)` → `COMPLETED` → `creditTopup`. Capture `PENDING` → stays AWAITING_APPROVAL with `pending_reason`, no credit.
- `creditTopup(topupId, {captureId, vault})` in one transaction: `transition(CREATED|AWAITING_APPROVAL → COMPLETED)` storing `paypal_capture_id`; `ledger.post(TOPUP, key 'topup:'+id)`; save `buyers.vault_id/vault_kind` if returned; audit `TOPUP_COMPLETED` with order + capture ids; loser of any race does nothing.
- `GET /topups/return?token=` → find by order id → capture → `creditTopup` → 302 `/buyers/topup/:id?ok=1`; cancel URL → leaves AWAITING_APPROVAL.
- Declines (`INSTRUMENT_DECLINED` etc.) → FAILED with `error_code`, 422 `TOPUP_FAILED`, audit `TOPUP_FAILED`.
- **Idempotency key is stored:** `topups.idempotency_key` with `unique(buyer_id, idempotency_key)`; a double click returns the same top-up row (SP-002 column).
- **Credit only what PayPal captured:** `creditTopup` (called by the capture endpoint, the return handler, SP-019's poller and SP-059's webhook via `custom_id`) reads the capture's amount and currency and asserts `USD` and `amount = topups.amount_cents`. A mismatch sets `needs_reconcile`, writes an alert audit row and credits nothing. It also stores `paypal_fee_cents` from `seller_receivable_breakdown.paypal_fee`.
- `creditTopup` accepts `CREATED | AWAITING_APPROVAL | ABANDONED → COMPLETED` (a capture or webhook that arrives after SP-019's sweep still credits).
- Wallet vault attributes for `saveForAutoTopup` are sent only when `PAYPAL_WALLET_VAULT=on` (set from SP-003's S8b result); otherwise the box is hidden and auto top-up uses a card vault.
- Tenancy: the capture endpoint checks the signed-in buyer owns the top-up (404 otherwise); add `security/tenancy/topups.cases.ts`.

## Acceptance criteria
- [ ] Sandbox: a Personal account tops up $20 via approval + capture; balance $20.00; one TOPUP txn; ids in audit.
- [ ] Replaying capture endpoint, return handler and (SP-019) poller for the same top-up credits once.
- [ ] Capture `PENDING` → no credit.
- [ ] Declined → FAILED, no ledger txn, 422.
- [ ] A capture whose amount differs from the top-up (fake) → `needs_reconcile`, no credit.
- [ ] Buyer B calling capture on buyer A's top-up → 404, nothing captured.
- [ ] A top-up already ABANDONED by the sweep, then captured → credited once.

## Race / idempotency tests (FakePayPal)
- Capture endpoint ×5 + return handler ×5 in parallel for one approved order → one capture call result, one TOPUP txn, balance +$20 once.
- Response lost after capture (fault injection) → retry with `capture:<id>` → same capture id, credited once.

## Test plan
Integration (FakePayPal) in CI; sandbox once by hand (wallet approval in the browser) with ids pasted in the PR.

## Notes & risks
- If SP-003 S7b (wallet) fails, the W11 path falls back to card fields (SP-063, P1) and the demo uses the server-side card for SIM only; say so in the README.
- PayPal fees (~3.49% + $0.49) are ours in sandbox; minimum top-up $5.
