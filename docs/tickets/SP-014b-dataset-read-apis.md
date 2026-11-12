# SP-014b: Dataset read APIs: proposals list and `GET /api/datasets/:id` (schema, prices, 20 sample rows)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-012a, SP-007a
- **Spec refs:** api.md §`GET /api/sites/:id/proposals` (+ new `GET /api/datasets/:id`); screens.md §W05, §W06; features/13 §2–3

## Goal
What W05 and W06 read: the proposals list, and one dataset with its schema, prices, status and 20 sample rows, for PROPOSED and LIVE datasets alike.

## Files / modules
`apps/api/src/routes/datasets-read.ts`, `apps/api/src/datasets/samples.ts`; `security/tenancy/datasets-read.cases.ts`.

## Scope
- `GET /api/sites/:id/proposals` (moved from SP-012a) in the api.md shape: fields with null rate + example, 5 sample rows, source badge (`JSON-LD` / `CSS` / `auto (no AI)`), suggested price, rationale.
- `GET /api/datasets/:id` (**new; api.md amendment**): `{id, siteSlug, slug, typeName, status, staleSince, activeSchemaVersion, latestSchemaVersion (PROPOSED/OWNER), fields[{name, type, description, visible, pii, rightsFlag, filterable, nullRate, example}], prices {perRecordMicros, perChangeMicros}, recordCount, endpoint, sampleRows[20]}`.
  - PROPOSED: sample rows = SP-011's extractor run on 20 sample snapshots of the template (5 seen + 15 unseen), all fields incl. hidden ones (the owner sees them struck through in W06).
  - LIVE: sample rows = 20 most recent records.
- Tenancy via `forPublisher`.

## Acceptance criteria
- [ ] Proposals for the demo site return three entries with 5 sample rows each.
- [ ] `GET /api/datasets/:id` returns 20 sample rows for a PROPOSED and for a LIVE dataset, with hidden fields flagged.
- [ ] Another publisher's dataset → 404.

## Test plan
Integration (`*.db.test.ts`) on fixture proposals and records.
