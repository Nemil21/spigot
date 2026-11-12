# SP-014a: Dataset PATCH / approve / reject / unpublish (filter indexes, APPROVE extract run, policy bump, crawl wiring)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 2
- **Depends on:** SP-012a, SP-013, SP-007a, SP-009a2, SP-015, SP-004b
- **Spec refs:** api.md §`PATCH /api/datasets/:id`, §`POST /api/datasets/:id/approve`, §`POST /api/datasets/:id/unpublish`; features/04 §6 Approve; data-model.md §Dataset state machine, §records indexes

## Goal
The owner edits and approves a proposal; the dataset goes LIVE, every page is extracted with no AI, and the gate starts quoting those paths.

## Files / modules
`apps/api/src/datasets/` — `patch.ts`, `approve.ts`, `unpublish.ts`, `filterIndexes.ts`; routes; registration of `onPageChanged` → `extractPage` for pages whose template has a LIVE/LIVE_STALE dataset.

## Scope
- `PATCH /api/datasets/:id {fields[{name, visible, filterable}], perRecordMicros, perChangeMicros, slug}` (the slug is free to change: record keys don't contain it, SP-011): field changes → new immutable `schema_versions` row (`proposed_by: OWNER`); price edits apply to the dataset (bounds 100–100,000 micros); hidden fields can't be filterable.
- `POST /api/datasets/:id/approve {schemaVersionId, rightsAttested: true}`: validation (`rightsAttested`, ≥ 1 visible field: "Pick at least one field to sell"); conditional `PROPOSED → LIVE`; schema version → APPROVED (previous → SUPERSEDED); `active_schema_id`; `sites.rights_attested_at`; create expression indexes for the filterable fields using SP-015's `fieldExpr(field, type)` so the index matches the query SQL exactly (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`, outside the transaction; tests use a non-concurrent path because `CONCURRENTLY` can't run inside the per-test transaction); insert a `crawl_runs` row with `trigger = APPROVE` and run `extractTemplate(datasetId, runId)` under SP-013's dataset locks; `bumpPolicyVersion` (SP-008b; if not merged, inline `UPDATE sites SET policy_version = policy_version + 1`); audit `SCHEMA_APPROVED`, `DATASET_PUBLISHED`; returns `{status, endpoint}`.
- Reject proposal: `POST /api/datasets/:id/reject` → REJECTED.
- `POST /api/datasets/:id/unpublish` → UNPUBLISHED (API 410), policy bump, audit.
- Progress events for the re-extract on the publisher SSE (`dataset.extract.progress` from `@spigot/shared/events`).
- Read endpoints (proposals list, dataset detail with 20 sample rows) are SP-014b.
- Add `security/tenancy/datasets.cases.ts`.
- Tenancy via `forPublisher`.

## Acceptance criteria
- [ ] Approve Listing with `agent_phone` hidden → LIVE, 2,341 records, `ai_calls = 0`; the hidden field is in `records.data` but never filterable.
- [ ] Approve without `rightsAttested` → 400 `VALIDATION_ERROR`; with no visible fields → 400.
- [ ] Double approve → second is 409 `STATE_CONFLICT`.
- [ ] After approve, `sites.policy_version` increased by one (via `bumpPolicyVersion` or the inline fallback). The policy body (`gatedPaths` includes `^/listings/`) is asserted in SP-008b, which builds it; this ticket doesn't depend on SP-008b so the spine stays short.
- [ ] After approve, a crawl of a changed page produces a version (fetchPage → extractPage wired).
- [ ] **End to end (moved here from SP-013):** demo site at `DEMO_SEED_SCALE=0.05` → crawl → approve → `demo:mutate --prices 30 --leased 5 --new 3` (scaled) → crawl → the changes feed returns exactly the mutated records (updates incl. `status` for leased, adds for new), nothing else.
- [ ] Approve while a crawl of the same site is running: both finish; the feed has no gaps (SP-013's locks); the APPROVE run has its own `crawl_runs` row.
- [ ] The expression index created at approve is used by SP-015's query (`EXPLAIN` shows an index scan on `price_usd`).

## Test plan
Integration (`*.db.test.ts`): patch → approve → records; mutate → crawl → changes; approve/crawl overlap; unpublish asserted on dataset status (the 410 is SP-017b's test).
