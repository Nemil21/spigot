# 09: Payouts & Commission

**Priority:** P0 (manual "Run payout now" batch, poll status) · P1 (weekly cron, webhooks, retry of failed items) · **Owner:** B · **Effort:** 2.5 h

## Purpose
Close the loop: the site owner earns money from bots and gets it in their PayPal account. Earnings accrue per call in the ledger and go out in **batched PayPal Payouts** (weekly, or when payable ≥ $10), so per-payout fees stay small.

## User stories
- As a site owner, I see "Next PayPal payout Monday · $412.75" and get paid without doing anything.
- As a site owner, I see each payout's PayPal batch and item id and its status.
- As the presenter, I press "Run payout now" and show the money land in the sandbox publisher account.

## Screens
W09 Payouts · W08 (payable tile) · W14 (Run payout now, admin)

## Money math
- Per charge: `commission = floor(price × commission_bps / 10000)` (default 20%); publisher payable += `price − commission` (07).
- Payout amount: `net_cents = floor(payable_micros / 10,000)` if `net_cents ≥ payout_threshold_cents` (default $10; demo override $1 on manual runs, labelled).
- The sub-cent remainder stays in payable for next time.
- Statement figures (`gross_micros`, `commission_micros`) are summed from the period's CHARGE/CREDIT txns for that publisher.
- **Sandbox note:** we're merchant of record; PayPal Payouts fees come out of our commission. **Production path:** PayPal multiparty (`platform_fees`) with the publisher as the merchant, needing partner approval (README).

## Logic: `payoutRun(trigger)` (Render Workflows task; in-process fallback)
1. `pg_advisory_lock('payout')`.
2. Insert `payout_batches` (BUILDING, `id` = `sender_batch_id`). For SCHEDULE: unique per `period_end`.
3. For each publisher with `payable ≥ threshold` and no PENDING item: insert `payout_items` (`id` = `sender_item_id`, `receiver_email` snapshot, `net_cents`), and post ledger `PAYOUT_SENT` (`PUBLISHER_PAYABLE −`, `PAYOUTS_IN_FLIGHT +`, key `payout_item:<id>`). All in one transaction with the batch row.
4. If no items → batch deleted, done.
5. `pp.payout` with all items (`sender_batch_id` = batch id, `sender_item_id` = item id, note "Spigot: 8,112 records sold, Nov 4–11"). 201 → batch `PENDING`, save `payout_batch_id`. S4 proved the call.
6. If the PayPal call fails before a 201 (network/5xx): retry the same `sender_batch_id` (PayPal rejects a duplicate batch id, which also protects us). If it's a definite 4xx rejection: reverse with `PAYOUT_RETURNED` for every item, batch FAILED, alert.
7. **Status:** poll `GET /v1/payments/payouts/{payout_batch_id}` every 60 s for 30 min (P0), plus webhooks (P1, S11). For each item:
   - `SUCCESS` → item SUCCESS, ledger `PAYOUT_SETTLED` (`PAYOUTS_IN_FLIGHT −`, `PAYPAL_CASH +`).
   - `UNCLAIMED` → item UNCLAIMED (still in flight), alert "claim it with publisher@…".
   - `FAILED`, `BLOCKED`, `DENIED`, `RETURNED`, `REFUNDED` → item FAILED/RETURNED, ledger `PAYOUT_RETURNED` (back to payable) → included in the next batch.
   - Batch status = SUCCESS when all items terminal-success; PARTIAL otherwise.
8. SSE `payout.updated` → W09 pill flips Sent → Paid out.
9. **Weekly (P1):** Render cron Monday 09:00 PT → `payoutRun('SCHEDULE')`.

## Edge cases
| Case | Handling |
|---|---|
| Owner changes payout email after batch built | Snapshot used; new email applies next batch |
| Payable negative (claims after payout) | Not paid until positive and ≥ threshold |
| Worker crashes after ledger PAYOUT_SENT, before PayPal 201 | On restart, batch in BUILDING with items → re-submit with the same `sender_batch_id`; if PayPal says duplicate, fetch by `sender_batch_id` via list/poll |
| Unregistered receiver email | UNCLAIMED → RETURNED after 30 days → back to payable (S10 tests UNCLAIMED) |
| Two "Run now" clicks | Advisory lock + "publisher has PENDING item" rule → second run creates nothing |
| India sandbox account | Payouts fail (`PAYOUT_NOT_AVAILABLE`): use the US business account (HOLDFAST §6 gotcha) |

## Acceptance criteria
- [ ] After the demo calls, "Run payout now" creates one batch with one item per eligible publisher; amounts equal `floor(payable/10,000)` cents.
- [ ] The sandbox publisher account shows the payout; W09 shows PayPal batch + item ids and flips to Paid out.
- [ ] Ledger check passes after SUCCESS (in-flight = 0).
- [ ] (S10) An unregistered receiver ends UNCLAIMED and is shown as such; a FAILED item returns money to payable.
- [ ] A second immediate run creates no items.

## Test plan
Unit: net/commission rounding, threshold. Integration (sandbox): S4/S10 pattern through `payoutRun`; crash between ledger and PayPal call then resume. Manual: sandbox publisher account screenshot for the video.
