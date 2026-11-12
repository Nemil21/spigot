# SP-011: Extractor DSL `extract.ts`, transforms whitelist, canonical JSON + hash (pure)

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a
- **Spec refs:** features/04-ai-schema-extractor.md §3 Extractor DSL; features/05 §Logic 1 (canonicalize + hash); data-model.md §schema_versions.extractor, §record_key

## Goal
The deterministic extractor Claude writes once and plain code runs on every page with no AI call: `(html, spec, pageUrl) → record | null`.

## Files / modules
`packages/shared/src/extract/` — `spec.ts` (Zod schema of the extractor spec: fields, `source`, `transforms`, `type`, `recordKey`), `extract.ts`, `transforms.ts`, `coerce.ts`, `canonical.ts` (`canonicalize`, `sha256` via an injected hasher so the web bundle stays Node-free), `index.ts`. Runtime deps: `cheerio`, `jsonpath-plus`, `re2-wasm` (or a vetted safe-regex check).

## Scope
- `source`: `{jsonld: <JSONPath>}` over all JSON-LD blocks (first match) or `{css, attr: 'text' | <attr>, all?}`.
- Transforms whitelist: `trim`, `lower`, `toInt`, `toFloat`, `firstInt`, `money`, `date`, `datetime`, `absoluteUrl`, `split:<sep>`, `bool:<word>`, `regex:<pattern>` (RE2-safe, ≤ 100 chars, first group). Unknown transform → spec rejected by Zod.
- Types: `string`, `integer`, `number`, `boolean`, `date`, `datetime`, `url`, `string[]`; failed coercion → `null`.
- Always adds `url` and `updated_at` (lastmod or crawl time).
- `recordKey`: `{from: 'url'}` → `<dataset-slug>/<last path segment>` or `{jsonld: path}`.
- Returns `null` when every required field is null.
- `canonicalize(data)`: sorted keys, normalized numbers, ISO dates; `hash = sha256(canonical)`.
- No `eval`, no `Function`, no dynamic import.

## Acceptance criteria
- [ ] Each transform and type coercion has table tests.
- [ ] A hand-written Listing spec on demo fixtures extracts `price_usd`, `bedrooms` from JSON-LD and `available_from`, `pets_allowed` from CSS.
- [ ] Key order or whitespace changes give the same hash.
- [ ] A `regex:` with catastrophic backtracking or > 100 chars is rejected.
- [ ] Extracting 2,341 fixture pages takes < 10 s locally.

## Test plan
Unit over fixture HTML from SP-004a pages (committed snapshots).
