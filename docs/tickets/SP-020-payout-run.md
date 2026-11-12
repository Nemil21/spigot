# SP-020: `payoutRun`: batch build, PAYOUT_SENT, SUBMITTED, `pp.payout`, crash-resume, INSUFFICIENT_FUNDS

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1.5
- **Depends on:** SP-001c, SP-005, SP-003
- **Spec refs:** features/09-payouts-commission.md §Money math, §Logic 1–6, §Edge cases; data-model.md §payout_batches, §payout_items, §Payout item state machine, rules 5, 10

## Goal
Publishers get paid in batched PayPal Payouts, net of commission, and a crash or double click never pays twice.

## Files / modules
`apps/api/src/payouts/payoutRun.ts`, `buildBatch.ts`, `submit.ts`, exported from `@spigot/api/tasks`.

## Scope
- `payoutRun({trigger: 'SCHEDULE'|'MANUAL_DEMO', thresholdCentsOverride?})`:
  1. Check out **one pooled client for the whole run** and take `pg_advisory_lock('payout')` on it (session lock, `pg_advisory_unlock` in `finally` before the client is released, so the lock never leaks back into the pool).
  2. Resume first: any batch in `BUILDING` with items → go to step 5 with the same ids.
  3. One transaction: insert `payout_batches` BUILDING (`id` = `sender_batch_id`); for each publisher with `microsToCentsFloor(payable) ≥ threshold` (override labelled demo, min $1) and **no PENDING/UNCLAIMED item**: insert `payout_items` (`id` = `sender_item_id`, `receiver_email` snapshot, `net_cents`, statement `gross_micros`/`commission_micros` from the period's CHARGE/CREDIT txns) and `ledger.post(PAYOUT_SENT, key 'payout_item:'+id)`. No items → delete batch, return.
  4. Note: sub-cent remainder stays in payable.
  5. `pp.payout` (`email_subject: "Your Spigot earnings"`, note "Spigot: N records sold, <period>") → 201 → batch PENDING, items PENDING, save `paypal_batch_id`; audit `PAYOUT_SENT` per item.
  4b. Before the PayPal call, `transition(batch, BUILDING → SUBMITTED)` so a crash after the call is distinguishable from one before it.
  6. Network/5xx → retry with the same `sender_batch_id` (3 tries). A duplicate-batch error (shape recorded by SP-003 S10, modelled by SP-001c): if it carries a `payout_batch_id`, save it and continue to PENDING; **if it doesn't** (Payouts v1 has no lookup by `sender_batch_id`), set `payout_batches.needs_reconcile`, keep items PENDING, raise an alert, and resolve later from the webhook (its payload has `sender_batch_id`, SP-059) or `POST /admin/payouts/:batchId/reconcile {paypalBatchId}`.
  7. Definite 4xx (incl. **`422 INSUFFICIENT_FUNDS`**, which creates no batch at PayPal) → `PAYOUT_RETURNED` for every item (key **`payout_returned:<itemId>`**, the same key SP-021 uses), items FAILED with `error_code`, batch FAILED, alert row ("Fund the sandbox merchant or lower the demo threshold"). The next run builds a new batch.
- Commission defaults: `commission_bps` 2000, threshold $10.

## Acceptance criteria
- [ ] After charges, a run creates one batch with one item per eligible publisher; `net_cents = floor(payable / 10,000)`; remainder left in payable.
- [ ] A second immediate run creates no items.
- [ ] Crash after PAYOUT_SENT and before the PayPal call → next run resubmits the same `sender_batch_id`; one payout at PayPal.
- [ ] `INSUFFICIENT_FUNDS` → payable restored, batch FAILED, alert; ledger check passes.
- [ ] Sandbox: a $1–$50 item to the separate publisher account → 201 PENDING.
- [ ] A crash after SUBMITTED and before the response → the next run resubmits the same `sender_batch_id`; a duplicate response without a batch id leaves `needs_reconcile` and money in flight, not a second payout.
- [ ] An item returned on a 4xx can't be returned again by SP-021's poller (same `payout_returned:<itemId>` key).
- [ ] After the run, the advisory lock is released (a second run on a different pooled client can take it).

## Race / idempotency tests (FakePayPal)
- Two `payoutRun` in parallel → one batch, one item per publisher.
- Response lost after PayPal accepted the batch → retry with the same `sender_batch_id` → no second payout; batch PENDING.
- Injected `INSUFFICIENT_FUNDS` and `SELF_PAY_NOT_ALLOWED` paths.

## Test plan
Integration (FakePayPal) in CI; one sandbox run by hand.

## Notes & risks
- **Payout receiver must be a separate sandbox business account** (`DEMO_PUBLISHER_PAYOUT_EMAIL`); paying the merchant itself fails `SELF_PAY_NOT_ALLOWED` (Holdfast S7).
- **Keep demo payouts small.** In Holdfast S7 the sandbox merchant refused ≥ $2,500 (`INSUFFICIENT_FUNDS`) even after large captures; $1,000 worked. The SIM week (~$500 gross, ~$400 net) is fine; if not, pre-fund the merchant sandbox account.
