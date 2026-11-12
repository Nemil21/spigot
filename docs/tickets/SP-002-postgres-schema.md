# SP-002: Postgres schema, migrations and db helpers (tx, transition, advisory locks, job runner)

- **Priority:** P0
- **Wave:** 1
- **Estimate:** 2
- **Depends on:** none
- **Spec refs:** data-model.md (all tables, state machines, locking rules 1–13)

## Goal
The whole schema in one first migration, frozen early, plus the tiny db toolkit every service uses, so later tickets never race each other on migrations.

## Files / modules
- `db/migrations/001_init.sql` (+ `db/migrate.mjs`, `db/package.json` with `migrate` and `test`), `db/test/*.test.ts` constraint tests.
- `apps/api/src/db/`: `pool.ts`, `tx.ts` (`db.tx(fn)`), `transition.ts`, `locks.ts` (`withAdvisoryXactLock(key)`, `tryAdvisoryLock(name)`), `jobs.ts` (`runEvery(name, ms, fn)` — in-process interval under `pg_try_advisory_lock`, so two API processes don't double-run), `notify.ts` (`notify(tx, channel, payload)` via `pg_notify`, fires on COMMIT).

## Scope
- Every table in data-model.md, **including P1 tables** (`claims`, `balance_refunds`) so P1 never needs a migration: `publishers`, `sites`, `pages`, `snapshots`, `templates`, `datasets`, `schema_versions`, `records`, `record_versions`, `crawl_runs`, `bot_hits`, `buyers`, `api_keys`, `topups`, `ledger_accounts`, `ledger_txns`, `ledger_entries`, `api_calls`, `claims`, `balance_refunds`, `payout_batches`, `payout_items`, `webhook_events`, `audit_events`.
- Status columns as `text` + `CHECK (status IN (...))` from each state machine.
- Constraints and indexes named in data-model.md:
  - `ledger_accounts`: `unique(kind, owner_id)` (NULLS NOT DISTINCT for platform accounts), `CHECK (kind <> 'BUYER_BALANCE' OR balance_micros >= 0)`.
  - `ledger_entries`: deferred constraint trigger `sum(amount_micros)=0` per `txn_id`; `amount_micros <> 0`.
  - `ledger_entries`, `audit_events`: app role has no UPDATE/DELETE (`REVOKE`, and a trigger that raises on UPDATE/DELETE so it holds even when the app connects as owner).
  - `crawl_runs`: partial unique `(site_id) WHERE status IN ('QUEUED','RUNNING')`.
  - `records`: `unique(dataset_id, record_key)`, `(dataset_id, updated_at desc)`, `(dataset_id, removed_at)`, GIN `data jsonb_path_ops`.
  - `record_versions`: `seq bigserial`, index `(dataset_id, seq)`.
  - `api_calls`: `unique(api_key_id, idempotency_key)`. `claims`: `unique(api_call_id, record_id)`.
  - `topups`: `paypal_order_id`, `paypal_capture_id` unique; amount `CHECK 500..50000`. `payout_batches`: unique `paypal_batch_id`; partial unique `(period_end) WHERE trigger='SCHEDULE'`.
  - `bot_hits` PK `(site_id, bucket, category, bot_name, decision, is_simulated)`.
  - `datasets.published_seq bigint not null default 0`; `price_per_record_micros CHECK 100..100000`.
- `transition(tx, table, id, from, to, extra?)` → conditional `UPDATE … WHERE id=$1 AND status = ANY($from) RETURNING *`; table names from a TS union, never free strings (rule 1).
- `npm run migrate` is idempotent (migration table).

## Out of scope
Ledger `post()` (SP-005), any service logic.

## Acceptance criteria
- [ ] Migrating an empty DB twice succeeds (CI `db` job).
- [ ] Unbalanced ledger txn fails at COMMIT; a negative `BUYER_BALANCE` fails; a negative `PUBLISHER_PAYABLE` succeeds.
- [ ] UPDATE / DELETE on `ledger_entries` and `audit_events` fails.
- [ ] A second QUEUED crawl run for the same site fails the partial unique index.
- [ ] Duplicate `(api_key_id, idempotency_key)` fails.
- [ ] Two concurrent `transition(x, A→B)`: exactly one returns a row.
- [ ] `runEvery` started in two processes runs the job once per tick.

## Test plan
`db/test` constraint tests against the CI Postgres; `transition` and `runEvery` concurrency tests with two pools.

## Notes & risks
- Runs in parallel with SP-001a against the agreed layout (`db/migrations`, `npm run migrate`, `npm run test:db`); rebase on SP-001a before merging.
- **Schema freeze at merge (target 08:45 IST).** Later changes are new numbered migrations, reviewed against every open ticket.
