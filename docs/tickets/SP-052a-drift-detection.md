# SP-052a: Drift detection, LIVE_STALE, `DEMO_LAYOUT=v2`

- **Priority:** P1 (spec P1 #5)
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-013, SP-014, SP-004b
- **Spec refs:** features/04 §7 Drift; features/01 §Logic 7; data-model.md §Dataset state machine (LIVE_STALE), `stale_since`

## Goal
A redesign doesn't silently corrupt the feed: the dataset goes stale and keeps serving the last good records.

## Files / modules
`apps/api/src/extract/drift.ts` (run-end check via `onRunFinished`), `apps/demo-site` `DEMO_LAYOUT=v2` (renames listing CSS classes, moves `available_from`).

## Scope
- After each run compare per-field null rates with approved `sample_stats`: required field +25 points or ≥ 2 fields > 40% → `LIVE → LIVE_STALE`, `stale_since=now()`; versions from the broken extractor in that run are **not** published (watermark not advanced for those; re-extract after re-approval).
- `freshness.staleSince` on served records; publisher alert event.

## Acceptance criteria
- [ ] `DEMO_LAYOUT=v2` + crawl → dataset LIVE_STALE; API still serves last good values with `staleSince`.
- [ ] A normal mutate run doesn't trigger drift.

## Test plan
Integration with demo-site v2 fixtures.
