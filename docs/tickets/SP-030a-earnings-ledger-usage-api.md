# SP-030a: Earnings, ledger and buyer-usage read APIs

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1
- **Depends on:** SP-016, SP-007a
- **Spec refs:** api.md §`GET /api/publishers/me/earnings`, §`/ledger`, §`GET /api/buyer/usage`; features/07 §Display

## Goal
Numbers for W08 (and W12 later), read from the ledger and `api_calls`.

## Files / modules
`apps/api/src/reports/earnings.ts`, `ledgerRows.ts`, `usage.ts`; routes.

## Scope
- `GET /api/publishers/me/earnings?from&to&groupBy=buyer|dataset|day&includeSim`: kpis (gross, commission, net, payable from `PUBLISHER_PAYABLE`, recordsSold, changesSold, buyers) + rows (key, isSimulated, calls, records, changes, grossMicros, netMicros, channel split).
- `GET /api/publishers/me/ledger?cursor` (server-side rows: txn kind, memo, amount, PayPal id, time; 100 per block).
- `GET /api/buyer/usage?from&to` (time, dataset, endpoint, records, charged, channel, replay flag) and `GET /api/buyer/calls/:id`.
- Tenancy enforced.

## Acceptance criteria
- [ ] KPIs reconcile with `ledgerCheck` per-publisher figures.
- [ ] `includeSim=false` excludes SIM calls and SIM txns.
- [ ] Publisher A can't read B's ledger rows.

## Test plan
Integration on fixtures produced through `chargeAndRecord`.
