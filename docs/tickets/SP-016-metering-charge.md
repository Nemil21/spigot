# SP-016: Metering: `chargeAndRecord`, client idempotency (402 re-attempt), charge-on-2xx, commission snapshot

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 2
- **Depends on:** SP-005
- **Spec refs:** features/07-ledger-metering.md §`chargeAndRecord`, §Edge cases, §Acceptance criteria; data-model.md §api_calls, §API call state machine, rules 3–4

## Goal
A buyer is charged exactly once, only for a response we fully built and stored; retries replay for free.

## Files / modules
`apps/api/src/meter/charge.ts` (`chargeAndRecord`), `idempotency.ts` (`autoKey`, `requestHash`, lookup/replay), `quote.ts` (`price = n × unit`).

## Scope
- `chargeAndRecord(ctx, {dataset, endpoint, idempotencyKey, request, body, servedKeys, unitPriceMicros, count, isSimulated, simulatedAt?})` in one transaction:
  1. Insert `api_calls` RECEIVED (unique `(api_key_id, idempotency_key)`). On conflict, look at the existing row:
     - different `request_hash` → 409 `IDEMPOTENCY_MISMATCH`;
     - same hash and status `CHARGED` or `NOT_CHARGED` → replay the stored response (`replay: true`), no new charge; if its `response_body` was already purged (SP-019, 24 h) → **409 `IDEMPOTENCY_KEY_EXPIRED`**, never a second charge;
     - same hash and status `PAYMENT_REQUIRED` (or `REJECTED`) → **not terminal**: claim it with a conditional `UPDATE … SET status='RECEIVED' WHERE id=$1 AND status IN ('PAYMENT_REQUIRED','REJECTED')` and re-run steps 2–5 on that row (one winner if two retries race).
  2. `price = 0` → `NOT_CHARGED`, store body, commit.
  3. Snapshot the publisher's `commission_bps` onto `api_calls.commission_bps`, then `ledger.post(CHARGE, key 'charge:'+callId, buyer −price, publisher +(price − commission), platform +commission)` using that snapshot (SP-048a's credits reverse with the same number).
  4. `InsufficientBalance` (thrown after SP-005's savepoint rollback, so the transaction is still usable) → (hook for SP-047a auto top-up: `onInsufficient` returns retry or not) → status `PAYMENT_REQUIRED`, store the 402 body, commit, return 402.
  5. CHARGED with `price_micros`, `unit_price_micros` snapshot, `charge_txn_id`, `response_body`, `served_record_keys` (keys + hashes, kept 7 days for claims), `http_status=200`; commit; `notify('publisher_events', {type:'call.charged'})`.
- **Audit:** `CALL_CHARGED` row for every real charge; **SIM charges are sampled 1 in 20** (feature 14's "sampled for SIM"), by `hash(callId) % 20 = 0` so it's deterministic.
- `simulatedAt` is passed through to the `api_calls` insert and to `ledger.post` only when the buyer `is_simulated` (SP-036); otherwise rejected.
- `autoKey` when the client sends none: `auto:` + sha256(key id, request hash, **minute bucket**). The bucket is deliberate (without it a buyer polling the same query gets stale replays forever); this ticket updates data-model.md rule 4 to say so, and SP-023 documents "send `Idempotency-Key` for exact retry safety".
- Returns `{status, body, balanceMicros, chargedMicros, callId, replay}` for headers.

## Acceptance criteria
- [ ] 50 parallel identical calls with one key → exactly one CHARGE, 49 replays with the same body.
- [ ] 50 parallel different calls on a $0.05 balance → total charged ≤ $0.05; the rest 402; no negative balance.
- [ ] A forced exception after the query and before commit → no CHARGE and no CHARGED row.
- [ ] Same key, different request → 409.
- [ ] Zero records → 200, `NOT_CHARGED`, no ledger txn.
- [ ] A short-balance call commits a `PAYMENT_REQUIRED` row with the 402 body (needs SP-005's savepoint) and no ledger txn.
- [ ] **402 → top-up → retry with the same key → 200, charged exactly once**; the row moves PAYMENT_REQUIRED → CHARGED.
- [ ] Replay of a CHARGED call whose body was purged → 409 `IDEMPOTENCY_KEY_EXPIRED`, no ledger txn.
- [ ] `api_calls.commission_bps` equals the publisher's rate at charge time even if it changes afterwards.
- [ ] 100 SIM charges write ~5 `CALL_CHARGED` audit rows (deterministic set); 100 real charges write 100.

## Race / idempotency tests
The two 50-way races above on real Postgres; plus "client disconnects after commit, retries" → replay, no new charge.
- Two retries of the same PAYMENT_REQUIRED key racing after a top-up → one CHARGE, the other replays it.

## Test plan
Integration on Postgres (`apps/api/src/meter/*.db.test.ts`, picked up by the `db` project; no `ci.yml` edit).
