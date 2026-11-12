# 07: Ledger & Metering

**Priority:** P0 · **Owner:** B · **Effort:** 3 h

## Purpose
Every cent that comes in through PayPal, gets spent on data, or goes out through PayPal is a balanced ledger transaction. Calls are charged **only on 2xx**, **exactly once**, and a buyer's balance can never go negative. The ledger owns money; nothing else writes balances.

## User stories
- As a buyer, my balance drops by exactly the quoted amount, and a retry never charges me twice.
- As a site owner, every charge shows up as my earnings minus Spigot's commission, live.
- As the team, we can prove at any time that the books balance to zero.

## Screens
W08 Earnings (ledger tab) · W11 (balance) · W12 Usage (P1) · W14 Ledger check

## Logic
### `ledger.post(txn)`
```ts
type Entry = { accountId: string; amountMicros: bigint };     // signed; liabilities +, PAYPAL_CASH −
async function post(tx, { kind, idempotencyKey, refType, refId, memo, entries, isSimulated }) {
  const existing = await tx.oneOrNone(`INSERT INTO ledger_txns(...) VALUES(...) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`);
  if (!existing) return { replay: true, txn: await tx.one(`SELECT … WHERE idempotency_key=$1`, [idempotencyKey]) };
  const ids = [...new Set(entries.map(e => e.accountId))].sort();
  await tx.any(`SELECT id FROM ledger_accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);   // lock in id order
  for (const e of entries) {
    await tx.none(`INSERT INTO ledger_entries(txn_id, account_id, amount_micros) VALUES ($1,$2,$3)`, …);
    await tx.none(`UPDATE ledger_accounts SET balance_micros = balance_micros + $2 WHERE id = $1`, …); // check constraint fires here
  }
  // deferred trigger asserts sum(amount_micros)=0 for this txn at COMMIT
}
```
- Check-constraint violation on `BUYER_BALANCE` → mapped to `INSUFFICIENT_BALANCE` (402).
- Accounts are created lazily (`getOrCreateAccount(kind, ownerId)`).

### `chargeAndRecord` (the metering transaction)
1. `BEGIN`.
2. Insert `api_calls` row (status `RECEIVED`, unique `(api_key_id, idempotency_key)`). Conflict → return the stored response (replay) and `ROLLBACK`.
3. If `price = 0` → status `NOT_CHARGED`, store body, `COMMIT`, send.
4. `ledger.post({ kind: 'CHARGE', idempotencyKey: 'charge:'+callId, entries: [buyer −price, publisher +(price − commission), platform +commission] })` with `commission = floor(price × commission_bps / 10000)`.
5. On `INSUFFICIENT_BALANCE`: if auto top-up allowed (08), `ROLLBACK`, run auto top-up **outside** this transaction, then retry steps 1–4 once. Otherwise status `PAYMENT_REQUIRED`, store the 402 body, `COMMIT`, return 402.
6. Status `CHARGED`, `price_micros`, `charge_txn_id`, `response_body`, `http_status=200`. `COMMIT`.
7. Send the response with `Spigot-Charged-Micros` and `Spigot-Balance-Micros`. SSE `call.charged` to the publisher.

**Why charge before sending but after building:** the buyer only pays for a response we have fully built and stored. If the socket dies after commit, the replay returns the same stored body for free. If anything throws before commit, nothing is charged (no `CHARGED` row without a body, and vice versa).

### Display
- Balances show as dollars with 2 decimals in headers and 4 decimals in usage rows ($0.0555), with micros in a tooltip.
- Publisher earnings tiles read from `PUBLISHER_PAYABLE` and from `api_calls` aggregates (cross-checked in the ledger check).

### Ledger check (`POST /admin/ledger/check`, also nightly cron)
- `sum(balance_micros)` across all accounts = 0.
- For each account, `balance_micros = sum(entries)`.
- For each publisher, `sum(charges net) − sum(credits) − sum(payouts sent) + sum(payouts returned) = payable`.
- Results shown in W14; any mismatch raises an alert.

## Edge cases
| Case | Handling |
|---|---|
| Two concurrent calls on the same balance | Row lock on the buyer account; second one sees the lower balance; may 402 |
| Agent retries after a timeout | Same idempotency key → replay, no charge |
| Agent retries without a key | Auto key per (key, request, minute) → replay within the minute |
| Same key, different query | 409 `IDEMPOTENCY_MISMATCH` |
| Commission rounding | `floor` for commission; publisher gets the remainder |
| Claim after payout | `PUBLISHER_PAYABLE` may go negative; next payout nets it (09) |
| Simulated calls | Same code path, `is_simulated=true` on txn and call; dashboard filters |

## Acceptance criteria
- [ ] Property test (1k random sequences of top-ups, charges, credits, payouts): sum of balances is always 0; no buyer balance < 0.
- [ ] 50 parallel identical calls with one idempotency key → exactly one CHARGE.
- [ ] 50 parallel different calls on a $0.05 balance → total charged ≤ $0.05, the rest 402.
- [ ] A forced exception after the query and before commit leaves no CHARGE and no `CHARGED` row.
- [ ] Ledger check passes after the full demo script.

## Test plan
Unit + property tests (`fast-check`) on `post()` against a real Postgres (testcontainers or the dev DB). Concurrency tests as above. Manual: W14 ledger check after recording.
