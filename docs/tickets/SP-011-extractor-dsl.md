# SP-011: Extractor DSL `extract.ts`, safe JSONPath, transforms whitelist, canonical JSON + hash (pure)

- **Priority:** P0
- **Wave:** 1
- **Estimate:** 1.5
- **Depends on:** none
- **Spec refs:** features/04-ai-schema-extractor.md §3 Extractor DSL; features/05 §Logic 1 (canonicalize + hash); data-model.md §schema_versions.extractor, §record_key

## Goal
The deterministic extractor Claude writes once and plain code runs on every page with no AI call: `(html, spec, pageUrl) → record | null`.

## Files / modules
`packages/shared/src/extract/` — `spec.ts` (Zod schema of the extractor spec: fields, `source`, `transforms`, `type`, `recordKey`), `extract.ts`, `transforms.ts`, `coerce.ts`, `canonical.ts` (`canonicalize`, `sha256` via an injected hasher so the web bundle stays Node-free), `index.ts`. Runtime deps: `cheerio`, `jsonpath-plus`, `re2-wasm` (or a vetted safe-regex check).

## Scope
- `source`: `{jsonld: <JSONPath>}` over all JSON-LD blocks (first match) or `{css, attr: 'text' | <attr>, all?}`.
- Transforms whitelist: `trim`, `lower`, `toInt`, `toFloat`, `firstInt`, `money`, `date`, `datetime`, `absoluteUrl`, `split:<sep>`, `bool:<word>`, `regex:<pattern>` (RE2-safe, ≤ 100 chars, first group). Unknown transform → spec rejected by Zod.
- Types: `string`, `integer`, `number`, `boolean`, `date`, `datetime`, `url`, `string[]`; failed coercion → `null`.
- Returns `url` alongside the record (metadata, not hashed).
- `recordKey`: `{from: 'url'}` → last path segment, or `{jsonld: path}`.
- Returns `null` when every required field is null.
- `canonicalize(data)`: sorted keys, normalized numbers, ISO dates; `hash = sha256(canonical)`.
- No `eval`, no `Function`, no dynamic import.
- **JSONPath is model-written, so treat it as hostile:** pin `jsonpath-plus` ≥ the release that fixes CVE-2024-21534 and call it with `eval: false`; the Zod spec only allows dot / bracket / numeric-index segments (`^\$(\.[A-Za-z_@][\w@-]*|\['[^'\]]+'\]|\[\d+\])+$`), so no `?()` filters or script expressions ever reach the evaluator.
- **`updated_at` stays out of the hash:** `canonicalize` hashes the extracted fields only; `url` and `updated_at` are metadata attached after hashing (SP-013 sets `records.updated_at` on content change).
- **Record keys don't include the dataset slug:** `recordKey {from:'url'}` → last path segment (`2br-east-cesar-chavez-4471`). The API prefixes `<dataset-slug>/` when serializing (SP-015), so a slug rename doesn't remove and re-add every record.

## Acceptance criteria
- [ ] Each transform and type coercion has table tests.
- [ ] A hand-written Listing spec on demo fixtures extracts `price_usd`, `bedrooms` from JSON-LD and `available_from`, `pets_allowed` from CSS.
- [ ] Key order or whitespace changes give the same hash.
- [ ] A `regex:` with catastrophic backtracking or > 100 chars is rejected.
- [ ] Extracting 2,341 fixture pages takes < 10 s locally.
- [ ] A malicious path (`$..[?(@.constructor.constructor('return process')())]`, or any `?(`) is rejected by the spec schema and never evaluated.
- [ ] Re-extracting the same HTML with a different crawl time gives the same hash.

## Test plan
Unit over hand-written fixture HTML that follows features/01 (shared with SP-010); SP-012a re-runs on real SP-004a pages.

## Notes & risks
- **Wave 1 start:** pure module; starts against the agreed layout and rebases on SP-001a before merging.
