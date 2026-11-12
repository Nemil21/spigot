# SP-012b: Schema agent self-check + repair, JSON-LD-only fallback

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-012a
- **Spec refs:** features/04-ai-schema-extractor.md §4 Self-check and repair, §Edge cases; features/14 §AI safety

## Goal
Proposals are checked on unseen pages and repaired before an owner sees them, and the demo survives a Claude outage. (The injection fixture moved to SP-012a, on the spine.)

## Files / modules
`apps/api/src/schema-agent/selfcheck.ts`, `repair.ts` (`repair_fields` tool), `fallback.ts` (JSON-LD-only auto-schema), fixture `__fixtures__/injection-listing.html`.

## Scope
- Run the extractor on 20 pages (5 seen + 15 unseen): per-field null rate, type conformance, distinct values → `sample_stats`.
- Required field null rate > 5% or any field > 30% → `repair_fields` call with failing field, 3 failing outlines, values found; max 2 rounds; still failing → field dropped with a note in `ai_rationale`.
- Model unavailable / rate-limited: retry with backoff (3 tries); then JSON-LD-only auto-schema (flatten JSON-LD props to typed fields, no AI) labelled "auto (no AI)".
- Replaces SP-012a's identity `selfCheck()` seam; runs before persist.

## Acceptance criteria
- [ ] Listing proposal required fields have null rate ≤ 2% after self-check.
- [ ] A recorded proposal with a broken CSS selector is repaired in ≤ 2 rounds (recorded repair response).
- [ ] With Claude stubbed to 529, a JSON-LD-only Listing proposal appears, labelled.

## Test plan
Recorded-mode unit tests for repair; fallback test.
