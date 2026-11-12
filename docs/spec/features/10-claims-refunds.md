# 10: Junk-Data Claims & PayPal Refunds

**Priority:** P1 (claims with balance credit; refund of unused balance via PayPal Refunds) · P2 (freshness auto-refund sweeps, disputes) · **Owner:** B · **Effort:** 2.5 h

## Purpose
Buyers pay for data, so they need recourse when a record is wrong or stale. Two separate mechanisms:
1. **Credit** (internal): a junk record's charge goes back to the buyer's balance and is taken back from the publisher's payable.
2. **Refund** (PayPal): a buyer can cash out unused balance to their original PayPal payment, via the Refunds API.

## User stories
- As a buyer agent, I report "this listing is already leased" and get the $0.0015 back at once if Spigot can confirm it.
- As a site owner, I see claims against my data, with the AI's read of each, and decide the unclear ones.
- As a buyer, I get my unused $7.40 back to PayPal when I stop using Spigot.

## Screens
W12 Buyer usage & claims · W08 (claims tab for the publisher) · W14 (audit)

## Logic
### Claims
1. `POST /v1/claims` / MCP `report_bad_record { callId, recordKey, reason, note }`. Must be within 7 days of the call; the record must have been in that call's response (checked against `response_body`). One claim per record per call.
2. **Deterministic checks first** (no AI):
   - `REMOVED` / `STALE`: run a targeted `fetchPage` of the record's source page right away (one request, crawl key). If the fresh extraction differs from the served record on a visible field, or the page is gone → `AUTO_CREDITED` (and the change is published to the feed as usual). If it matches → falls through to step 3.
   - `MISSING_FIELD`: a required field was null in the served body → `AUTO_CREDITED`.
   - `DUPLICATE`: two records in the same response share a hash → `AUTO_CREDITED` for the duplicate.
3. Otherwise `OPEN`. **Claims triage agent** (Claude, one call): inputs = claim text (untrusted), served record, current record, version history, current page snapshot excerpt for the cited fields. Output tool `recommend { decision: CREDIT | REJECT, confidence, reason }`, stored in `ai_recommendation`. The publisher decides in the dashboard (one click), seeing the recommendation. P2: auto-decide when confidence is high and the amount is tiny.
4. Credit = the per-record price from that call's `unit_price_micros`. Ledger `CREDIT` (reverse the CHARGE split for that record: buyer +, publisher −, platform −), key `claim:<id>`. Call status → `PARTIALLY_CREDITED`/`CREDITED`.
5. Abuse limit: credits per buyer ≤ 10% of their charges in a rolling 7 days; above that, claims stay OPEN for the publisher.

### Refund of unused balance (PayPal Refunds, needs S9)
1. `POST /api/buyer/refunds { amountCents }` (W12 "Refund unused balance to PayPal").
2. Allowed amount = `min(balance_cents_floor, sum over COMPLETED top-ups of (amount − refunded))`, top-ups ≤ 180 days old (PayPal's refund window).
3. Split across the newest top-ups first; for each: insert `balance_refunds` (id = `PayPal-Request-Id`), ledger `REFUND` (buyer −, `PAYPAL_CASH +`, key `refund:<id>`) **before** calling PayPal, then `pp.refundCapture(captureId, amount)`.
4. Refund `COMPLETED` → status COMPLETED, `topups.refunded_cents += amount`, top-up → PARTIALLY_REFUNDED. `PENDING` → wait for webhook `PAYMENT.CAPTURE.REFUNDED` / poll.
5. Refund FAILED (definite 4xx) → reverse the ledger REFUND (`refund_reversal:<id>`), status FAILED, show the reason.
6. Auto top-up is disabled after a full cash-out.

## Edge cases
| Case | Handling |
|---|---|
| Claim text contains instructions to the AI | Untrusted input; agent can only output `recommend`; publisher decides |
| Claim after the publisher was paid out | Payable goes negative; netted from the next payout (07, 09) |
| Refund request larger than refundable captures (e.g. balance came from credits) | Capped; message explains |
| Refund API call times out | Same `PayPal-Request-Id` on retry (S9 checks replay) |
| Top-up older than 180 days | Excluded from refundable; P2: refund via Payouts instead |

## Acceptance criteria
- [ ] Buyer fetches a listing; `demo:mutate` marks it leased (no crawl yet); buyer claims STALE → targeted re-fetch sees the change → AUTO_CREDITED; ledger CREDIT posted; publisher payable reduced; the change appears in the feed.
- [ ] An ambiguous claim shows the AI recommendation in the publisher's claims tab; decision posts a CREDIT or closes it.
- [ ] (S9) Refund $7.40 of a $20 top-up: PayPal refund id stored, balance −$7.40, top-up PARTIALLY_REFUNDED; replay doesn't refund twice.
- [ ] Ledger check passes after claims and refunds.

## Test plan
Unit: claim eligibility checks; refundable-amount split. Integration (sandbox): S9 pattern through the endpoint. Fixture: claim with injected instructions.
