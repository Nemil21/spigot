# SP-001b: PayPal client + FakePayPal core: token, errors, CAPTURE orders, wallet approve, vault

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a
- **Spec refs:** api.md §PayPal calls used; data-model.md §Locking and idempotency rule 5; README §Where PayPal shows up; spikes/s7-results.md §RECONCILE mapping
- **Holdfast reference (read-only):** `packages/core/src/paypal/` — `client.ts`, `errors.ts`, `fake.ts`, `ids.ts`, `orders.ts`, `payouts.ts`, `webhooks.ts`, `types.ts`, `test-harness.ts`, `fake.contract.test.ts`, `sandbox.contract.test.ts`, `race.test.ts`

## Goal
One PayPal client every money ticket uses, and an in-memory `FakePayPal` behind `PAYPAL_MODE=stub` that answers like the sandbox, so race and idempotency tests never need the network.

## Files / modules
`apps/api/src/paypal/`: `client.ts` (token cache until `expires_in − 60 s`, `PayPal-Request-Id` on every call, `Prefer: return=representation`, timeouts, typed errors), `errors.ts` (classify TRANSIENT / TERMINAL / RECONCILE), `orders.ts`, `types.ts`, `fake/core.ts` (orders, approve, capture, vault), `test-harness.ts` (shared contract suite), `index.ts` (`createPayPalClient(config)` picks sandbox or stub). SP-001c adds `refunds.ts`, `payouts.ts`, `webhooks.ts` and `fake/payouts.ts`, `fake/refunds.ts`, `fake/webhooks.ts` as new files, so the two tickets don't touch the same file.

## Scope
- Port Holdfast's client, error classes, fake and contract harness; rename `@holdfast/*` → `@spigot/*`; drop tracking and AUTHORIZE-only helpers that Spigot doesn't use.
- Spigot calls (api.md):
  - `pp.createTopupOrder({topupId, amountCents, source})` → `POST /v2/checkout/orders` `intent: CAPTURE`, `custom_id = topupId`, `PayPal-Request-Id = topupId`. Sources: `paypal` wallet with `experience_context{return_url, cancel_url, user_action: PAY_NOW}` (+ optional `attributes.vault{store_in_vault: ON_SUCCESS, usage_type: MERCHANT, customer_type: CONSUMER}`); `card` + `attributes.vault.store_in_vault: ON_SUCCESS` (server-side test card, SIM only); `card.vault_id` + `stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT}`; `paypal.vault_id`.
  - Result normaliser → `{status: 'COMPLETED' | 'AWAITING_APPROVAL' | 'PENDING' | 'DECLINED', orderId, captureId?, approveUrl?, vault?: {id, kind}}` (approve URL = `rel=payer-action` link).
  - `pp.captureOrder(orderId, topupId)` (`PayPal-Request-Id: capture:<topupId>`), `pp.getOrder(id)`.
  - Refunds, payouts and webhook verify are SP-001c.
  - Test hook: `PayPal-Mock-Response` header only when `ALLOW_MOCK_DECLINE=true` and the base is sandbox; never from request input.
- **FakePayPal additions** (Holdfast's fake is AUTHORIZE-centred): CAPTURE-intent orders (card source captures in create; wallet source → `PAYER_ACTION_REQUIRED` + approve link → `fake.approve(orderId)` test helper → capture), vault ids for card and wallet, capture `seller_receivable_breakdown.paypal_fee` (SP-018a stores it), capture `PENDING` injection.
- Replay behaviour must match the sandbox facts below; the contract suite runs against both fake and sandbox.

## Out of scope
Refunds, payouts, webhook verify (SP-001c). Top-up business logic (SP-018a), payout run (SP-020), webhook handling (SP-059).

## Acceptance criteria
- [ ] Contract suite passes on the fake in CI and on the sandbox locally (`PAYPAL_MODE=sandbox npx vitest run apps/api/src/paypal/sandbox.contract.test.ts`).
- [ ] Order create with `vault_id` or no source, replayed with the same request id, returns the same order (200).
- [ ] Raw-card order create replayed with the same request id → the client surfaces `422 TRANSACTION_REFUSED` as RECONCILE (`needs_reconcile`), **not** as a decline (Holdfast S7 step 3).
- [ ] Capture replay with the same `capture:<topupId>` id → same capture id.
- [ ] Mock `INSTRUMENT_DECLINED` maps to TERMINAL even when the body is empty (Holdfast S7: capture decline mock returned 403 with an empty body).
- [ ] Token is fetched once for 20 concurrent calls.

## Race / idempotency tests (FakePayPal)
- 20 parallel `createTopupOrder` with the same request id → one order.
- Fault injection: response lost after the capture happened → retry with the same id returns the original capture.

## Test plan
Unit (fake): every call, every error class. Contract (fake in CI, sandbox locally once). No live PayPal in CI.

## Notes & risks
- Sandbox facts carried over from Holdfast `spikes/s7-results.md`: raw-card create isn't replay-safe (our `topups` row is the dedupe); test cards that work at concurrency 20: Visa 4111…1111, Visa 4012…1881, MC 5555…4444, Amex 3714…8431 (4-digit CVV), Discover 6011…1117 — **don't use 5105…5100**; `GET /v1/reporting/balances` returns 403 (no reporting scope), so we can't read the merchant balance.
- **Soft dependency on SP-003** (not on the Depends on line, so this ticket isn't held back): when SP-003's S7/S8 results land, update the fake to match and note it in the PR; if this ticket has already merged, the update goes into SP-018a.
