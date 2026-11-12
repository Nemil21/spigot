# SP-003: PayPal spike pack S7–S10 (+S11 script) for Spigot's CAPTURE / vault / refund / payout calls

- **Priority:** P0
- **Wave:** 1
- **Estimate:** 1.5
- **Depends on:** none
- **Spec refs:** README.md §New PayPal spikes needed; features/08 §PayPal pieces; features/09; features/10; spikes/paypal-spikes.mjs; spikes/s7-results.md (Holdfast)

## Goal
Prove the five PayPal calls Spigot needs that Holdfast never ran with `intent: CAPTURE`, and record replay/error codes so SP-001b's fake and SP-018/020/049 behave like the sandbox.

## Files / modules
`scripts/spikes-spigot.mjs` (same shape as `spikes/paypal-spikes.mjs`: reads `.env`, plain `fetch`, no deps), `spikes/spigot-results.md` (result table + evidence: request id, HTTP, body status, issue, debug id).

## Scope
| # | Test | Notes |
|---|---|---|
| S7a | Orders v2 `intent: CAPTURE`, card source (test card 4111…), captured in the create call | Record capture id and `status` |
| S7b | Wallet `CAPTURE` order with `return_url` → human approves with the sandbox Personal account → `POST /orders/{id}/capture` with `capture:<id>`; replay same id | Needs a human for ~1 min (approval) |
| S8a | Card `CAPTURE` with `store_in_vault: ON_SUCCESS`, then MIT `CAPTURE` from `vault_id` + `stored_credential{MERCHANT,UNSCHEDULED,SUBSEQUENT}`; replay same id | Holdfast proved the MIT pattern for AUTHORIZE |
| S8b | Wallet vault (`paypal.attributes.vault`, `usage_type: MERCHANT`) on a CAPTURE order, then MIT `paypal.vault_id` CAPTURE | Holdfast proved wallet vault + wallet MIT with AUTHORIZE |
| S8c | MIT CAPTURE with `PayPal-Mock-Response {"mock_application_codes":"INSTRUMENT_DECLINED"}` | Record status code and body shape (auto top-up decline path) |
| S9 | Partial refund `POST /v2/payments/captures/{id}/refund` `{amount}` with `PayPal-Request-Id`; replay same id; refund above remaining | Refund P1 |
| S10 | One Payouts batch with 3 items: the **separate publisher sandbox business account**, a second valid sandbox email, one unregistered email; poll batch until terminal; resubmit the same `sender_batch_id` | Record `UNCLAIMED`, duplicate-batch error |
| S11 | Script only: verify-webhook-signature call shape; run in SP-059 once the Render URL exists | |

## Acceptance criteria
- [ ] `spikes/spigot-results.md` has PASS/FAIL per step with evidence rows and a "Decision / fallback" column.
- [ ] A RECONCILE table for CAPTURE-intent calls (create replay, capture replay, MIT replay, refund replay, payout duplicate) is handed to SP-001b / SP-018 / SP-020 / SP-049.
- [ ] Every order created is captured or left un-approved; nothing needs cleanup.
- [ ] No secret in the committed results (debug ids are fine).

## Test plan
Run `node scripts/spikes-spigot.mjs s7a|s7b|s8a|s8b|s8c|s9|s10`; S7b needs a person at the browser.

## Notes & risks
- Use the **US** sandbox business account as merchant (the India one fails cards and Payouts).
- **Payouts must go to a separate sandbox business (publisher) account.** Paying the merchant itself gives batch DENIED / item FAILED `SELF_PAY_NOT_ALLOWED` (Holdfast S7). Create the publisher account before S10 and put it in `.env` as `DEMO_PUBLISHER_PAYOUT_EMAIL`.
- **Large payouts need a funded balance.** In Holdfast S7, payouts ≥ $2,500 got `422 INSUFFICIENT_FUNDS` (no batch created) even after $106k of captures; $1,000 succeeded. Keep S10 items ≤ $50 each.
- Fallbacks if a step fails: S7b → card-only top-up in the demo; S8a/b → MIT disabled, auto top-up returns an approval link; S9 → refunds cut, claims stay as balance credits; S10 → poll only, UNCLAIMED shown as "waiting for publisher to claim".
