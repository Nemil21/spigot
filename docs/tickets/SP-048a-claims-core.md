# SP-048a: Claims core: `/v1/claims`, eligibility, MISSING_FIELD / DUPLICATE, CREDIT, locked abuse limit

- **Priority:** P1 (spec P1 #2)
- **Wave:** 6
- **Estimate:** 1.5
- **Depends on:** SP-017b
- **Spec refs:** features/10-claims-refunds.md §Claims 1, 2, 4, 5, §Acceptance criteria; data-model.md §claims, §Postings (CREDIT); api.md §`POST /v1/claims`

## Goal
A buyer reports a junk record and gets the per-record price back at once when Spigot can confirm it.

## Files / modules
`apps/api/src/claims/create.ts`, `checks.ts`, `credit.ts`; route `POST /v1/claims`; `security/tenancy/claims.cases.ts`. (STALE / REMOVED re-fetch and the MCP tool are SP-048c.)

## Scope
- Eligibility: call ≤ 7 days old; record key present in that call's **`served_record_keys`** (kept 7 days; `response_body` is purged after 24 h, SP-019); one claim per record per call.
- Deterministic checks here: `MISSING_FIELD` → a required field was null in the served record (hash in `served_record_keys` + the record's version at that time); `DUPLICATE` → two served records share a hash. `STALE` / `REMOVED` stay `OPEN` until SP-048c lands its re-fetch check. Else `OPEN`.
- Credit, in one transaction:
  1. `SELECT … FROM buyers WHERE id=$1 FOR NO KEY UPDATE` (not `FOR UPDATE`: data-model rule 11) and evaluate the **abuse limit** under that lock (credits ≤ 10% of the buyer's charges over 7 days; above it the claim stays OPEN).
  2. Conditional `UPDATE api_calls SET credited_micros = credited_micros + $unit WHERE id=$1 AND credited_micros + $unit <= price_micros`; 0 rows → nothing to credit.
  3. `ledger.post(CREDIT, key 'claim:'+id)` reversing the split with the call's **snapshotted `commission_bps`** (SP-016), so a later commission change doesn't unbalance the call.
  4. Call → PARTIALLY_CREDITED / CREDITED.
- Audit `CLAIM_DECIDED`.

## Acceptance criteria
- [ ] MISSING_FIELD and DUPLICATE claims → AUTO_CREDITED; CREDIT posted; publisher payable reduced.
- [ ] A claim 3 days after the call (body already purged) is still checked from `served_record_keys`.
- [ ] After a commission change, a credit reverses with the call's snapshotted rate (ledger check passes).
- [ ] Claim on a record not in the call → 422.
- [ ] Ledger check passes after claims.

## Race / idempotency tests
- Same claim submitted 10× in parallel → one claim, one CREDIT.
- 10 different claims in parallel that together exceed the 10% limit → credits stop at the limit, the rest OPEN.
- Credits can never push `credited_micros` above `price_micros`.

## Test plan
Integration (`*.db.test.ts`).
