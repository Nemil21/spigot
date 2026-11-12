# SP-028: W05 Record types found (hero)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-024, SP-014
- **Spec refs:** screens.md §W05; features/04 §Purpose; features/13 §2; features/12 video 0:45–1:15

## Goal
The delight moment on screen: **"I found 3 kinds of records on your site."**

## Files / modules
`apps/web/src/pages/RecordTypes.tsx`, `components/ProposalCard.tsx`.

## Scope
- Headline from the proposals count; one card per proposal: type name + record count ("Listing · 2,341"), URL pattern, source badge (JSON-LD / CSS / auto (no AI)), 4 key fields, field quality bar (null rates), suggested price, tiny AG Grid of 5 sample rows (auto columns), Review → W06, Reject.
- "How this works": "Claude wrote the extractor once. It now runs with no AI on each page."; expandable agent rationale.
- States: proposing (cards stream in via SSE `proposal.ready`, a "reading 5 sample pages…" line per template), ready, one failed ("Couldn't find consistent fields on /blog/*; skipped"), none.

## Acceptance criteria
- [ ] After a live discovery crawl, three cards appear without a reload.
- [ ] Reject moves the card out; Review opens W06 for that dataset.
- [ ] Hidden-by-default PII fields are shown with a PII badge, not in the 4 key fields.

## Test plan
Component tests (fixtures + SSE mock); manual run on the demo site.
