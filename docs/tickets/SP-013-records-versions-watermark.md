# SP-013: Records upsert, versions, JSON Patch, watermark locks (`extractPage`, `extractTemplate`, `publishWatermark`)

- **Priority:** P0
- **Wave:** 2
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
- **Watermark safety with concurrent writers** (approve-time `extractTemplate`, a crawl, a ping or a scheduled re-crawl can overlap): every extract batch transaction takes `pg_advisory_xact_lock_shared(hash('dataset', datasetId))`; `publishWatermark` takes the **exclusive** lock on the same key before reading `max(seq)`. The exclusive lock waits for every in-flight batch to commit, so no lower seq can commit below a published watermark.
- Every write carries a `runId`: `extractTemplate` is called with a `crawl_runs` row of `trigger = APPROVE` (created by SP-014a), so `record_versions.crawl_run_id` is always set.
- `records.updated_at` is set to `now()` **only** when the content hash changed (insert, update, remove, revive); the freshness-only path updates `crawled_at` alone.
- `extractPage` skips all writes while the dataset is `LIVE_STALE` (the drift rule SP-052a uses).

## Acceptance criteria
- [ ] On **fixture snapshot sets** (a base set, and a mutated set = 30 price changes + 5 leased + 3 extra pages inserted): extracting base then mutated writes exactly 35 `update` + 3 `add` versions, no others. (The real mutate → crawl → changes test is SP-014a's.)
- [ ] Re-extract with no changes writes 0 versions.
- [ ] Concurrency test: 2 parallel extract batches + a reader polling `seq <= published_seq` → seen seqs are contiguous, none skipped.
- [ ] Full re-extract of 2,341 pages: `ai_calls = 0` and no Anthropic client constructed (spy).
- [ ] Re-extracting the same snapshot with a different crawl time writes no version and doesn't move `records.updated_at`.
- [ ] Overlap test: an `extractTemplate` (APPROVE run) and a crawl run writing the same dataset concurrently, with a reader polling the feed → seen seqs are contiguous up to every published watermark.

## Test plan
Integration (`*.db.test.ts`) with fixture snapshot sets inserted directly.

## Notes & risks
Wiring `fetchPage → extractPage` for LIVE templates happens in SP-014a (needs the approve state).
