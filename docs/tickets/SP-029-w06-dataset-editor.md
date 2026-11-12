# SP-029: W06 Dataset editor + publish (schema-driven AG Grid)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** SP-024b, SP-014b
- **Soft deps (build against, verify on merge):** SP-014a
- **Spec refs:** screens.md §W06; features/13 §3; features/06 §Pricing; features/04 §6

## Goal
The owner hides `phone`, sets $1.50 per 1,000 and publishes in under a minute.

## Files / modules
`apps/web/src/pages/DatasetEditor.tsx`, `grids/SchemaGrid.tsx` (`columnDefs` generated from `schema_versions.fields`), `components/FieldList.tsx`, `PriceInputs.tsx`, `EndpointPreview.tsx`.

## Scope
- Field list: name, type, example, null-rate bar, **visible toggle**, PII badge, rights flag ("Byline 'AP' found: excluded by default"), filterable chips (disabled for hidden fields).
- Loads `GET /api/datasets/:id` (SP-014b: schema, prices, status, 20 sample rows) for both PROPOSED and LIVE datasets.
- Schema-driven AG Grid of 20 sample rows: type → renderer (money, date, boolean chip, URL link); hidden fields struck-through and greyed; updates instantly on toggle.
- Price inputs per 1,000 records and per 1,000 changes (bounds $0.10–$100); live line "A buyer pulling all 2,341 listings pays $3.51; you get $2.81 after Spigot's 20%" via `@spigot/shared` money helpers.
- Endpoint preview (`GET /v1/bluebonnet/datasets/listings/records?bedrooms[gte]=3`) with sample JSON (visible fields only).
- Rights attestation checkbox; Publish → PATCH (if edited) → approve → progress (re-extract) → live card ("Your gate now sends bots here", endpoint copy); Unpublish.
- Validation states: no visible fields, rights not ticked. Stale banner slot (P1, SP-052b).

## Acceptance criteria
- [ ] W05 → W06 → Publish for Listing in < 60 s of clicking.
- [ ] Hiding a field removes it from the sample grid instantly and from the API after publish.
- [ ] Price math line matches `commissionSplit` for odd prices.
- [ ] **Before this PR merges, Publish works against the merged SP-014a** (PATCH + approve + progress). If SP-014a hasn't merged yet, the PR waits; it doesn't merge on fixtures alone.

## Test plan
Component test for column generation from a schema; manual publish against the local stack.

## Notes & risks
- SP-014a is a soft dependency on purpose: on the hard-dependency chain W06 couldn't merge before ~18:30 even with unlimited workers. The worker starts in fixture mode (SP-024a) against api.md's approve contract as soon as SP-014b lands.
