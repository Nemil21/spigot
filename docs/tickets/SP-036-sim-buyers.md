# SP-036: `sim:buyers` (simulated week at insert time + `--live`)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1
- **Depends on:** SP-035, SP-017b, SP-014a
- **Spec refs:** features/15 §Seed script 7, §Live simulators

## Goal
W08 shows a believable week (~$500 gross) and stays alive during recording, all labelled SIM.

## Files / modules
`scripts/sim-buyers.ts` (`npm run sim:buyers [-- --live]`).

## Scope
- **Needs a LIVE dataset.** If the demo site has none, the script runs `crawlSite` (SP-009a2 task function, in-process) and then approves the Listing proposal through SP-014a's approve service with `rightsAttested` and `agent_phone` hidden. It prints that it did so. In the demo flow the human approves on camera after `demo:reset`; SIM history stays because it belongs to SIM buyers.
- Default: real `/v1` service calls (`paidRead`, in-process, with SIM buyers' keys) mixing records and changes over a simulated past week. Each call passes **`simulatedAt`** into `chargeAndRecord`, which sets `created_at` on `api_calls`, `ledger_txns` and `ledger_entries` **at insert time** (SP-005/SP-016; accepted only for `is_simulated` buyers, enforced by SP-002's CHECK). **No UPDATE of any row.** SIM top-ups were already dated to the start of the week by SP-035, so balances are funded before they're spent.
- `--live`: one SIM call every 3–6 s until Ctrl-C.
- Stops a buyer when its balance hits 402 (no auto top-up for SIM).

## Acceptance criteria
- [ ] After a run, W08 week gross ≈ $500 ± 20%, all rows SIM-chipped.
- [ ] No UPDATE statement touches `api_calls`, `ledger_txns` or `ledger_entries` (test with a statement log); a non-SIM buyer passing `simulatedAt` is rejected.
- [ ] Every SIM call's timestamp is after its buyer's SIM top-up.
- [ ] Ledger check passes.
- [ ] On a freshly seeded DB with no LIVE dataset, the script reaches LIVE by itself and then makes calls.

## Test plan
Smoke on FakePayPal + local stack.
