# 06: Buyer API, Pricing & 402

**Priority:** P0 · **Owner:** B · **Effort:** 2.5 h

## Purpose
Give buyers typed endpoints per record type, a free quote, and a clear 402 when they can't pay. One service function per endpoint, shared by REST and MCP.

## User stories
- As an agent builder, I read the schema for free, quote a query for free, and pay only for records returned.
- As an agent builder, I set a per-call price cap and never get a surprise charge.
- As a scraper author who hit the gate's 402, I land on a page that tells me exactly how to get the data legitimately.
- As a site owner, I set my price per 1,000 records and per 1,000 changes.

## Screens
W06 (price inputs + endpoint preview) · W13 Public catalog · W15 Error copy

## Endpoints
As in [api.md](../api.md#buyer-data-api-v1-api-key): `GET /v1/catalog`, `GET /v1/:site/datasets/:dataset` (schema), `…/quote`, `…/records`, `…/records/:key`, `…/changes`, `GET /v1/balance`.

## Pricing
- Owner sets `price_per_record_micros` (default 1,500 = $1.50 / 1,000) and `price_per_change_micros` (default 500).
- Price of a call = `records_returned × unit` (records) or `changes_returned × unit` (changes). No per-call fee; zero results cost nothing.
- Unit price is snapshotted onto `api_calls.unit_price_micros` (owner price edits don't change past charges or an in-flight call).
- Bounds: 100–100,000 micros per record ($0.10–$100 per 1,000).
- The W06 helper shows a comparison: "Scraping this yourself: proxies + headless + maintenance. Spigot: $3.51 for all 2,341 listings, always current." No made-up competitor numbers in the UI; the research numbers go in the README with sources.

## Request pipeline (`services/paidRead.ts`)
```ts
async function paidRead(ctx, { dataset, kind, filters, limit, cursor, maxPriceMicros, idempotencyKey }) {
  const key = idempotencyKey ?? autoKey(ctx.apiKeyId, canonical(req));
  const prior = await calls.find(ctx.apiKeyId, key);
  if (prior) return prior.requestHash === hash(req) ? replay(prior) : conflict('IDEMPOTENCY_MISMATCH');
  const ds = await datasets.liveOrThrow(dataset);                 // 410 if UNPUBLISHED
  const rows = kind === 'records' ? await records.query(ds, filters, clamp(limit, ds.max)) : await changes.read(ds, cursor, limit);
  const body = serialize(ds.activeSchema, rows);                  // visible fields only (allowlist)
  const price = rows.length * unit(ds, kind);
  if (price > (maxPriceMicros ?? ctx.buyer.perCallMax)) throw payment('PRICE_ABOVE_MAX', quoteOf(rows, price));
  return ledger.chargeAndRecord(ctx, ds, key, req, body, price); // 07: one txn; 402 INSUFFICIENT_BALANCE if short
}
```
- The query runs **before** the charge so the price is exact; it's a read, so a 402 costs us only the query.
- Auto top-up (08, P1) is attempted inside `chargeAndRecord` when the balance is short.

## Filters
- Field names must be in the active schema and marked `filterable`; ops from that field's list (`eq`, `lt`, `lte`, `gt`, `gte`, `in` for strings).
- Values coerced by field type; SQL built with parameters only (`(data->>$field)::int < $1`, field name from the allowlist, never from input).
- `updated_at[gte]` always allowed.
- `limit` default 50, max `max_records_per_call` (100; owner can raise to 1,000).

## Rate limits
60 calls/min per API key on REST; 30/min via MCP (11). 429 with `Retry-After`.

## 402 shapes
Same body as the gate's (api.md "The 402 contract"), plus:
- `INSUFFICIENT_BALANCE`: `quote`, `balanceMicros`, `topUpUrl`, and for MCP a `top_up` hint.
- `PRICE_ABOVE_MAX`: `quote`, `maxPriceMicros`, hint to narrow filters.
- Unauthenticated call to a paid endpoint: `PAYMENT_REQUIRED` with the catalog link (same as the gate).

## Edge cases
| Case | Handling |
|---|---|
| Dataset LIVE_STALE | Serve with `staleSince`; still charged (buyer can claim, 10) |
| Owner changes price between quote and call | Call uses the price at call time; quote has `validFor: 60s` hint only |
| Owner unpublishes | 410; no charge |
| Huge `in` list | Max 50 values |
| Buyer passes hidden field in filters | `UNSUPPORTED_FILTER` (hidden fields are neither filterable nor visible) |

## Acceptance criteria
- [ ] Quote equals the later charge for the same query when no records changed in between.
- [ ] Zero-result calls are `NOT_CHARGED` and return 200.
- [ ] `max_price_micros` below the price returns 402 with the quote and no ledger txn.
- [ ] A hidden field can't be read or filtered by any endpoint (test each).
- [ ] An unauthenticated call returns the same 402 body shape as the gate.

## Test plan
Unit: filter parser (allowlist, ops, coercion, injection strings). Integration: quote → search → balance math; price-above-max; unpublished → 410.
