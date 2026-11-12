# SP-017a: Paid-read service layer: `paidRead`, `quote`, catalog, 402 contract builder

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-015, SP-016
- **Spec refs:** features/06-buyer-api-pricing.md §Request pipeline, §Pricing, §402 shapes, §Edge cases; api.md §The 402 contract, §Buyer data API

## Goal
One service function per endpoint, shared by REST (SP-017b) and MCP (SP-022a), so quotes, caps, 402s, idempotency and audit are identical on both channels.

## Files / modules
`apps/api/src/services/paidRead.ts`, `quote.ts`, `catalog.ts`, `describe.ts`, `balance.ts`, `payment402.ts` (402 bodies: `PAYMENT_REQUIRED`, `INSUFFICIENT_BALANCE` + `quote` + `balanceMicros` + `topUpUrl`, `PRICE_ABOVE_MAX` + `maxPriceMicros`; messages from `@spigot/shared/copy`, SP-001d).

## Scope
- `paidRead(ctx, {site, dataset, kind: 'records'|'record'|'changes', filters, limit, cursor, maxPriceMicros, idempotencyKey, channel})`: idempotency lookup first → dataset must be LIVE/LIVE_STALE (else 410 `DATASET_UNPUBLISHED`) → query (limit ≤ `max_records_per_call`) → serialize → `price = n × unit` (records or changes) → `price > (maxPriceMicros ?? buyer.per_call_max_micros)` → 402 `PRICE_ABOVE_MAX` with the quote, no row → `chargeAndRecord`.
- `quote(ctx, …)` → `{records, unitPriceMicros, priceMicros, display, balanceMicros, wouldAutoTopUp, validForSeconds: 60}` (count query only).
- `catalog()` (LIVE datasets with counts, prices, freshness), `describe(site, dataset)` (visible fields, filterable ops, pricing, license URL).
- `balance(ctx)` → balance + auto top-up status.
- Unauthenticated paid call → `PAYMENT_REQUIRED` body with the **same shape** as the gate's (parity test against `@spigot/gate`'s `build402`).
- `channel` (`REST`/`MCP`) and `actor_type` recorded on `api_calls`; audit is written by `chargeAndRecord` (SP-016, SIM sampled 1 in 20).
- `paidRead` passes `servedKeys` (record keys + hashes of what it returns) to `chargeAndRecord` for claims (SP-048a).

## Acceptance criteria
- [ ] Quote equals the later charge for the same query when nothing changed.
- [ ] `maxPriceMicros` below the price → 402 with the quote and no ledger txn and no `api_calls` row.
- [ ] UNPUBLISHED → 410, no charge.
- [ ] 402 body parity with the gate's builder.
- [ ] Unit price is snapshotted: an owner price change mid-call doesn't change the charge.

## Test plan
Integration on Postgres with fixture dataset + records + funded buyer.
