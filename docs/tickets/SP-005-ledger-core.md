# SP-005: Ledger core: `ledger.post` (savepoint), accounts, balance check, ledger-check function

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a, SP-002, SP-001d
- **Spec refs:** features/07-ledger-metering.md §`ledger.post(txn)`, §Ledger check; data-model.md §ledger_*, §Postings, rule 2

## Goal
The only writer of balances. Every money move is one balanced, idempotent transaction; a buyer balance can never go negative.

## Files / modules
`apps/api/src/ledger/ledger.ts` (`post`), `accounts.ts` (`getOrCreateAccount(tx, kind, ownerId)`, platform account ids), `postings.ts` (builders: `topupEntries`, `chargeEntries`, `creditEntries`, `refundEntries`, `payoutSentEntries`, `payoutSettledEntries`, `payoutReturnedEntries` exactly as data-model §Postings), `check.ts` (`ledgerCheck()`), `errors.ts` (`InsufficientBalance`).

## Scope
- `post(tx, {kind, idempotencyKey, refType, refId, memo, entries, isSimulated})`:
  1. `INSERT ledger_txns … ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`; conflict → return `{replay: true, txn}` and write nothing.
  2. Lock touched accounts `FOR UPDATE` **in id order**.
  3. Insert entries, update `balance_micros`; map the `BUYER_BALANCE` check violation to `InsufficientBalance` (→ 402 upstream).
  4. Deferred trigger enforces the zero sum at COMMIT.
- Accounts created lazily (`INSERT … ON CONFLICT DO NOTHING`), platform accounts `PLATFORM_REVENUE`, `PAYPAL_CASH`, `PAYOUTS_IN_FLIGHT` with `owner_id NULL`.
- `chargeEntries(price, commissionBps)` uses `commissionSplit` from `@spigot/shared` (floor commission; remainder to publisher).
- `ledgerCheck()`: sum of all `balance_micros` = 0; each account's balance = sum of its entries; per publisher, net charges − credits − payouts sent + payouts returned = payable. Returns `{sumMicros, accountsChecked, mismatches[]}`.
- Sign convention per data-model (liabilities +, `PAYPAL_CASH` −).
- **Savepoint, so the caller's transaction survives a short balance:** `post()` opens `SAVEPOINT ledger_post` before inserting `ledger_txns`; on the `BUYER_BALANCE` check violation it does `ROLLBACK TO SAVEPOINT ledger_post` and then throws `InsufficientBalance`. Result: no `ledger_txns` row, no entries, and the caller can still write its `PAYMENT_REQUIRED` row and COMMIT (SP-016).
- Optional `simulatedAt` (only accepted with `isSimulated: true`; otherwise throws) sets `created_at` on the txn and its entries at insert time, for SP-036's simulated week. No UPDATE of ledger rows anywhere.

## Out of scope
`chargeAndRecord` (SP-016), top-ups (SP-018a), payouts (SP-020), HTTP endpoint for the check (SP-043).

## Acceptance criteria
- [ ] Same idempotency key twice → one txn, second call returns `replay: true`, balances unchanged.
- [ ] Property test (`fast-check`, 1k random sequences of top-up, charge, credit, payout sent / settled / returned): global sum always 0; no buyer balance < 0; `ledgerCheck()` finds no mismatches.
- [ ] Charge larger than balance throws `InsufficientBalance` and writes nothing.
- [ ] Commission split: 1,500,000 at 2000 bps → 300,000 platform / 1,200,000 publisher; 1,501 at 2000 bps → 300 / 1,201.
- [ ] After `InsufficientBalance` the caller's transaction is still usable (a follow-up INSERT succeeds and commits) and **no `ledger_txns` row exists** for that key.
- [ ] `simulatedAt` without `isSimulated` throws; with it, the txn and all entries carry that timestamp.

## Race / idempotency tests
- 50 parallel `post` with one key → one txn.
- 50 parallel different charges on a $0.05 balance → total debited ≤ $0.05, the rest `InsufficientBalance`; no deadlock (two buyers charging into the same publisher account, id-ordered locks).

## Test plan
Integration on real Postgres (`apps/api/src/ledger/*.db.test.ts`, picked up by the `db` vitest project; no `ci.yml` edit).

## Notes & risks
Every later money ticket must post through `ledger.post`; reviewers reject any direct `UPDATE ledger_accounts`.
