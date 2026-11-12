# SP-001a: Repo skeleton, tooling, CI (check/db/security), gitleaks, config, shared money helpers

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
- `apps/workflows` (placeholder: Render Workflows entry that will import tasks from `@spigot/api`; SP-041 fills it).
- `apps/web` (placeholder; SP-024 fills it). `apps/demo-site` (placeholder dir only; SP-004a owns it).
- `packages/shared`: `money.ts` (`centsToMicros`, `microsToCentsFloor`, `commissionSplit(priceMicros, bps)` → `{commission, publisher}` with floor on commission, `formatMicros` for "$0.0555", `formatPer1000`), `errors.ts` (error envelope type + code union from api.md), `index.ts`. No Node-only deps (the web app imports it).
- `packages/gate` (placeholder `package.json` with **zero runtime deps**; SP-006a fills it). `packages/sdk` (placeholder README; SP-056).
- `db/` placeholder `package.json` with `migrate` + `test` scripts agreed with SP-002 (SP-002 owns the contents).
- `scripts/secret-scan.sh`, `.gitleaks.toml`, `.gitleaksignore` (empty pin list, header comment kept), `scripts/` placeholder.
- `.github/workflows/ci.yml` with three jobs copied from Holdfast:
  - **check:** `npm ci && npm run build && npm run typecheck && npm run lint && npm test` (vitest `--maxWorkers=2`).
  - **db:** `postgres:16-alpine` service, `npm run migrate` twice (idempotent), then `npm run test:db` and a list of integration test paths that later tickets append to (one `run:` line per ticket, as Holdfast does).
  - **security:** gitleaks 8.30.1 over full history (`fetch-depth: 0`, `npm run security:secrets`) and `npm audit --audit-level=high`.
- Root scripts: `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:db`, `migrate`, `security:secrets`, `security:audit`, plus empty stubs that later tickets fill: `seed:demo`, `sim:bots`, `sim:buyers`, `demo:mutate`, `demo:reset`, `demo:payout`, `demo:decline`.

## Scope
- `apps/api/src/config.ts`: zod env loader.
  - Required at boot: `DATABASE_URL`, `SESSION_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE`, `APP_BASE_URL`.
  - Required only when used: `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `AG_GRID_LICENSE_KEY`, `PAYPAL_WEBHOOK_ID`, `RENDER_API_KEY`, `RENDER_WORKFLOWS_SERVICE_ID`, `ADMIN_EMAILS`, `DEMO_PUBLISHER_PAYOUT_EMAIL`.
  - Flags: `PAYPAL_MODE=sandbox|stub`, `PAYPAL_ENV`, `ALLOW_MOCK_DECLINE`, `WORKFLOWS_MODE=inproc|workflows` (default `inproc`), `SCHEMA_AGENT_MODE=live|recorded`, `DEMO_MODE`.
  - Refuse to boot if `PAYPAL_API_BASE` isn't the sandbox host unless `PAYPAL_ENV=live`; force `ALLOW_MOCK_DECLINE=false` on a live base.
- Fastify error handler that renders `{ error: { code, message, details } }` (SP-007a extends it).

## Out of scope
DB schema (SP-002), PayPal client (SP-001b), UI (SP-024), demo site (SP-004a), Render deploy (SP-040).

## Acceptance criteria
- [ ] `npm install && npm run build && npm run typecheck && npm run lint && npm test` pass on a clean clone.
- [ ] API boots with only the required env vars; `/api/healthz` → 200.
- [ ] A missing required env var fails fast naming the key; a missing optional key fails only when its feature is called.
- [ ] Boot refuses a non-sandbox PayPal base without `PAYPAL_ENV=live`.
- [ ] `apps/web` (placeholder) can import `@spigot/shared` without Node polyfills.
- [ ] CI has `check`, `db` and `security` jobs and all three are green on the PR; `npm run security:secrets` passes locally.
- [ ] `.env` is git-ignored; `.env.example` lists every key with no values.

## Test plan
- Unit: config loader (missing / invalid / live-base guard); `money.ts` table tests (`centsToMicros(2000)=20_000_000`, `microsToCentsFloor(12_345_678)=1234`, `commissionSplit(1_500_000, 2000)` = 300,000 / 1,200,000, odd amounts keep the remainder with the publisher).
- CI: the PR itself.

## Notes & risks
- New ticket workers add packages under `apps/*` or `packages/*`; the workspace globs pick them up. Lockfile conflicts: rebase and re-run `npm install`, never hand-merge the lockfile.
- Layout decision: task code (crawl, extract, payout) lives in `apps/api/src/**` per the spec layout and is exported via `@spigot/api/tasks`; `apps/workflows` stays a thin Render entry (SP-041). No `packages/core`.
- Secrets never land in a committed file; gitleaks runs over every ref on every PR.
