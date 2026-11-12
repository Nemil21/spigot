# SP-014: Proposals / dataset PATCH / approve / unpublish API (filter indexes, re-extract, policy bump)

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-012a, SP-013, SP-007a, SP-009a
- **Spec refs:** api.md §`PATCH /api/datasets/:id`, §`POST /api/datasets/:id/approve`, §`POST /api/datasets/:id/unpublish`; features/04 §6 Approve; data-model.md §Dataset state machine, §records indexes

## Goal
The owner edits and approves a proposal; the dataset goes LIVE, every page is extracted with no AI, and the gate starts quoting those paths.

## Files / modules
`apps/api/src/datasets/` — `patch.ts`, `approve.ts`, `unpublish.ts`, `filterIndexes.ts`; routes; registration of `onPageChanged` → `extractPage` for pages whose template has a LIVE/LIVE_STALE dataset.

## Scope
- `PATCH /api/datasets/:id {fields[{name, visible, filterable}], perRecordMicros, perChangeMicros, slug}`: field changes → new immutable `schema_versions` row (`proposed_by: OWNER`); price edits apply to the dataset (bounds 100–100,000 micros); hidden fields can't be filterable.
- `POST /api/datasets/:id/approve {schemaVersionId, rightsAttested: true}`: validation (`rightsAttested`, ≥ 1 visible field: "Pick at least one field to sell"); conditional `PROPOSED → LIVE`; schema version → APPROVED (previous → SUPERSEDED); `active_schema_id`; `sites.rights_attested_at`; create expression indexes for the filterable fields (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`, outside the transaction); run `extractTemplate`; `bumpPolicyVersion` (SP-008b; if not merged, inline `UPDATE sites SET policy_version = policy_version + 1`); audit `SCHEMA_APPROVED`, `DATASET_PUBLISHED`; returns `{status, endpoint}`.
- Reject proposal: `POST /api/datasets/:id/reject` → REJECTED.
- `POST /api/datasets/:id/unpublish` → UNPUBLISHED (API 410), policy bump, audit.
- Progress events for the re-extract on the publisher SSE (`notify`).
- Tenancy via `forPublisher`.

## Acceptance criteria
- [ ] Approve Listing with `agent_phone` hidden → LIVE, 2,341 records, `ai_calls = 0`; the hidden field is in `records.data` but never filterable.
- [ ] Approve without `rightsAttested` → 400 `VALIDATION_ERROR`; with no visible fields → 400.
- [ ] Double approve → second is 409 `STATE_CONFLICT`.
- [ ] After approve, `sites.policy_version` increased by one (via `bumpPolicyVersion` or the inline fallback). The policy body (`gatedPaths` includes `^/listings/`) is asserted in SP-008b, which builds it; this ticket doesn't depend on SP-008b so the spine stays short.
- [ ] After approve, a crawl of a changed page produces a version (fetchPage → extractPage wired).

## Test plan
Integration: patch → approve → records; unpublish → 410 via SP-017b once merged (otherwise asserted on dataset status).
