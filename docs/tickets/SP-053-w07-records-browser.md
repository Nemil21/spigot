# SP-053: W07 Records browser (server-side rows, version history)

- **Priority:** P1 (spec P1 #6)
- **Wave:** 3
- **Estimate:** 2
- **Depends on:** SP-024, SP-015
- **Spec refs:** screens.md §W07; features/13 §Screens; features/05

## Goal
Owners browse their records and see each record's change history as JSON Patch.

## Files / modules
API `GET /api/datasets/:id/records` (server-side row model: filter, sort, block 100), `GET /api/records/:id/versions`; `apps/web/src/pages/RecordsBrowser.tsx`, `VersionDrawer.tsx`.

## Scope
- AG Grid server-side row model with schema columns (shows hidden fields to the owner, marked), version, last changed, freshness; drawer with version list and patch diff view; stale banner.

## Acceptance criteria
- [ ] 2,341 rows scroll smoothly; filter/sort server-side; history shows the mutate changes.
- [ ] Tenancy enforced.

## Test plan
Integration for the APIs; component test for the drawer.
