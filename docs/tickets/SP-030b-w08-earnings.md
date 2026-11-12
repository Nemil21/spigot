# SP-030b: W08 Earnings (KPIs, AG Charts, grouped AG Grid, ledger tab)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-024, SP-030a, SP-025
- **Spec refs:** screens.md §W08; features/13 §4; features/12 video 1:50–2:25

## Goal
Earnings tick up live, grouped by buyer and record type; a Claude Desktop call flashes in within 2 s.

## Files / modules
`apps/web/src/pages/Earnings.tsx`, `grids/EarningsGrid.tsx`, `grids/LedgerGrid.tsx`, `charts/EarningsBars.tsx`.

## Scope
- KPI tiles: Gross, Spigot commission (20%), **Your earnings**, Payable now, Records sold, Buyers.
- AG Charts stacked bars per day by dataset.
- AG Grid: row grouping Buyer → Dataset, sum aggregations (calls, records, changes, gross, net), pivot toggle, SIM chip + filter, CSV export, channel column (REST/MCP), row flash on SSE `call.charged`.
- Ledger tab: server-side row model over the ledger API; PayPal id cells link to the payout/top-up.
- States: empty ("No buyers yet. Your API is live at …"), live, SIM toggle.

## Acceptance criteria
- [ ] A paid MCP call appears as a flashing MCP row within 2 s.
- [ ] Grouped totals equal the KPI tiles.
- [ ] CSV export works.

## Test plan
Component tests on fixtures; manual with `sim:buyers --live`.
