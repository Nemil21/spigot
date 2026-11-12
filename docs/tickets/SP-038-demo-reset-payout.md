# SP-038: `demo:reset` + `demo:payout`

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-035, SP-021
- **Spec refs:** features/12 §Pieces 4; features/15 §Demo hooks, §Acceptance criteria

## Goal
Every take starts clean, and the payout beat is one command.

## Files / modules
`apps/api/src/cli/demo-reset.ts`, `demo-payout.ts`.

## Scope
- `demo:reset`: demo publisher's datasets → PROPOSED (records kept but unpublished), Acme balance → $0 via a reversing ledger txn (`DEMO_RESET`, never deleting entries), delete Acme's demo `api_calls` (non-ledger rows) or mark them hidden, keep SIM history, restore demo-site data (re-seed + bump), never touches PayPal history.
- `demo:payout` = `payoutRun('MANUAL_DEMO', {thresholdCentsOverride: 100})` and print batch/item ids.
- `--yes` required; refuses unless `DEMO_MODE=true`.

## Acceptance criteria
- [ ] Reset → full script → reset → full script works twice in a row.
- [ ] Ledger check passes after reset (no entry deleted).
- [ ] PayPal ids from earlier runs remain in audit.

## Test plan
Integration: seed → charges → reset → ledger check.

## Notes & risks
A $0 reset needs a ledger account to absorb the buyer balance (`PLATFORM_REVENUE` with memo "demo reset") — document it in the README's simulated-vs-real table.
