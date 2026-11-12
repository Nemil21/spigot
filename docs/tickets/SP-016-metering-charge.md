# SP-016: Metering: `chargeAndRecord`, client idempotency, charge-on-2xx, commission split

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1.5
- **Depends on:** SP-005
- **Spec refs:** features/07-ledger-metering.md §`chargeAndRecord`, §Edge cases, §Acceptance criteria; data-model.md §api_calls, §API call state machine, rules 3–4

## Goal
A buyer is charged exactly once, only for a response we fully built and stored; retries replay for free.

## Files / modules
`apps/api/src/meter/charge.ts` (`chargeAndRecord`), `idempotency.ts` (`autoKey`, `requestHash`, lookup/replay), `quote.ts` (`price = n × unit`).

## Scope
- `chargeAndRecord(ctx, {dataset, endpoint, idempotencyKey, request, body, unitPriceMicros, count, isSimulated})` in one transaction:
  1. Insert `api_calls` RECEIVED (unique `(api_key_id, idempotency_key)`); conflict → same `request_hash` → return the stored response with `replay: true`; different hash → 409 `IDEMPOTENCY_MISMATCH`.
  2. `price = 0` → `NOT_CHARGED`, store body, commit.
  3. `ledger.post(CHARGE, key 'charge:'+callId, buyer −price, publisher +(price − commission), platform +commission)` with the publisher's `commission_bps`.
  4. `InsufficientBalance` → (hook for SP-047a auto top-up: `onInsufficient` returns retry or not) → status `PAYMENT_REQUIRED`, store the 402 body, commit, return 402.
  5. CHARGED with `price_micros`, `unit_price_micros` snapshot, `charge_txn_id`, `response_body`, `http_status=200`; commit; `notify('publisher_events', {type:'call.charged'})`.
- `autoKey` when the client sends none: `auto:` + sha256(key id, request hash, minute bucket).
- Returns `{status, body, balanceMicros, chargedMicros, callId, replay}` for headers.

## Acceptance criteria
- [ ] 50 parallel identical calls with one key → exactly one CHARGE, 49 replays with the same body.
- [ ] 50 parallel different calls on a $0.05 balance → total charged ≤ $0.05; the rest 402; no negative balance.
- [ ] A forced exception after the query and before commit → no CHARGE and no CHARGED row.
- [ ] Same key, different request → 409.
- [ ] Zero records → 200, `NOT_CHARGED`, no ledger txn.

## Race / idempotency tests
The two 50-way races above on real Postgres; plus "client disconnects after commit, retries" → replay, no new charge.

## Test plan
Integration on Postgres (CI `db` job line `apps/api/src/meter`).
