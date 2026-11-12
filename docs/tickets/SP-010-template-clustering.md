# SP-010: Template clustering + cleaned DOM outline (pure)

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1
- **Depends on:** SP-001a
- **Spec refs:** features/04-ai-schema-extractor.md §1 Template clustering, §2 Proposal (input); data-model.md §templates

## Goal
Group pages into templates with plain code, and prepare the compact page view Claude reads.

## Files / modules
`packages/shared/src/cluster.ts` (`clusterUrls(urls, jsonLdTypesByUrl) → Template[]`), `apps/api/src/schema-agent/outline.ts` (`jsonLdBlocks(html)`, `domOutline(html)` with cheerio), fixtures from the demo site HTML (`apps/api/src/schema-agent/__fixtures__/`).

## Scope
- Split paths into segments; segments varying across ≥ 20 pages with slug/number shapes become `:param` → regex `url_pattern`; split groups by JSON-LD `@type` when mixed; drop groups with < 10 pages; pick 5 random `sample_page_ids` (seeded).
- `domOutline`: main content only, scripts/styles removed, text truncated to 200 chars per node, each node annotated with a candidate CSS selector; cap ~12k tokens per page (char-based estimate).
- `jsonLdBlocks`: all `application/ld+json` blocks, parsed, verbatim.

## Acceptance criteria
- [ ] On the demo site URLs: exactly `/listings/:slug` (2,341), `/agents/:slug` (88), `/open-houses/:id` (40); `/blog/*` (10) and `/about` dropped.
- [ ] Outline of a listing page contains `dl.facts dd[data-k=available]` selector and stays under the cap.
- [ ] Deterministic sample ids for the same input.

## Test plan
Unit on fixture URL lists and HTML.

## Notes & risks
DOM-fingerprint confirmation is P1 (SP-065).
