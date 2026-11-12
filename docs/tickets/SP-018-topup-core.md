# SP-018: Top-up core: wallet order, capture, `creditTopup`, card vault, return URL

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 2
- **Depends on:** SP-001b, SP-005, SP-007a
- **Spec refs:** features/08-paypal-topup-vault.md §Manual top-up, §Edge cases; api.md §`POST /api/buyer/topups`, §capture, §`GET /topups/return`; data-model.md §topups, §Top-up state machine, rules 5–6

## Goal
A buyer funds a prepaid balance through PayPal, credited exactly once no matter how many paths see the completed capture.

## Files / modules
`apps/api/src/topups/` — `createTopup.ts`, `capture.ts`, `creditTopup.ts`, `returnHandler.ts`, `serverCardTopup.ts` (SIM only); routes `POST /api/buyer/topups`, `POST /api/buyer/topups/:id/capture`, `GET /topups/return`, `GET /api/buyer/topups`.

## Scope
- `POST /api/buyer/topups {amountCents 500–50000, method: 'PAYPAL_WALLET', saveForAutoTopup}` (Idempotency-Key required) → insert `topups` CREATED (`id` = `PayPal-Request-Id`) → `pp.createTopupOrder` wallet source (+ vault attributes if `saveForAutoTopup`) → `AWAITING_APPROVAL` + `orderId` (+ `approveUrl`). Double click with the same key → same top-up.
- `POST /api/buyer/topups/:id/capture` → `pp.captureOrder(orderId, 'capture:'+id)` → `COMPLETED` → `creditTopup`. Capture `PENDING` → stays AWAITING_APPROVAL with `pending_reason`, no credit.
- `creditTopup(topupId, {captureId, vault})` in one transaction: `transition(CREATED|AWAITING_APPROVAL → COMPLETED)` storing `paypal_capture_id`; `ledger.post(TOPUP, key 'topup:'+id)`; save `buyers.vault_id/vault_kind` if returned; audit `TOPUP_COMPLETED` with order + capture ids; loser of any race does nothing.
- `GET /topups/return?token=` → find by order id → capture → `creditTopup` → 302 `/buyers/topup/:id?ok=1`; cancel URL → leaves AWAITING_APPROVAL.
- Declines (`INSTRUMENT_DECLINED` etc.) → FAILED with `error_code`, 422 `TOPUP_FAILED`, audit `TOPUP_FAILED`.
- `serverCardTopup(buyerId, amount, trigger='SIM')`: raw sandbox test card, CAPTURE in create, vault ON_SUCCESS — **server-side only, never from request input**; used by SP-035.
- `createTopupForAgent(buyerId, amountCents)` (no vault yet) → wallet order returning `approveUrl` with return URL `/topups/return` (used by SP-022b).

## Acceptance criteria
- [ ] Sandbox: a Personal account tops up $20 via approval + capture; balance $20.00; one TOPUP txn; ids in audit.
- [ ] Replaying capture endpoint, return handler and (SP-019) poller for the same top-up credits once.
- [ ] Capture `PENDING` → no credit.
- [ ] Declined → FAILED, no ledger txn, 422.

## Race / idempotency tests (FakePayPal)
- Capture endpoint ×5 + return handler ×5 in parallel for one approved order → one capture call result, one TOPUP txn, balance +$20 once.
- Response lost after capture (fault injection) → retry with `capture:<id>` → same capture id, credited once.
- Raw-card SIM create that hits `TRANSACTION_REFUSED` on a replay → `needs_reconcile`, never a second top-up row; no blind retry (Holdfast S7: raw-card create isn't replay-safe).

## Test plan
Integration (FakePayPal) in CI; sandbox once by hand (wallet approval in the browser) with ids pasted in the PR.

## Notes & risks
- If SP-003 S7b (wallet) fails, the W11 path falls back to card fields (SP-063, P1) and the demo uses the server-side card for SIM only; say so in the README.
- PayPal fees (~3.49% + $0.49) are ours in sandbox; minimum top-up $5.
