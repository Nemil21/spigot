# SP-052a: Drift detection, LIVE_STALE (no writes), `DEMO_LAYOUT=v2`

- **Priority:** P1 (spec P1 #5)
- **Wave:** 6
- **Estimate:** 1.5
- **Depends on:** SP-013, SP-014a, SP-004b
- **Spec refs:** features/04 §7 Drift; features/01 §Logic 7; data-model.md §Dataset state machine (LIVE_STALE), `stale_since`

## Goal
A redesign doesn't silently corrupt the feed: the dataset goes stale and keeps serving the last good records.

## Files / modules
`apps/api/src/extract/drift.ts` (run-end check via `onRunFinished`), `apps/demo-site` `DEMO_LAYOUT=v2` (renames listing CSS classes, moves `available_from`).

## Scope
- **Follow the spec: the broken extractor writes no new versions.** `published_seq` is a single max, so "write but don't publish" would leak on the next healthy run.
  - **Probe before writing:** in each crawl run, before the first write for a LIVE dataset, dry-run the extractor (pure SP-011, no DB writes) on the first 20 changed pages of that template and compare per-field null rates with the approved `sample_stats`. Required field +25 points, or ≥ 2 fields > 40% → `LIVE → LIVE_STALE`, `stale_since = now()`; SP-013's `extractPage` then skips all writes for that dataset (rule already in SP-013).
  - Post-run check over all pages of the run as a backstop; if it detects drift the probe missed, the dataset goes LIVE_STALE for subsequent runs and an alert notes which run may contain partial bad versions.
  - Re-extraction happens only after re-approval (SP-052b).
- `freshness.staleSince` on served records; publisher alert event.

## Acceptance criteria
- [ ] `DEMO_LAYOUT=v2` + crawl → dataset LIVE_STALE; API still serves last good values with `staleSince`.
- [ ] A normal mutate run doesn't trigger drift.
- [ ] With `DEMO_LAYOUT=v2`, the crawl writes **0** versions for the Listing dataset.

## Test plan
Integration with demo-site v2 fixtures.
