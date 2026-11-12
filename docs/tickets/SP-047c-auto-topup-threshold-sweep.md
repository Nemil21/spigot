# SP-047c: Auto top-up below threshold (async after charge) + orphaned VAULT_MIT sweep

- **Priority:** P1
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-047a, SP-019
- **Spec refs:** features/08 §Auto top-up; data-model.md §buyers (`auto_topup_threshold_micros`), rule 11

## Goal
Use the threshold the buyer set ("top up when below $2"), not only a failed charge, and make sure a timed-out vault top-up can never jam auto top-up for good.

## Files / modules
`apps/api/src/topups/thresholdTopup.ts`, `jobs/vault-topup-sweep.job.ts`.

## Scope
- **Threshold trigger:** after a CHARGE commits and leaves `balance < auto_topup_threshold_micros`, enqueue an async `reserveVaultTopup()` (SP-047a: same lock, one-in-flight and VAULT_MIT cap rules). The in-request path from SP-047a stays as the fallback when a call can't wait.
- **Orphan sweep** (every 30 s): `VAULT_MIT` rows still `CREATED` after 30 s → replay `createTopupOrder` with the **same `PayPal-Request-Id`** (vault orders replay cleanly, Holdfast S7) → `creditTopup` or FAILED. Still unresolved after 10 min → FAILED + `needs_reconcile` + alert, which frees the one-in-flight slot.

## Acceptance criteria
- [ ] A charge leaving $1.50 with a $2 threshold triggers exactly one $20 MIT top-up without any 402.
- [ ] A MIT top-up whose create timed out (fake: response lost) is credited by the sweep within 60 s, once.
- [ ] A top-up stuck CREATED with no order for 10 min → FAILED + `needs_reconcile`, and auto top-up works again.

## Race / idempotency tests (FakePayPal)
- Threshold trigger and an in-request short-balance top-up racing → one MIT order.
- Sweep and a late original response for the same top-up → one credit.

## Test plan
Integration (`*.db.test.ts`, FakePayPal, fake timers).
