# SP-047a: Auto top-up core: vault MIT inside `chargeAndRecord`, monthly cap, one in flight

- **Priority:** P1 (spec P1 #1)
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-016, SP-018
- **Spec refs:** features/08 §Auto top-up; features/07 §`chargeAndRecord` step 5; data-model.md rule 11; api.md §Response headers

## Goal
The agent keeps working when its balance runs out: Spigot charges the saved PayPal method within the human's cap.

## Files / modules
`apps/api/src/topups/autoTopup.ts`; hook into SP-016's `onInsufficient`.

## Scope
- On `InsufficientBalance`: ROLLBACK the call transaction; outside it: `SELECT … FROM buyers FOR UPDATE`; require `auto_topup_enabled`, `vault_id`, no AUTO top-up CREATED in flight, `month_auto_sum + amount ≤ monthly_topup_cap_cents`, `balance + amount ≥ price`.
- Insert `topups` (AUTO, VAULT_MIT) → `pp.createTopupOrder` with `card.vault_id` or `paypal.vault_id` + `stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT}` → COMPLETED in create → `creditTopup` → retry the charge once.
- Response header `Spigot-Auto-Topup: <cents>`; MCP summary "Topped up $20 from your saved PayPal method".
- Cap reached → 402 `AUTO_TOPUP_CAP_REACHED`, no PayPal call. Decline → top-up FAILED, `auto_topup_enabled=false`, 402 with "auto top-up declined" copy. 10 s timeout → 402; poller/webhook credit later.

## Acceptance criteria
- [ ] $0.01 left + a $0.06 call → one MIT top-up of $20 then success; W11 table shows AUTO.
- [ ] Cap math across a month boundary (unit).
- [ ] Injected decline disables auto top-up and returns 402.

## Race / idempotency tests (FakePayPal)
- 20 parallel short-balance calls → exactly one AUTO top-up, all calls then charged or 402, never two MIT orders.
- MIT create response lost → retry with the same request id returns the same order (vault orders replay cleanly, Holdfast S7) → credited once.

## Test plan
Integration (FakePayPal); sandbox MIT once (needs SP-003 S8a).
