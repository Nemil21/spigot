# SP-001a: Repo skeleton, tooling, CI (check/db/security), gitleaks, config, hot-spot loaders, dev Postgres

- **Priority:** P0
- **Wave:** 1
- **Estimate:** 1.5
- **Depends on:** none
- **Spec refs:** README.md §Tech stack, §Repo layout (proposed); features/14-auth-security-ops.md §Security checklist; data-model.md §Money units
- **Holdfast reference (read-only):** `/Users/nemilai/Desktop/PaypalHack` — `package.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `.github/workflows/ci.yml`, `.github/workflows/db.yml`, `.gitleaks.toml`, `.gitleaksignore`, `scripts/secret-scan.sh`

## Goal
One layout, one config loader and one CI that every other worker builds against from the first hour. Copy Holdfast's proven setup; rename, don't redesign.

## Files / modules
- Root: `package.json` (npm workspaces `apps/*`, `packages/*`, `db`), `package-lock.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts` (aliases `@spigot/shared`, `@spigot/gate` → `src/index.ts`), `.env.example`, `.gitignore` (`.env`, `node_modules`, `dist`), `.nvmrc` (22).
- `apps/api` (Fastify + TS): `src/server.ts`, `src/config.ts`, `GET /api/healthz`. Exports `./tasks` (empty barrel) so `apps/workflows` can import task functions from `@spigot/api`.
- `apps/workflows` (placeholder: Render Workflows entry that will import tasks from `@spigot/api`; SP-041a fills it).
- `apps/web` (placeholder; SP-024a fills it). `apps/demo-site` (placeholder dir only; SP-004a owns it).
- `packages/shared`: empty workspace (`package.json`, `src/index.ts`) so the alias resolves; **SP-001d owns its contents** and runs in parallel.
- `packages/gate` (placeholder `package.json` with **zero runtime deps**; SP-006a fills it). `packages/sdk` (placeholder README; SP-056).
- `db/` placeholder `package.json` with `migrate` + `test` scripts agreed with SP-002 (SP-002 owns the contents).
- `scripts/secret-scan.sh`, `.gitleaks.toml`, `.gitleaksignore` (empty pin list, header comment kept), `scripts/` placeholder.
- `scripts/dev-db.sh`: one shared local Postgres container for all worktrees (`docker run --label ao.session=$AO_SESSION_ID --label ao.spare=true … postgres:16-alpine`, started only if absent) and `createdb spigot_<worktree>`; `.env.example` points `DATABASE_URL`/`TEST_DATABASE_URL` at it. No ticket starts its own Postgres.
- `.github/workflows/ci.yml` with three jobs copied from Holdfast:
  - **check:** `npm ci && npm run build && npm run typecheck && npm run lint && npm test` (vitest `--maxWorkers=2`).
  - **db:** `postgres:16-alpine` service, `npm run migrate` twice (idempotent), then `npm run test:db` and **one** line `npx vitest run --project db --maxWorkers=2`. Vitest projects in `vitest.config.ts`: `unit` (`**/*.test.ts` excluding `*.db.test.ts`) and `db` (`**/*.db.test.ts`). Tickets name DB-backed tests `*.db.test.ts` and **never edit `ci.yml`**.
  - **security:** gitleaks 8.30.1 over full history (`fetch-depth: 0`, `npm run security:secrets`) and `npm audit --audit-level=high`.
- Root scripts: `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:db`, `migrate`, `security:secrets`, `security:audit`, plus empty stubs that later tickets fill: `seed:demo`, `sim:bots`, `sim:buyers`, `demo:mutate`, `demo:reset`, `demo:payout`, `demo:decline`.

## Scope
**Merge-conflict hot spots, solved here before Wave 2 dispatch** (the rule for every later ticket: add a file, don't edit a shared one):
- **Routes:** `apps/api/src/server.ts` registers `@fastify/autoload` over `apps/api/src/routes/` (each file exports a Fastify plugin with its own prefix). Tickets add a route file; nobody edits `server.ts`.
- **Jobs:** `apps/api/src/jobs/index.ts` glob-loads `jobs/*.job.ts` (each exports `{name, everyMs, run}`) and registers them with SP-002's `runEvery`. Tickets add a `*.job.ts`.
- **Tasks barrel:** `apps/api/src/tasks/index.ts` pre-stubs the six Workflows task names (`crawlSite`, `fetchPage`, `extractTemplate`, `extractPage`, `publishWatermark`, `payoutRun`) as throwing placeholders that import from fixed paths (`crawl/crawlSite.ts`, …). Owning tickets replace the target file, not the barrel.
- **Security cases:** `apps/api/src/security/tenancy/*.cases.ts` glob-loaded by SP-042 (empty dir with a README here).
- **Dependencies installed up front** (one lockfile change): fastify, `@fastify/autoload`, `@fastify/cookie`, `@fastify/static`, `@fastify/rate-limit`, zod, pg, argon2, undici, p-queue, cheerio, `jsonpath-plus` (patched ≥ 10.x), `re2-wasm`, `fast-json-patch`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `@asteasolutions/zod-to-openapi`, fast-check, supertest, uuid. Web deps are SP-024a's. A later ticket that needs a new dependency rebases and re-runs `npm install`; never hand-merge the lockfile.
- **Env keys:** `.env.example` and `config.ts` list every key later tickets read, so nobody else edits them: the keys below plus `SPIGOT_GATE_DEMO`, `SPIGOT_VERIFY_TOKEN`, `SPIGOT_API_BASE`, `SPIGOT_GATE_KEY`, `DEMO_ADMIN_TOKEN`, `DEMO_SITE_URL`, `ALLOW_LOCAL_ORIGINS`, `DEMO_LAYOUT`, `DEMO_SEED_SCALE`, `CRAWL_MIN_GAP_MS`, `PAYPAL_WALLET_VAULT=on|off`, `VITE_FIXTURES`, `VITE_AG_GRID_LICENSE_KEY`, `VITE_PAYPAL_CLIENT_ID`.
- `apps/api/src/config.ts`: zod env loader.
  - Required at boot: `DATABASE_URL`, `SESSION_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE`, `APP_BASE_URL`.
  - Required only when used: `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `AG_GRID_LICENSE_KEY`, `PAYPAL_WEBHOOK_ID`, `RENDER_API_KEY`, `RENDER_WORKFLOWS_SERVICE_ID`, `ADMIN_EMAILS`, `DEMO_PUBLISHER_PAYOUT_EMAIL`.
  - Flags: `PAYPAL_MODE=sandbox|stub`, `PAYPAL_ENV`, `ALLOW_MOCK_DECLINE`, `WORKFLOWS_MODE=inproc|workflows` (default `inproc`), `SCHEMA_AGENT_MODE=live|recorded`, `DEMO_MODE`.
  - Refuse to boot if `PAYPAL_API_BASE` isn't the sandbox host unless `PAYPAL_ENV=live`; force `ALLOW_MOCK_DECLINE=false` on a live base.
- Fastify error handler that renders `{ error: { code, message, details } }` (SP-007a extends it).

## Out of scope
DB schema (SP-002), `packages/shared` contents (SP-001d), PayPal client (SP-001b/001c), UI (SP-024a), demo site (SP-004a), Render deploy (SP-040).

## Acceptance criteria
- [ ] `npm install && npm run build && npm run typecheck && npm run lint && npm test` pass on a clean clone.
- [ ] API boots with only the required env vars; `/api/healthz` → 200.
- [ ] A missing required env var fails fast naming the key; a missing optional key fails only when its feature is called.
- [ ] Boot refuses a non-sandbox PayPal base without `PAYPAL_ENV=live`.
- [ ] `apps/web` (placeholder) can import `@spigot/shared` without Node polyfills.
- [ ] CI has `check`, `db` and `security` jobs and all three are green on the PR; `npm run security:secrets` passes locally.
- [ ] `.env` is git-ignored; `.env.example` lists every key with no values.
- [ ] A route file dropped into `routes/` and a `*.job.ts` dropped into `jobs/` are picked up with no other edit (test).
- [ ] `npx vitest run --project db` runs only `*.db.test.ts`; `--project unit` runs the rest.
- [ ] `scripts/dev-db.sh` run twice creates one container and two databases for two worktrees.

## Test plan
- Unit: config loader (missing / invalid / live-base guard); autoload of a sample route and job.
- CI: the PR itself.

## Notes & risks
- New ticket workers add packages under `apps/*` or `packages/*`; the workspace globs pick them up. Lockfile conflicts: rebase and re-run `npm install`, never hand-merge the lockfile.
- Layout decision: task code (crawl, extract, payout) lives in `apps/api/src/**` per the spec layout and is exported via `@spigot/api/tasks`; `apps/workflows` stays a thin Render entry (SP-041a). No `packages/core`.
- Secrets never land in a committed file; gitleaks runs over every ref on every PR.
