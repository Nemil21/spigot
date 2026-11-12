# SP-052b: Re-inference (`/reinfer`), approve v(n+1), W06 stale banner

- **Priority:** P1 (spec P1 #5)
- **Wave:** 7
- **Estimate:** 1.5
- **Depends on:** SP-052a, SP-012b, SP-029
- **Spec refs:** features/04 §7; api.md §`POST /api/datasets/:id/reinfer`; screens.md §W06 (stale), §W15 (stale copy)

## Goal
Claude re-proposes the extractor for the new layout, keeping field names stable; the owner re-approves and the dataset returns to LIVE.

## Files / modules
`apps/api/src/schema-agent/reinfer.ts`, route `POST /api/datasets/:id/reinfer` (202), W06 stale banner + diff of sources.

## Scope
- Auto-run on LIVE_STALE (and via the endpoint): proposal pre-seeded with the old schema (same names/types), self-check + repair (SP-012b); new PROPOSED version; approve → LIVE, `stale_since=null`, re-extract.
- Banner: "Last good extract 6 h ago; the site changed layout." with Review.

## Acceptance criteria
- [ ] v2 layout → re-proposal keeps every field name; approve → LIVE; records updated with no field renames.

## Test plan
Recorded-mode golden test for the v2 Listing.
