# SP-015: Records query (filters, sort, keyset cursor, `fieldExpr`) + changes reader (watermark, hidden-field stripping)

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a, SP-002, SP-011
- **Spec refs:** features/05 §Logic 4–7, §Edge cases; features/06 §Filters; api.md §records, §changes; data-model.md rule 13

## Goal
The two read primitives the paid API sells, safe against injection and incapable of leaking hidden fields.

## Files / modules
`apps/api/src/records/filters.ts` (parser + SQL builder, exports `fieldExpr(field, type)` that SP-014a also uses for its expression indexes), `query.ts` (`queryRecords`, `countRecords`, `getRecord`), `changes.ts` (`readChanges`), `serialize.ts` (visible-field allowlist), `cursor.ts`.

## Scope
- Filter parser: `field[op]=value` (REST) and `[{field, op, value}]` (MCP) → same AST, built on SP-011's field-spec types (`type`, `visible`, `filterable`). Fields must be in the active schema, `visible` and `filterable`; ops from that field's list (`eq`, `lt`, `lte`, `gt`, `gte`, `in` for strings, max 50 values); `updated_at[gte]` always allowed; values coerced by type; unknown → `UNSUPPORTED_FILTER` listing valid fields.
- SQL: parameters only; field names from the allowlist, quoted with `quote_literal`-style escaping never derived from input; casts by schema type (`(data->>'price_usd')::int`). `removed_at IS NULL`; **`sort` accepts only `updated_at` and `-updated_at`** (anything else → 400; a free sort field would leak a hidden field's order); order `records.updated_at DESC, id`; keyset cursor base64 `(updated_at, id, datasetId)`; cursor from another dataset → 400.
- `countRecords` for quotes (capped at `limit`).
- `readChanges(dataset, since, limit, includeRecord)`: `seq > since AND seq <= published_seq ORDER BY seq`; cursor `c_<base64url(datasetId:seq)>` (opaque; a cursor from another dataset → 400 as spec 05 requires); `since` omitted → empty list + cursor at the watermark; `since=0` → full history; older than 30-day retention → 410 `CURSOR_EXPIRED`; drop patch ops on hidden paths; strip hidden keys from `add` values and `include=record`; changes whose ops were all hidden are skipped and not counted.
- `serialize(schema, rows)`: builds output **only** from `visible=true` fields + `freshness {crawledAt, sourceLastmod, staleSince}`; record `key` = `<dataset-slug>/<stored key>`; `updated_at` from `records.updated_at`.

## Acceptance criteria
- [ ] Injection strings (`price_usd[lt]=1;DROP TABLE`, `"data->>'x' OR 1=1"` as field, `sort=agent_phone`, `sort=price_usd;--`) → 400, no SQL error.
- [ ] A changes cursor from dataset A used on dataset B → 400.
- [ ] A hidden field can't be filtered (400) or appear in records, patches or `include=record` output.
- [ ] Keyset pagination over 2,341 records returns each exactly once.
- [ ] Changes reader never returns `seq > published_seq`.

## Test plan
Unit: parser table. Integration: fixture records + versions on Postgres.
