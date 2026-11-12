# SP-021: Payout status poll + item reconcile, payouts API, "Run payout now" endpoint

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-020, SP-007a
- **Spec refs:** features/09 §Logic 7–8, §Acceptance criteria; api.md §`GET /api/publishers/me/payouts`, §`POST /admin/payouts/run`; data-model.md §Payout item state machine

## Goal
Payout pills flip Sent → Paid out from PayPal's real item statuses, with the ledger following.

## Files / modules
`apps/api/src/payouts/reconcile.ts` (`applyItemStatus`, shared with SP-059 webhooks), `poll.ts`, routes `GET /api/publishers/me/payouts`, `POST /api/publishers/me/payouts/run` (demo publisher only), `POST /admin/payouts/run`.

## Scope
- Poll each PENDING batch every 60 s for 30 min after submit (`runEvery`) via `pp.getPayoutBatch`.
- `applyItemStatus(itemId, paypalStatus, paypalItemId, errorCode)` with conditional transitions:
  - `SUCCESS` → item SUCCESS + `PAYOUT_SETTLED` (key `payout_settled:'+id`);
  - `UNCLAIMED` → UNCLAIMED (still in flight), alert "claim it with publisher@…";
  - `FAILED|BLOCKED|DENIED|RETURNED|REFUNDED` → FAILED/RETURNED + `PAYOUT_RETURNED` (back to payable);
  - batch SUCCESS when all items succeeded, else PARTIAL / DENIED.
- `notify('publisher_events', {type: 'payout.updated'})`; audit with PayPal ids.
- Run-now endpoints call `payoutRun('MANUAL_DEMO', {thresholdCentsOverride: 100})`; publisher route only for `is_demo` publisher (seeded) and labelled "demo control".
- `GET /api/publishers/me/payouts`: batches → items with statuses, ids, statement figures; next-payout card data (payable, threshold, next Monday).

## Acceptance criteria
- [ ] Sandbox: run now → PENDING → SUCCESS within the poll window; ledger check passes with in-flight = 0.
- [ ] UNCLAIMED (S10 unregistered email) shows as UNCLAIMED and stays in flight.
- [ ] Applying the same status twice posts one ledger txn.
- [ ] Non-demo publisher can't call run-now (403).

## Race / idempotency tests (FakePayPal)
Poller and a simulated webhook applying SUCCESS for the same item concurrently → one `PAYOUT_SETTLED`.

## Test plan
Integration (FakePayPal statuses), one sandbox run.
