# SP-062: W14 Admin / audit screen

- **Priority:** P1 (feature 14 P1)
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-043, SP-024b
- **Spec refs:** screens.md §W14; features/14 §Audit and ops

## Goal
One place to find any money event by PayPal id and prove the ledger balances.

## Files / modules
`apps/web/src/pages/admin/Audit.tsx`.

## Scope
Search (publisher, buyer, PayPal id); audit events AG Grid (SIM chips); health tiles (PayPal token, Workflows, last gate hit, open top-ups, pending payouts); "Ledger check" button (shows sum = 0); "Run payout now". States healthy / degraded.

## Acceptance criteria
- [ ] Searching a capture id finds its rows; ledger check shows 0 after the demo.

## Test plan
Component tests; manual.
