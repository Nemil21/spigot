# SP-027a: Bots API: `GET /api/sites/:id/bots` (totals, byBot, series, estimates)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-008b
- **Spec refs:** api.md §`GET /api/sites/:id/bots`; screens.md §W04; features/13 §1

## Goal
The bot report numbers: who crawls you, how many were sent to your API, and what they'd have paid.

## Files / modules
`apps/api/src/bots/report.ts`, route `GET /api/sites/:id/bots?from&to&includeSim=true`.

## Scope
- `totals`: botHits, humanHits, ratio string "1 bot per N human visits", quoted402, bytesSavedEstimate, `wouldHaveEarnedMicros` = gated page hits × records per page (1 for detail templates) × dataset price (labelled estimate).
- `byBot`: botName, category, hits, decision, lastSeen, bytes, wouldHavePaid, isSimulated; `series` per minute/hour bucket by category (auto bucket size by range).
- `includeSim=false` excludes SIM rows; earned-this-week (from `api_calls`) with SIM share for the KPI hover.

## Acceptance criteria
- [ ] Totals equal sums over `bot_hits` fixtures; SIM toggle changes them.
- [ ] Other publisher's site → 404.
- [ ] 7-day range over 100k rows < 300 ms locally.

## Test plan
Integration on fixture `bot_hits`.
