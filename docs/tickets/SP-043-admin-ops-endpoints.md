# SP-043: Admin ops endpoints: audit search, ledger check, health

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1
- **Depends on:** SP-005, SP-007a
- **Spec refs:** api.md §Ops (admin only); features/07 §Ledger check; features/14 §Audit and ops

## Goal
Prove the books balance and find any money event by PayPal id; the backend for W14 (P1).

## Files / modules
`apps/api/src/routes/admin.ts`.

## Scope
- `GET /admin/audit?publisherId&entity&paypalId&from&to` (paged).
- `POST /admin/ledger/check` → `ledgerCheck()` (SP-005).
- `GET /admin/health` → PayPal token ok, DB ok, Workflows ok (if mode = workflows), last gate hit per site, open top-ups, pending payout items.
- `requireAdmin` (ADMIN_EMAILS).

## Acceptance criteria
- [ ] Non-admin → 403.
- [ ] Ledger check returns `sumMicros: 0` after the seed + demo script.
- [ ] Audit search by a capture id returns the TOPUP_COMPLETED row.

## Test plan
Integration.
