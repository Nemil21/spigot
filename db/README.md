# @spigot/db

The Postgres schema (`migrations/`) and its runner (SP-002). The spec is `docs/spec/data-model.md`.

- `npm run migrate` applies `migrations/*.sql` in filename order, each in its own transaction, under an advisory lock. Idempotent: applied files are recorded in `schema_migrations` with a checksum; editing an applied file is an error.
- **After the schema freeze** add a new file `NNN_sp0XX_<topic>.sql` (e.g. `002_sp049_refund_status.sql`). Two files with the same `NNN` fail the run before anything is applied: renumber yours after rebasing.
- `DATABASE_URL` comes from the environment or the repo-root `.env`. The runner never prints it.

## Tests

`*.db.test.ts` need `TEST_DATABASE_URL` pointing at a server where the user may `CREATE DATABASE` (CI's Postgres service, or `scripts/dev-db.sh` locally). Each suite creates a fresh migrated `spigot_test_*` database with `createTestDatabase()` from `@spigot/db/testing.mjs` and drops it afterwards.

- `db/test/schema.db.test.ts`: constraints, triggers and the runner.
- `apps/api/src/db/*.db.test.ts`: `transition`, `runEvery`, advisory locks and `notify` under concurrency, with two pools standing in for two API processes.

```sh
npm run test:db                                   # this package
npx vitest run --project db --maxWorkers=2        # every *.db.test.ts
```
