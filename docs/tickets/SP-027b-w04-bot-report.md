# SP-027b: W04 Overview / bot report (AG Grid + AG Charts, live)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1.5
- **Depends on:** SP-024, SP-027a, SP-025
- **Spec refs:** screens.md §W04; features/13 §1; features/12 video 0:20–0:45

## Goal
The video's opening owner shot: "who's crawling you", live.

## Files / modules
`apps/web/src/pages/Overview.tsx`, `grids/BotsGrid.tsx`, `charts/HitsArea.tsx`, `ActivityFeed.tsx`, `BotDrawer.tsx`.

## Scope
- KPI row: Bot visits (7 d), "1 bot per N human visits", Bots sent to your API (402s), Bandwidth avoided (est.), **Earned this week** ("incl. $X SIM" on hover).
- AG Charts stacked area by category.
- AG Grid Enterprise "Who's crawling you": Bot, Category badge, Hits (7 d), Decision (Passed / Sent to API), Last seen, Bytes, "Would have paid" (italic estimate), SIM chip; row grouping by category; sparkline cell (24 h); live via SSE `hits` → refetch delta + `applyTransactionAsync` + row flash.
- Activity feed (proposal ready, call charged, payout sent).
- States: empty ("Install the gate to see who's crawling you" → W03), installed-no-bots, live, unverified banner; include-simulated toggle; filter by category; row → detail drawer.

## Acceptance criteria
- [ ] With `sim:bots` running, rows flash and KPIs move within 15 s.
- [ ] Every SIM row shows a chip; toggling SIM off updates grid, chart and KPIs.
- [ ] No licence watermark.

## Test plan
Component tests with fixtures; manual with `sim:bots`.
