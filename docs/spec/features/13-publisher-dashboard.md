# 13: Publisher Dashboard (AG Grid)

**Priority:** P0 (W04 bot report, W05 proposals, W06 dataset editor, W08 earnings, W09 payouts) · P1 (W07 records browser, W10 crawls) · **Owner:** A · **Effort:** 5 h

## Purpose
The owner's product. It shows value before any buyer exists (who's crawling you), hosts the AI moment (record types found), and makes the money visible (earnings by buyer and record type, PayPal payouts). It's also our AG Grid sponsor entry, so grids are central, live and polished.

## User stories
- As a site owner, I see which bots crawl me and what they'd have paid.
- As a site owner, I approve a schema and price in under a minute.
- As a site owner, I see earnings tick up live, grouped by buyer and record type.
- As a site owner, I see every PayPal payout with its ids and status.

## Screens
W04 Overview / bot report · W05 Record types found · W06 Dataset editor · W07 Records browser (P1) · W08 Earnings · W09 Payouts · W10 Crawls (P1) · W16 Settings

## Layout and AG Grid use
1. **W04 "Who's crawling you" grid** (AG Grid Enterprise):
   - columns: Bot, Category (badge), Hits (7 d), Decision (Passed / Sent to API), Last seen, Bytes, "Would have paid" (estimate, italic), SIM chip;
   - row grouping by category; sparkline cell renderer (hits over 24 h); live updates via SSE `hits` with `applyTransactionAsync` + row flash.
   - AG Charts stacked area of hits by category, and a KPI row (ratio "1 bot per 31 human visits", 402s, bandwidth avoided, earned this week).
2. **W05 proposal cards:** stream in via SSE `proposal.ready`. Each card has a tiny AG Grid (5 sample rows, auto columns from the schema).
3. **W06 dataset editor:**
   - field list with toggles (visible, filterable), PII/rights badges, null-rate bars;
   - **schema-driven AG Grid**: `columnDefs` generated from `schema_versions.fields` (type → cell renderer: money, date, boolean chip, URL link); hidden fields rendered struck-through; the grid updates instantly when a toggle changes;
   - price inputs with the live "buyer pays / you get" line;
   - Publish → progress (extractTemplate) → endpoint card.
4. **W08 earnings:** KPI tiles; AG Charts stacked bars per day by dataset; AG Grid with row grouping (Buyer → Dataset), aggregations (sum calls, records, gross, net), pivot mode toggle, SIM filter, CSV export; ledger tab (server-side row model over `ledger_entries` for this publisher).
5. **W09 payouts:** AG Grid master/detail (batch → items) with status pills and PayPal id cells (copy); "Run payout now" with a confirm modal showing payable, commission already taken, net, threshold.
6. **Theme:** AG Grid Quartz theme customized with our tokens (light + dark); custom cell renderers for status pills, SIM chip, money (tabular numbers). Don't copy Holdfast's look.

## Data
`GET /api/sites/:id/bots`, `/proposals`, `PATCH/POST /api/datasets/*`, `/api/publishers/me/earnings`, `/ledger`, `/payouts`, SSE `/api/publishers/me/events` (api.md).

## Edge cases
| Case | Handling |
|---|---|
| No gate hits yet | Empty state with install link (W03) |
| No buyers yet | Earnings empty state shows the live endpoint and catalog link |
| SSE disconnect | Auto-reconnect with `Last-Event-ID`; refetch on reconnect |
| Large ledger | Server-side row model, 100 rows per block |
| SIM data mixed with real | "Include simulated" toggle (default on, chip on every SIM row, KPI hover shows SIM share) |

## Acceptance criteria
- [ ] W05 → W06 → Publish takes under 60 s of clicking for the Listing type.
- [ ] Hiding a field in W06 removes it from the sample grid instantly and from the API after publish.
- [ ] A Claude Desktop call appears as a flashing row in W08 within 2 s.
- [ ] Payout ids in W09 match the sandbox.
- [ ] Every SIM row has a visible chip.

## Test plan
Component tests for column generation from a schema. Manual: run the video script with the dashboard on a second screen; check light and dark themes at 1280 px and 1024 px.
