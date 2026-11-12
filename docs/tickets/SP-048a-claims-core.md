# SP-048a: Claims core: `/v1/claims`, MCP `report_bad_record`, deterministic checks, CREDIT

- **Priority:** P1 (spec P1 #2)
- **Wave:** 6
- **Estimate:** 2
- **Depends on:** SP-017b, SP-009a, SP-022a
- **Spec refs:** features/10-claims-refunds.md §Claims 1, 2, 4, 5, §Acceptance criteria; data-model.md §claims, §Postings (CREDIT); api.md §`POST /v1/claims`

## Goal
A buyer reports a junk record and gets the per-record price back at once when Spigot can confirm it.

## Files / modules
`apps/api/src/claims/create.ts`, `checks.ts`, `credit.ts`; route `POST /v1/claims`; MCP tool `report_bad_record`.

## Scope
- Eligibility: call ≤ 7 days old; record key present in that call's stored `response_body`; one claim per record per call.
- Deterministic checks: `REMOVED`/`STALE` → one targeted `fetchPage` (crawl key) + extract → differs on a visible field or page gone → `AUTO_CREDITED` (the change flows into the feed as usual); `MISSING_FIELD` → required field null in the served body; `DUPLICATE` → two records with the same hash in the response. Else `OPEN`.
- Credit = call's `unit_price_micros`; `ledger.post(CREDIT, key 'claim:'+id)` reversing the split; call → PARTIALLY_CREDITED / CREDITED; `credited_micros` updated.
- Abuse limit: credits ≤ 10% of the buyer's charges over 7 days; above it claims stay OPEN.
- Audit `CLAIM_DECIDED`.

## Acceptance criteria
- [ ] Fetch a listing → `demo:mutate` leases it (no crawl) → claim STALE → AUTO_CREDITED; CREDIT posted; publisher payable reduced; change appears in the feed.
- [ ] Claim on a record not in the call → 422.
- [ ] Ledger check passes after claims.

## Race / idempotency tests
Same claim submitted 10× in parallel → one claim, one CREDIT.

## Test plan
Integration with the demo site in-process.
