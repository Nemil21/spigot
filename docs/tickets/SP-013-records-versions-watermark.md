# SP-013: Records upsert, versions, JSON Patch, watermark (`extractPage`, `extractTemplate`, `publishWatermark`)

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 2
- **Depends on:** SP-011, SP-002
- **Spec refs:** features/05-records-changes-feed.md §Logic 1–3, §Acceptance criteria; data-model.md §records, §record_versions, rules 7–8; features/03 §Render Workflows layout

## Goal
The extractor owns records. Only real changes create versions; a reader never sees a change before every batch of the run has committed.

## Files / modules
`apps/api/src/extract/extractPage.ts`, `extractTemplate.ts` (batches of 200 snapshots), `publishWatermark.ts`, `upsert.ts`, exported from `@spigot/api/tasks`.

## Scope
- `extractPage(pageId, datasetId, runId)`: latest snapshot → active extractor (SP-011) → `record_key`, canonical data, hash → upsert per data-model rule 8 (`ON CONFLICT … WHERE hash <> EXCLUDED.hash OR removed_at IS NOT NULL RETURNING version, (xmax = 0) AS inserted`):
  - inserted → `record_versions(op='add', patch=[{op:'add',path:'',value:data}])`;
  - updated → `fast-json-patch.compare(old, new)`, `op='update'`;
  - no row → unchanged; refresh `crawled_at` only;
  - page removed or extractor `null` on a page that had a record → `removed_at = now()`, `op='remove'` (`[{op:'remove',path:''}]`).
- Run counters `records_added/updated/removed` on `crawl_runs`; `datasets.record_count` refresh.
- `extractTemplate(datasetId, runId)`: all snapshots of the template in batches of 200, each batch its own transaction, then `publishWatermark`.
- `publishWatermark(datasetId)`: `pg_advisory_xact_lock(dataset)`; `published_seq = max(seq)` — called only after all the run's batches committed.
- Guard: **no model call anywhere in this module** (`crawl_runs.ai_calls` untouched; test asserts it).

## Acceptance criteria
- [ ] After SP-004b `demo:mutate --prices 30 --leased 5 --new 3` and a re-extract: exactly 35 `update` + 3 `add` versions, no others.
- [ ] Re-extract with no changes writes 0 versions.
- [ ] Concurrency test: 2 parallel extract batches + a reader polling `seq <= published_seq` → seen seqs are contiguous, none skipped.
- [ ] Full re-extract of 2,341 pages: `ai_calls = 0` and no Anthropic client constructed (spy).

## Test plan
Integration on Postgres with demo-site snapshots inserted as fixtures; mutate → re-extract test.

## Notes & risks
Wiring `fetchPage → extractPage` for LIVE templates happens in SP-014 (needs the approve state).
