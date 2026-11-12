# SP-036: `sim:buyers` (backdated week + `--live`)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1
- **Depends on:** SP-035, SP-017b, SP-014
- **Spec refs:** features/15 §Seed script 7, §Live simulators

## Goal
W08 shows a believable week (~$500 gross) and stays alive during recording, all labelled SIM.

## Files / modules
`scripts/sim-buyers.ts` (`npm run sim:buyers [-- --live]`).

## Scope
- **Needs a LIVE dataset.** If the demo site has none, the script runs `crawlSite` (SP-009a task function, in-process) and then approves the Listing proposal through SP-014's approve service with `rightsAttested` and `agent_phone` hidden. It prints that it did so. In the demo flow the human approves on camera after `demo:reset`; SIM history stays because it belongs to SIM buyers.
- Default: real `/v1` calls with SIM buyers' keys mixing records and changes over a simulated past week; afterwards backdate `created_at` on those SIM `api_calls`/`ledger_txns` (allowed only for `is_simulated` rows; guard in SQL).
- `--live`: one SIM call every 3–6 s until Ctrl-C.
- Stops a buyer when its balance hits 402 (no auto top-up for SIM).

## Acceptance criteria
- [ ] After a run, W08 week gross ≈ $500 ± 20%, all rows SIM-chipped.
- [ ] Backdating touches only SIM rows (test).
- [ ] Ledger check passes.
- [ ] On a freshly seeded DB with no LIVE dataset, the script reaches LIVE by itself and then makes calls.

## Test plan
Smoke on FakePayPal + local stack.
