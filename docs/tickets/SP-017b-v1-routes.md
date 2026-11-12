# SP-017b: Buyer data API `/v1` routes, Spigot-* headers, max price, rate limit

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-017a, SP-007b
- **Spec refs:** api.md §Buyer data API (`/v1`); features/06 §Endpoints, §Rate limits

## Goal
The product's REST surface, as thin routes over SP-017a.

## Files / modules
`apps/api/src/routes/v1.ts` (+ Zod request/response schemas in `apps/api/src/routes/v1.schemas.ts`, reused by SP-023).

## Scope
- `GET /v1/catalog` (free, no key), `GET /v1/:site/datasets/:dataset` (free), `…/quote`, `…/records`, `…/records/:key`, `…/changes`, `GET /v1/balance`.
- Paid routes: Bearer key (`read` scope), `Idempotency-Key` header (optional), `max_price_micros` query.
- Headers on paid 2xx: `Spigot-Charged-Micros`, `Spigot-Balance-Micros`, `Spigot-Records`, `Spigot-Call-Id`, `Spigot-Replay: true` on replays.
- 402 responses carry the `Link`/`Spigot-Price` headers like the gate.
- Rate limit 60/min/key → 429 `RATE_LIMITED` + `Retry-After`.
- Paid endpoints with no key → 402 `PAYMENT_REQUIRED` (not 401) with the catalog link.

## Acceptance criteria
- [ ] curl walkthrough: catalog → describe → quote → records (charged, headers set) → retry with the same key (replay header, no charge).
- [ ] No key on `/records` → 402 with the gate-shaped body.
- [ ] 61st call in a minute → 429.
- [ ] Unknown filter → 400 `UNSUPPORTED_FILTER` listing valid fields.

## Test plan
Integration (supertest) per route; CI `db` job line.
