# SP-047a: Auto top-up core: vault MIT on a short charge, VAULT_MIT cap, one in flight, lock order

- **Priority:** P1 (spec P1 #1)
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-016, SP-018a, SP-003
- **Spec refs:** features/08 §Auto top-up; features/07 §`chargeAndRecord` step 5; data-model.md rule 11; api.md §Response headers

## Goal
The agent keeps working when its balance runs out: Spigot charges the saved PayPal method within the human's cap.

## Files / modules
`apps/api/src/topups/autoTopup.ts`; hook into SP-016's `onInsufficient`.

## Scope
- On `InsufficientBalance` (SP-016's `onInsufficient` hook), in this order:
  1. Short tx A: `SELECT … FROM buyers WHERE id=$1 FOR UPDATE`; **re-read the buyer balance**: if `balance ≥ price` now (another call's top-up already landed), skip the MIT and go to step 4.
  2. Still in tx A, require `auto_topup_enabled`, `vault_id`, **no `method='VAULT_MIT'` top-up in `CREATED`** for this buyer, and **month sum of `VAULT_MIT` top-ups (AUTO + MCP) in `CREATED` or `COMPLETED`, calendar month in UTC, + amount ≤ `monthly_topup_cap_cents`**, and `balance + amount ≥ price`. Insert `topups` (AUTO, VAULT_MIT, CREATED). COMMIT (the buyer row is held for milliseconds, never during the PayPal call).
  3. Outside any transaction: `pp.createTopupOrder` with `card.vault_id` or `paypal.vault_id` + `stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT}` (request id = topup id) → COMPLETED in create → `creditTopup`.
  4. Retry the charge once.
- This ticket updates data-model.md rule 11 to the `VAULT_MIT` wording (cap and one-in-flight cover AUTO **and** MCP vault top-ups). SP-047b's MCP `top_up` uses the same `reserveVaultTopup()` function.
- Response header `Spigot-Auto-Topup: <cents>`; MCP summary "Topped up $20 from your saved PayPal method".
- Cap reached → 402 `AUTO_TOPUP_CAP_REACHED`, no PayPal call. Decline → top-up FAILED, `auto_topup_enabled=false`, 402 with "auto top-up declined" copy. 10 s timeout → 402; poller/webhook credit later.

## Acceptance criteria
- [ ] $0.01 left + a $0.06 call → one MIT top-up of $20 then success; W11 table shows AUTO.
- [ ] Cap math across a month boundary (unit).
- [ ] Injected decline disables auto top-up and returns 402.
- [ ] With the month cap almost used by MCP vault top-ups, an AUTO top-up that would exceed it → 402 `AUTO_TOPUP_CAP_REACHED`.

## Race / idempotency tests (FakePayPal)
- 20 parallel short-balance calls → **total auto top-ups = one $20**: calls queued behind the first see the new balance at step 1 and skip; all calls end charged or 402; never two MIT orders.
- MCP `top_up` from the vault and an AUTO top-up racing → one VAULT_MIT in flight; the month cap counts both.
- MIT create response lost → retry with the same request id returns the same order (vault orders replay cleanly, Holdfast S7) → credited once.

## Test plan
Integration (FakePayPal); sandbox MIT once (needs SP-003 S8a).

## Notes & risks
- Registers its webhook handler for AUTO-top-up declines (`PAYMENT.CAPTURE.DENIED`) as `webhooks/handlers/auto-topup.ts` for SP-059's dispatcher.
