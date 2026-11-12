# Spigot tickets: index

Source of truth: `docs/spec/` (README, data-model, api, screens, features 01–16), with `docs/research/15-gstack-spigot.md` for product context, `spikes/paypal-spikes.mjs` for what is already proven (S1–S4) and `spikes/s7-results.md` (Holdfast's S7, copied here) for sandbox facts. Format follows Holdfast's `docs/tickets/`.

**Scope rule.** No feature in the spec is dropped. Every P0 item is a P0 ticket; every P1 item is a P1 ticket ordered after P0 (spec README P1 list #1–#10 first, then the P1 items named only inside feature files). P2 items are README-only, as the spec says, and live in SP-044's scope.

**Builders.** Agent Orchestrator workers, **6 at once** (the human's decision). A ticket is ready when every ticket on its "Depends on" line is merged. A few tickets also have a "Soft deps" line: the worker may start earlier against fixtures or the agreed contract, but the PR doesn't merge until it has been verified against the merged soft dependency. Estimates are worker-hours for one worker (1–2 h each). Projections add 15 min per ticket for review and merge.

**Dispatch order.** P0 before P1. Within P0: **S** (spine: the kill-criterion loop, money out, and the two things needed to ship, SP-040 deploy config and SP-044 README) first, then **D** (on screen in the video), then the rest; ties go to the ticket with the longest remaining chain. P1 starts only when no P0 ticket is ready.

**Totals:** P0: 66 tickets, 85.5 worker-h of code (+ SP-046 video/submission, human-led) · P1: 24 tickets, 35 worker-h.

**This revision** applies the three engineering reviews on PR #1 (Money; Data plane + AI; Cross-cutting). Splits: SP-001 → 001a / 001b / 001c / 001d · SP-009a → 009a1 / 009a2 · SP-014 → 014a / 014b · SP-018 → 018a / 018b · SP-024 → 024a / 024b · SP-039 → 039a / 039b · SP-041 → 041a / 041b · SP-048a → 048a / 048c. New: SP-044b (README fresh-clone check), SP-047c (auto top-up below threshold + orphan sweep). Where a reviewer is wrong, §Review responses says why.

## Time budget at 6 workers (read this first)

Now: **06:30 IST Nov 12** (= 17:00 PST Nov 11). Code freeze **18:00 IST** (04:30 PST). Submit **23:30 IST** (10:00 PST); Devpost's hard deadline is 01:30 IST Nov 13 (12:00 PST Nov 12).

6 workers × 11.5 h = **69 worker-h** before the freeze. P0 code is **85.5 worker-h**, and the on-screen (S + D) tickets alone are **72.5 worker-h**, before review overhead. So the 18:00 freeze **cannot** hold for everything shown in the video. Projection (list scheduling over the dependency graph, dispatch order above):

| | IST |
|---|---|
| Kill-criterion loop green (crawl → AI proposal → approve → records → top-up → paid MCP call) | **17:00** |
| Deploy config (SP-040) / README draft (SP-044) merged | 11:45 / 09:30 |
| On-screen tickets merged by 18:00 | **39 of 53** |
| Last on-screen ticket merged | **21:45** |
| All P0 code merged | 00:45 +1d |
| Everything incl. P1 | 07:30 +1d |

For comparison only: 4 workers → loop 18:15, all P0 09:15 +1d; 8 workers → loop 16:30, all P0 21:00.

What is at risk and what to do:
1. **On-screen tickets after 18:00:** SP-032 18:30, SP-017b 18:45, SP-039a 18:45, SP-038 19:00, SP-030b 19:30, SP-029 20:00, SP-026 20:15, SP-027b 20:30, SP-028 20:30, SP-031 20:45, SP-039b 20:45, SP-037 21:15, SP-036 21:30, SP-033 21:45. These are the W04/W05/W06/W08/W09/W11 screens, seed/sim scripts and the dry run. Nothing on this list can be pulled earlier by reordering (the on-screen work alone exceeds the window).
2. **Other P0 tickets after 18:00:** SP-045 21:15, SP-044b 21:30, SP-012b 22:30, SP-022b 22:30, SP-043 22:30, SP-023 22:45, SP-041a 23:30, SP-019 23:45, SP-034 23:45, SP-042 00:15 +1d, SP-041b 00:45 +1d.
3. **P0 tickets that miss the 23:30 submission:** SP-019 (23:45), SP-034 (23:45), SP-041b (00:45 +1d), SP-042 (00:15 +1d). SP-042 (security tests) is the one that matters; SP-041b is the post-freeze Render Workflows check. Both stay in scope; the README states their status at submission.
4. **Recommended plan (decision for the human): split the freeze.**
   - **18:00 backend freeze.** Spine, deploy config and README are in. Deploy main to Render (SP-040) at 18:00; keep auto-deploy on for screen PRs until the screen freeze.
   - **18:30–20:00, recording pass 1:** the beats that are ready (scraper 402 in the terminal, W11 top-up with PayPal from ~18:30, Claude Desktop paid call, payout run from the CLI).
   - **Screen freeze at ~21:45**, then **recording pass 2** (W04 bot report, W05 "I found 3 kinds of records", W06 publish, W08 earnings flash, W09 paid out) until ~23:00; upload and submit by 23:30.
   - The 01:30 hard deadline is the only buffer. If the screens slip further, submit with the pass-1 footage plus the screens that exist, and say so in the README.
5. **P1 doesn't fit today.** P1 tickets stay in the set, ordered, and are dispatched only when no P0 is ready; the first P1 worker should take SP-047a (auto top-up).
6. **Kill checkpoint moves to ~17:15** (loop projected at 17:00). If the loop isn't green then, stopping Spigot is the human's call (the spec says to fold effort back into Holdfast).
7. **Human-in-the-loop steps** (they block workers if not ready): a sandbox **publisher** business account for payouts (see PayPal facts); a sandbox Personal buyer for wallet approval (SP-003 S7b, SP-018a, SP-032, SP-039b); `ANTHROPIC_API_KEY` for the one live schema-agent capture (SP-012a; CI uses hand-authored fixtures until then); AG Grid licence key (SP-024a); a person at Claude Desktop (SP-039b, SP-046); Render account (SP-040 deploy, SP-041b); APIMatic account (SP-056); Log in with PayPal on the sandbox app (SP-058); **pasting the Devpost draft** (SP-045, target 19:00 IST; the spec's deadline is 08:00 PST = 21:30 IST).

## Merge-conflict hot spots (adopted; set up in SP-001a / SP-001d / SP-002 / SP-024a before Wave 2)

The rule for every ticket: **add a file, don't edit a shared one.**
1. **Fastify routes** autoload from `apps/api/src/routes/*.ts`; nobody edits `server.ts` (SP-001a).
2. **CI:** DB-backed tests are named `*.db.test.ts` and run through one `vitest run --project db --maxWorkers=2` line; **no ticket edits `ci.yml`** (SP-001a).
3. **Web routes and nav** are pre-registered in SP-024a as lazy stubs at fixed paths; a screen ticket replaces only its own page file and owns its own fixtures.
4. **Dependencies** are installed up front by SP-001a (api) and SP-024a (web); a later ticket that needs a new one rebases and re-runs `npm install`, never hand-merges the lockfile.
5. **Migrations after the freeze** are named `NNN_sp0XX_<topic>.sql`; the runner errors on two files with the same number (SP-002).
6. **Jobs** self-register from `jobs/*.job.ts`; the **tasks barrel** is pre-stubbed with the six Workflows task names; **MCP tools** load from `mcp/tools/*.ts`; **webhook handlers** load from `webhooks/handlers/*.ts` (SP-001a, SP-022a, SP-059).
7. **Shared contracts** (`PublisherEvent`, W15 copy, error codes, money helpers, gate payload schemas) live in `packages/shared` from Wave 1 (SP-001d); producers and consumers import the same type.
8. **Env keys** are all listed in SP-001a's `.env.example` and `config.ts`.
9. **Tenancy test cases**: every ticket that adds a tenant-scoped route adds its own `apps/api/src/security/tenancy/<area>.cases.ts`; SP-042's matrix is generated from the route table and fails on any route without a case.

**Shared local resources (16 GB laptop, 6 workers):** one shared Postgres container (`scripts/dev-db.sh`, a database per worktree, labelled `ao.spare`), never one per worker; `vitest --maxWorkers=2`; UI tickets test with Testing Library in fixture mode and `vite build`, **no vite dev server**; no process left running after a step.

## PayPal facts that shape these tickets

From Holdfast's `spikes/s7-results.md` (same sandbox app and US business account):
- **Payouts need a separate sandbox brand/publisher business account.** Paying the merchant's own account returns batch DENIED / item FAILED `SELF_PAY_NOT_ALLOWED`. The demo publisher's `payout_email` is that separate account (`DEMO_PUBLISHER_PAYOUT_EMAIL`): SP-003, SP-020, SP-035.
- **Large payouts need a funded balance.** Payouts of $2,500 and up returned `422 INSUFFICIENT_FUNDS` (no batch created) even after ~$106k of card captures; $1,000 to the separate account succeeded. Spigot's demo payout is small (~$400), but SP-020 treats `INSUFFICIENT_FUNDS` as a definite 4xx: reverse to payable, batch FAILED, alert, new batch next run.
- Raw-card order create is **not** replay-safe (same `PayPal-Request-Id` → `422 TRANSACTION_REFUSED`); `vault_id` and no-source orders replay cleanly. SIM card top-ups use deterministic ids inserted before the PayPal call (SP-018b, SP-035).
- Capture and void replays with the same request id return the original result. A mocked `INSTRUMENT_DECLINED` on capture came back as **403 with an empty body**; classify by status, not issue code (SP-001b).
- Wallet vault and wallet MIT worked with AUTHORIZE; Spigot needs them with CAPTURE, which SP-003 (S7/S8) proves first. Wallet vault on top-ups is behind `PAYPAL_WALLET_VAULT` until S8b passes.
- Working sandbox cards at concurrency 20: Visa 4111…1111, Visa 4012…1881, MC 5555…4444, Amex 3714…8431, Discover 6011…1117. **Don't use 5105…5100.**
- `GET /v1/reporting/balances` returns 403 for this app, so we can't read the merchant balance in health checks.
- Use the **US** sandbox business account; the India one fails cards and Payouts.

## All tickets

Tag: **S** = spine (dispatched first) · **D** = on screen in the video · – = other. Start / Merge are the simulated times in IST at **6 workers** (Nov 12 unless "+1d").

| ID | Title | Pri | Tag | Wave | Est (h) | Start @6 | Merge @6 | Depends on |
|---|---|---|---|---|---|---|---|---|
| [SP-001a](SP-001a-repo-skeleton-ci.md) | Repo skeleton, tooling, CI (check/db/security), gitleaks, config, hot-spot loaders, dev Postgres | P0 | S | 1 | 1.5 | 06:30 | 08:15 | none |
| [SP-001d](SP-001d-shared-contracts.md) | `packages/shared` contracts: money, error codes, `PublisherEvent`, W15 copy, gate payload schemas | P0 | S | 1 | 1 | 06:30 | 07:45 | none |
| [SP-001b](SP-001b-paypal-client-fake.md) | PayPal client + FakePayPal core: token, errors, CAPTURE orders, wallet approve, vault | P0 | S | 2 | 1.5 | 08:15 | 10:00 | SP-001a |
| [SP-001c](SP-001c-paypal-refunds-payouts-webhooks.md) | PayPal refunds, payouts and webhook verify + FakePayPal statuses and `emitWebhook` | P0 | S | 2 | 1.5 | 08:15 | 10:00 | SP-001a (soft: SP-003) |
| [SP-002](SP-002-postgres-schema.md) | Postgres schema, migrations and db helpers (tx, transition, advisory locks, job runner) | P0 | S | 1 | 2 | 06:30 | 08:45 | none |
| [SP-003](SP-003-paypal-spike-pack.md) | PayPal spike pack S7–S10 (+S11 script) for Spigot's CAPTURE / vault / refund / payout calls | P0 | S | 1 | 1.5 | 07:45 | 09:30 | none |
| [SP-004a](SP-004a-demo-site.md) | Demo site "Bluebonnet Rentals" (Express + EJS, seeded 2,341 / 88 / 40, JSON-LD, sitemap, ETag) | P0 | S | 1 | 1.5 | 06:30 | 08:15 | none |
| [SP-004b](SP-004b-demo-mutate.md) | `demo:mutate` + demo-site admin endpoints (mutate / reset over HTTP, mutation log, `--focus`) | P0 | S | 2 | 1.5 | 08:15 | 10:00 | SP-004a |
| [SP-005](SP-005-ledger-core.md) | Ledger core: `ledger.post` (savepoint), accounts, balance check, ledger-check function | P0 | S | 2 | 1.5 | 09:30 | 11:15 | SP-001a, SP-002, SP-001d |
| [SP-006a](SP-006a-gate-classify.md) | Gate core: pure `classify`, UA table, 402 body builder (JSON + D04 HTML), bench | P0 | D | 1 | 1 | 14:00 | 15:15 | none |
| [SP-006b](SP-006b-gate-middleware.md) | Gate middleware: fail-open, policy refresher, hit flusher, SIM flag; installed on the demo site | P0 | D | 2 | 1.5 | 16:00 | 17:45 | SP-006a, SP-004a, SP-001d |
| [SP-007a](SP-007a-auth-core.md) | Auth core: sessions, error envelope, CSRF, rate limits, audit (`AuditAction`) + tenancy helpers, log redaction | P0 | S | 2 | 1.5 | 09:30 | 11:15 | SP-001a, SP-002, SP-001d |
| [SP-007b](SP-007b-buyer-api-keys.md) | Buyer API keys: create / revoke, Bearer auth, scopes | P0 | S | 3 | 1 | 11:45 | 13:00 | SP-007a |
| [SP-008a](SP-008a-sites-connect-verify.md) | Sites: connect, verify, gate + crawl keys | P0 | D | 3 | 1 | 13:00 | 14:15 | SP-007a, SP-009a1 |
| [SP-008b](SP-008b-gate-endpoints.md) | Gate endpoints: `GET /api/gate/policy`, `POST /api/gate/hits`, gate-status | P0 | D | 4 | 1 | 15:15 | 16:30 | SP-008a |
| [SP-009a1](SP-009a1-crawler-io.md) | Crawler I/O: `safeFetch` (SSRF, pinned IP, redirect hops), sitemap / sitemap index, page upsert | P0 | S | 2 | 1 | 08:45 | 10:00 | SP-001a, SP-002 |
| [SP-009a2](SP-009a2-crawler-run.md) | Crawler run: `fetchPage` (ETag, snapshots), per-host queue, run lifecycle, hooks, discovery hand-off | P0 | S | 3 | 1.5 | 10:00 | 11:45 | SP-009a1 |
| [SP-009b](SP-009b-crawl-api.md) | Crawl API: `POST /crawl`, resume PAUSED, runs list, progress SSE, verify → discovery crawl | P0 | D | 4 | 1 | 16:45 | 18:00 | SP-009a2, SP-008a |
| [SP-010](SP-010-template-clustering.md) | Template clustering + cleaned DOM outline (pure) | P0 | S | 1 | 1 | 06:30 | 07:45 | none |
| [SP-011](SP-011-extractor-dsl.md) | Extractor DSL `extract.ts`, safe JSONPath, transforms whitelist, canonical JSON + hash (pure) | P0 | S | 1 | 1.5 | 06:30 | 08:15 | none |
| [SP-012a](SP-012a-schema-agent-propose.md) | Schema agent: Claude `propose_schema`, PII / rights guard, injection fixture, persist, resumable trigger | P0 | S | 4 | 2 | 11:45 | 14:00 | SP-010, SP-011, SP-009a2, SP-002, SP-004a |
| [SP-012b](SP-012b-schema-selfcheck-repair.md) | Schema agent self-check + repair, JSON-LD-only fallback | P0 | – | 5 | 1.5 | 20:45 | 22:30 | SP-012a |
| [SP-013](SP-013-records-versions-watermark.md) | Records upsert, versions, JSON Patch, watermark locks (`extractPage`, `extractTemplate`, `publishWatermark`) | P0 | S | 2 | 2 | 10:00 | 12:15 | SP-011, SP-002 |
| [SP-014a](SP-014a-dataset-approve-api.md) | Dataset PATCH / approve / reject / unpublish (filter indexes, APPROVE extract run, policy bump, crawl wiring) | P0 | S | 5 | 2 | 14:00 | 16:15 | SP-012a, SP-013, SP-007a, SP-009a2, SP-015, SP-004b |
| [SP-014b](SP-014b-dataset-read-apis.md) | Dataset read APIs: proposals list and `GET /api/datasets/:id` (schema, prices, 20 sample rows) | P0 | D | 5 | 1 | 16:30 | 17:45 | SP-012a, SP-007a |
| [SP-015](SP-015-records-query-changes.md) | Records query (filters, sort, keyset cursor, `fieldExpr`) + changes reader (watermark, hidden-field stripping) | P0 | S | 2 | 1.5 | 10:00 | 11:45 | SP-001a, SP-002, SP-011 |
| [SP-016](SP-016-metering-charge.md) | Metering: `chargeAndRecord`, client idempotency (402 re-attempt), charge-on-2xx, commission snapshot | P0 | S | 3 | 2 | 11:15 | 13:30 | SP-005 |
| [SP-017a](SP-017a-paid-read-service.md) | Paid-read service layer: `paidRead`, `quote`, catalog, 402 contract builder | P0 | S | 4 | 1.5 | 13:30 | 15:15 | SP-015, SP-016 |
| [SP-017b](SP-017b-v1-routes.md) | Buyer data API `/v1` routes, Spigot-* headers, max price, rate limit | P0 | D | 5 | 1.5 | 17:00 | 18:45 | SP-017a, SP-007b |
| [SP-018a](SP-018a-topup-core.md) | Top-up core: wallet order, capture, `creditTopup` (amount check), return URL | P0 | S | 3 | 1.5 | 11:15 | 13:00 | SP-001b, SP-005, SP-007a |
| [SP-018b](SP-018b-topup-helpers.md) | Top-up helpers: server-side SIM card top-up (deterministic id) and agent approval-link top-up | P0 | D | 4 | 1 | 13:00 | 14:15 | SP-018a |
| [SP-019](SP-019-jobs-poller-sweeps.md) | Jobs: top-up poller, ABANDONED sweep (safe), response-body purge, change retention | P0 | – | 4 | 1 | 22:30 | 23:45 | SP-018a |
| [SP-020](SP-020-payout-run.md) | `payoutRun`: batch build, PAYOUT_SENT, SUBMITTED, `pp.payout`, crash-resume, INSUFFICIENT_FUNDS | P0 | S | 3 | 1.5 | 11:45 | 13:30 | SP-001c, SP-005, SP-003 |
| [SP-021](SP-021-payout-status-api.md) | Payout status poll + item reconcile (incl. UNCLAIMED → SUCCESS / RETURNED), payouts API, run-now | P0 | S | 4 | 1.5 | 13:30 | 15:15 | SP-020, SP-007a |
| [SP-022a](SP-022a-mcp-server-read-tools.md) | MCP server `/mcp` (stateful sessions): auth, rate limit, list / describe / quote / search_records / get_changes | P0 | S | 5 | 1.5 | 15:15 | 17:00 | SP-017a, SP-007b |
| [SP-022b](SP-022b-mcp-balance-topup.md) | MCP `get_balance` + `top_up` (approval link) | P0 | – | 6 | 1 | 21:15 | 22:30 | SP-022a, SP-018b |
| [SP-023](SP-023-openapi.md) | OpenAPI 3.1 from Zod, served at `/v1/openapi.yaml` | P0 | – | 6 | 1 | 21:30 | 22:45 | SP-017b |
| [SP-024a](SP-024a-web-scaffold.md) | Web scaffold: Vite + React + Tailwind, AG Grid / Charts, tokens, pre-registered routes, static serving, API client, SSE hook | P0 | D | 1 | 1.5 | 12:15 | 14:00 | none |
| [SP-024b](SP-024b-web-components-login.md) | Web shared components (Money, SimChip, StatusPill, …), shells, publisher + buyer login pages | P0 | D | 3 | 1 | 14:15 | 15:30 | SP-024a, SP-007a, SP-001d |
| [SP-025](SP-025-publisher-sse.md) | Publisher SSE event bus (`/api/publishers/me/events`) | P0 | D | 3 | 1 | 15:30 | 16:45 | SP-007a |
| [SP-026](SP-026-w02-w03-onboarding.md) | W02 sign up + connect and W03 install + verify + first crawl | P0 | D | 5 | 1.5 | 18:30 | 20:15 | SP-024b, SP-008b, SP-009b |
| [SP-027a](SP-027a-bots-api.md) | Bots + activity APIs: `GET /api/sites/:id/bots`, `GET /api/publishers/me/activity` | P0 | D | 5 | 1 | 16:30 | 17:45 | SP-008b |
| [SP-027b](SP-027b-w04-bot-report.md) | W04 Overview / bot report (AG Grid + AG Charts, live, activity feed) | P0 | D | 6 | 1.5 | 18:45 | 20:30 | SP-024b, SP-027a, SP-025 |
| [SP-028](SP-028-w05-proposals.md) | W05 Record types found (hero) | P0 | D | 6 | 1.5 | 18:45 | 20:30 | SP-024b, SP-014b |
| [SP-029](SP-029-w06-dataset-editor.md) | W06 Dataset editor + publish (schema-driven AG Grid) | P0 | D | 6 | 2 | 17:45 | 20:00 | SP-024b, SP-014b (soft: SP-014a) |
| [SP-030a](SP-030a-earnings-ledger-usage-api.md) | Earnings, ledger and buyer-usage read APIs | P0 | D | 4 | 1 | 15:15 | 16:30 | SP-016, SP-007a |
| [SP-030b](SP-030b-w08-earnings.md) | W08 Earnings (KPIs, AG Charts, grouped AG Grid, ledger tab) | P0 | D | 5 | 1.5 | 17:45 | 19:30 | SP-024b, SP-030a, SP-025 |
| [SP-031](SP-031-w09-payouts.md) | W09 Payouts (master/detail grid, Run payout now, SIM in statements) | P0 | D | 5 | 1.5 | 19:00 | 20:45 | SP-024b, SP-021 |
| [SP-032](SP-032-w11-buyer-portal.md) | W11 Buyer portal: balance, Top up with PayPal (JS SDK v6), keys, Claude Desktop config | P0 | D | 4 | 2 | 16:15 | 18:30 | SP-024b, SP-018a, SP-007b |
| [SP-033](SP-033-w13-catalog-page.md) | W13 public catalog page `/c/:site` + terms | P0 | D | 5 | 1 | 20:30 | 21:45 | SP-017a |
| [SP-034](SP-034-w16-settings.md) | W16 Settings (account, payout email, gate policy, key rotation) | P0 | – | 5 | 1 | 22:30 | 23:45 | SP-024b, SP-008b |
| [SP-035](SP-035-seed-demo.md) | `seed:demo`: publisher, site, Acme + 20 SIM buyers, SIM sandbox top-ups (deterministic ids) | P0 | D | 5 | 1.5 | 14:15 | 16:00 | SP-018b, SP-008a, SP-007b, SP-012a |
| [SP-036](SP-036-sim-buyers.md) | `sim:buyers` (simulated week at insert time + `--live`) | P0 | D | 6 | 1 | 20:15 | 21:30 | SP-035, SP-017b, SP-014a |
| [SP-037](SP-037-sim-bots.md) | `sim:bots` (real HTTP with bot UAs, SIM-flagged, batched backfill) | P0 | D | 5 | 1 | 20:00 | 21:15 | SP-006b, SP-008b |
| [SP-038](SP-038-demo-reset-payout.md) | `demo:reset` + `demo:payout` (no deletes, DEMO_RESET transition, demo-site reset over HTTP) | P0 | D | 6 | 1 | 17:45 | 19:00 | SP-035, SP-021, SP-014a, SP-008b, SP-004b |
| [SP-039a](SP-039a-demo-kit.md) | Demo kit: `scraper-demo.py`, Claude Desktop config doc, prompt card, dry-run checklist | P0 | D | 3 | 0.5 | 18:00 | 18:45 | SP-006b |
| [SP-039b](SP-039b-local-dry-run.md) | Local end-to-end dry run with Claude Desktop (human-led, before the freeze) | P0 | D | 7 | 1 | 19:30 | 20:45 | SP-035, SP-032, SP-030b, SP-038, SP-022a, SP-039a |
| [SP-040](SP-040-render-deploy-config.md) | Render deploy config: `render.yaml`, paid Postgres, env, migrate on deploy, demo site service + disk | P0 | S | 2 | 1.5 | 10:00 | 11:45 | SP-001a, SP-002, SP-004a |
| [SP-041a](SP-041a-workflows-dispatch-crawl.md) | Render Workflows dispatch + crawl / extract tasks (structural 2-per-host fan-out) | P0 | – | 6 | 1.5 | 21:45 | 23:30 | SP-009b, SP-014a, SP-040 |
| [SP-041b](SP-041b-workflows-payout-render.md) | Render Workflows `payoutRun` task, workflow service, Render verification (post-freeze) | P0 | – | 7 | 1 | 23:30 | 00:45 +1d | SP-041a, SP-020 |
| [SP-042](SP-042-security-tests.md) | Security tests: route-table tenancy matrix, hidden-field sweep, revoked keys, SSRF, checklist | P0 | – | 6 | 1.5 | 22:30 | 00:15 +1d | SP-017b, SP-022a, SP-014a |
| [SP-043](SP-043-admin-ops-endpoints.md) | Admin ops endpoints: audit search, ledger check, health | P0 | – | 3 | 1 | 21:15 | 22:30 | SP-005, SP-007a |
| [SP-044](SP-044-readme-license.md) | README + LICENSE (MIT) | P0 | S | 1 | 1.5 | 07:45 | 09:30 | none |
| [SP-044b](SP-044b-readme-fresh-clone.md) | README fresh-clone verification by another worker (FakePayPal) | P0 | – | 6 | 0.5 | 20:45 | 21:30 | SP-044, SP-035 |
| [SP-045](SP-045-devpost-draft.md) | Devpost draft | P0 | – | 1 | 0.5 | 20:30 | 21:15 | none |
| [SP-046](SP-046-video-devpost-submission.md) | Demo video + Devpost submission (after code freeze) | P0 | D | 8 | 3 | 21:30 | 00:45 +1d | SP-039b, SP-038, SP-044b, SP-045, SP-036, SP-037, SP-026, SP-027b, SP-028, SP-029, SP-030b, SP-031, SP-032 |
| [SP-047a](SP-047a-auto-topup-core.md) | Auto top-up core: vault MIT on a short charge, VAULT_MIT cap, one in flight, lock order | P1 | – | 4 | 1.5 | 00:15 +1d | 02:00 +1d | SP-016, SP-018a, SP-003 |
| [SP-047b](SP-047b-auto-topup-settings-ui.md) | Auto top-up settings API, W11 card, MCP `top_up` from vault, `demo:decline` | P1 | – | 7 | 1.5 | 02:45 +1d | 04:30 +1d | SP-047a, SP-032, SP-022b |
| [SP-047c](SP-047c-auto-topup-threshold-sweep.md) | Auto top-up below threshold (async after charge) + orphaned VAULT_MIT sweep | P1 | – | 5 | 1 | 05:30 +1d | 06:45 +1d | SP-047a, SP-019 |
| [SP-048a](SP-048a-claims-core.md) | Claims core: `/v1/claims`, eligibility, MISSING_FIELD / DUPLICATE, CREDIT, locked abuse limit | P1 | – | 6 | 1.5 | 23:45 | 01:30 +1d | SP-017b |
| [SP-048b](SP-048b-claims-triage-agent.md) | Claims triage agent (Claude recommendation) + publisher decide endpoint | P1 | – | 7 | 1.5 | 03:00 +1d | 04:45 +1d | SP-048a |
| [SP-048c](SP-048c-claims-stale-refetch-mcp.md) | Claims STALE / REMOVED targeted re-fetch + MCP `report_bad_record` | P1 | – | 7 | 1.5 | 03:00 +1d | 04:45 +1d | SP-048a, SP-013, SP-004b, SP-022a, SP-009a2 |
| [SP-049](SP-049-refund-unused-balance.md) | Refund unused balance via PayPal Refunds (sweep, poll, locked slicing) | P1 | – | 4 | 2 | 22:45 | 01:00 +1d | SP-018a, SP-001c, SP-003 |
| [SP-050](SP-050-w12-usage-claims-refund.md) | W12 Buyer usage & claims (refund button) + publisher claims tab | P1 | – | 7 | 2 | 01:30 +1d | 03:45 +1d | SP-048a, SP-049, SP-032, SP-030b |
| [SP-051](SP-051-gate-reverse-dns.md) | Gate reverse-DNS verification for search crawlers (async, cached) | P1 | – | 3 | 1 | 05:00 +1d | 06:15 +1d | SP-006b |
| [SP-052a](SP-052a-drift-detection.md) | Drift detection, LIVE_STALE (no writes), `DEMO_LAYOUT=v2` | P1 | – | 6 | 1.5 | 23:45 | 01:30 +1d | SP-013, SP-014a, SP-004b |
| [SP-052b](SP-052b-reinference.md) | Re-inference (`/reinfer`), approve v(n+1), W06 stale banner | P1 | – | 7 | 1.5 | 01:30 +1d | 03:15 +1d | SP-052a, SP-012b, SP-029 |
| [SP-053](SP-053-w07-records-browser.md) | W07 Records browser (server-side rows, version history) | P1 | – | 4 | 2 | 00:45 +1d | 03:00 +1d | SP-024b, SP-015 |
| [SP-054](SP-054-w10-crawls-health.md) | W10 Crawls & health | P1 | – | 5 | 1.5 | 03:15 +1d | 05:00 +1d | SP-024b, SP-009b |
| [SP-055](SP-055-cms-ping.md) | CMS ping `POST /api/sites/:id/ping` + `demo:mutate --ping` | P1 | – | 5 | 1 | 05:30 +1d | 06:45 +1d | SP-009b, SP-004b |
| [SP-056](SP-056-apimatic-sdk.md) | APIMatic TypeScript + Python SDK from `openapi.yaml` | P1 | – | 7 | 1.5 | 04:45 +1d | 06:30 +1d | SP-023, SP-040 |
| [SP-057](SP-057-w01-landing.md) | W01 Landing page | P1 | – | 4 | 1.5 | 03:45 +1d | 05:30 +1d | SP-024b |
| [SP-058](SP-058-login-with-paypal.md) | Log in with PayPal for publishers | P1 | – | 6 | 2 | 00:45 +1d | 03:00 +1d | SP-007a, SP-026 |
| [SP-059](SP-059-paypal-webhooks.md) | PayPal webhooks: verify (raw body), dedupe, durable processing, handlers; spike S11 | P1 | – | 5 | 1.5 | 04:30 +1d | 06:15 +1d | SP-018a, SP-021, SP-040, SP-001c, SP-049, SP-047a |
| [SP-060](SP-060-weekly-payout-cron.md) | Weekly payout cron + failed-item retry | P1 | – | 5 | 1 | 06:00 +1d | 07:15 +1d | SP-021 |
| [SP-061](SP-061-scheduled-recrawl-nightly-check.md) | Scheduled re-crawl (15 min) + nightly ledger check | P1 | – | 5 | 1 | 06:15 +1d | 07:30 +1d | SP-009b, SP-043 |
| [SP-062](SP-062-w14-admin-audit.md) | W14 Admin / audit screen | P1 | – | 4 | 1.5 | 02:00 +1d | 03:45 +1d | SP-043, SP-024b |
| [SP-063](SP-063-card-fields-topup.md) | Card-fields top-up (JS SDK v6 card fields, vaulted) | P1 | – | 5 | 1.5 | 01:00 +1d | 02:45 +1d | SP-032 |
| [SP-064](SP-064-playwright-render.md) | Playwright render for JS-heavy templates | P1 | – | 4 | 1.5 | 03:45 +1d | 05:30 +1d | SP-009a2 |
| [SP-065](SP-065-dom-fingerprint-clustering.md) | DOM-fingerprint cluster confirmation | P1 | – | 2 | 1 | 04:45 +1d | 06:00 +1d | SP-010 |

## Dependency graph

P0 (spine in amber). An arrow means "must merge before". Soft dependencies aren't drawn.

```mermaid
flowchart LR
  classDef spine fill:#fde68a,stroke:#b45309
  classDef p1 fill:#e5e7eb,stroke:#6b7280,color:#374151
  n001a["SP-001a"] :::spine
  n001d["SP-001d"] :::spine
  n001b["SP-001b"] :::spine
  n001c["SP-001c"] :::spine
  n002["SP-002"] :::spine
  n003["SP-003"] :::spine
  n004a["SP-004a"] :::spine
  n004b["SP-004b"] :::spine
  n005["SP-005"] :::spine
  n006a["SP-006a"]
  n006b["SP-006b"]
  n007a["SP-007a"] :::spine
  n007b["SP-007b"] :::spine
  n008a["SP-008a"]
  n008b["SP-008b"]
  n009a1["SP-009a1"] :::spine
  n009a2["SP-009a2"] :::spine
  n009b["SP-009b"]
  n010["SP-010"] :::spine
  n011["SP-011"] :::spine
  n012a["SP-012a"] :::spine
  n012b["SP-012b"]
  n013["SP-013"] :::spine
  n014a["SP-014a"] :::spine
  n014b["SP-014b"]
  n015["SP-015"] :::spine
  n016["SP-016"] :::spine
  n017a["SP-017a"] :::spine
  n017b["SP-017b"]
  n018a["SP-018a"] :::spine
  n018b["SP-018b"]
  n019["SP-019"]
  n020["SP-020"] :::spine
  n021["SP-021"] :::spine
  n022a["SP-022a"] :::spine
  n022b["SP-022b"]
  n023["SP-023"]
  n024a["SP-024a"]
  n024b["SP-024b"]
  n025["SP-025"]
  n026["SP-026"]
  n027a["SP-027a"]
  n027b["SP-027b"]
  n028["SP-028"]
  n029["SP-029"]
  n030a["SP-030a"]
  n030b["SP-030b"]
  n031["SP-031"]
  n032["SP-032"]
  n033["SP-033"]
  n034["SP-034"]
  n035["SP-035"]
  n036["SP-036"]
  n037["SP-037"]
  n038["SP-038"]
  n039a["SP-039a"]
  n039b["SP-039b"]
  n040["SP-040"] :::spine
  n041a["SP-041a"]
  n041b["SP-041b"]
  n042["SP-042"]
  n043["SP-043"]
  n044["SP-044"] :::spine
  n044b["SP-044b"]
  n045["SP-045"]
  n046["SP-046"]
  n001a --> n001b
  n001a --> n001c
  n004a --> n004b
  n001a --> n005
  n002 --> n005
  n001d --> n005
  n006a --> n006b
  n004a --> n006b
  n001d --> n006b
  n001a --> n007a
  n002 --> n007a
  n001d --> n007a
  n007a --> n007b
  n007a --> n008a
  n009a1 --> n008a
  n008a --> n008b
  n001a --> n009a1
  n002 --> n009a1
  n009a1 --> n009a2
  n009a2 --> n009b
  n008a --> n009b
  n010 --> n012a
  n011 --> n012a
  n009a2 --> n012a
  n002 --> n012a
  n004a --> n012a
  n012a --> n012b
  n011 --> n013
  n002 --> n013
  n012a --> n014a
  n013 --> n014a
  n007a --> n014a
  n009a2 --> n014a
  n015 --> n014a
  n004b --> n014a
  n012a --> n014b
  n007a --> n014b
  n001a --> n015
  n002 --> n015
  n011 --> n015
  n005 --> n016
  n015 --> n017a
  n016 --> n017a
  n017a --> n017b
  n007b --> n017b
  n001b --> n018a
  n005 --> n018a
  n007a --> n018a
  n018a --> n018b
  n018a --> n019
  n001c --> n020
  n005 --> n020
  n003 --> n020
  n020 --> n021
  n007a --> n021
  n017a --> n022a
  n007b --> n022a
  n022a --> n022b
  n018b --> n022b
  n017b --> n023
  n024a --> n024b
  n007a --> n024b
  n001d --> n024b
  n007a --> n025
  n024b --> n026
  n008b --> n026
  n009b --> n026
  n008b --> n027a
  n024b --> n027b
  n027a --> n027b
  n025 --> n027b
  n024b --> n028
  n014b --> n028
  n024b --> n029
  n014b --> n029
  n016 --> n030a
  n007a --> n030a
  n024b --> n030b
  n030a --> n030b
  n025 --> n030b
  n024b --> n031
  n021 --> n031
  n024b --> n032
  n018a --> n032
  n007b --> n032
  n017a --> n033
  n024b --> n034
  n008b --> n034
  n018b --> n035
  n008a --> n035
  n007b --> n035
  n012a --> n035
  n035 --> n036
  n017b --> n036
  n014a --> n036
  n006b --> n037
  n008b --> n037
  n035 --> n038
  n021 --> n038
  n014a --> n038
  n008b --> n038
  n004b --> n038
  n006b --> n039a
  n035 --> n039b
  n032 --> n039b
  n030b --> n039b
  n038 --> n039b
  n022a --> n039b
  n039a --> n039b
  n001a --> n040
  n002 --> n040
  n004a --> n040
  n009b --> n041a
  n014a --> n041a
  n040 --> n041a
  n041a --> n041b
  n020 --> n041b
  n017b --> n042
  n022a --> n042
  n014a --> n042
  n005 --> n043
  n007a --> n043
  n044 --> n044b
  n035 --> n044b
  n039b --> n046
  n038 --> n046
  n044b --> n046
  n045 --> n046
  n036 --> n046
  n037 --> n046
  n026 --> n046
  n027b --> n046
  n028 --> n046
  n029 --> n046
  n030b --> n046
  n031 --> n046
  n032 --> n046
```

P1 (grey) with the P0 tickets they hang off.

```mermaid
flowchart LR
  classDef spine fill:#fde68a,stroke:#b45309
  classDef p1 fill:#e5e7eb,stroke:#6b7280,color:#374151
  n001c["SP-001c"] :::spine
  n003["SP-003"] :::spine
  n004b["SP-004b"] :::spine
  n006b["SP-006b"]
  n007a["SP-007a"] :::spine
  n009a2["SP-009a2"] :::spine
  n009b["SP-009b"]
  n010["SP-010"] :::spine
  n012b["SP-012b"]
  n013["SP-013"] :::spine
  n014a["SP-014a"] :::spine
  n015["SP-015"] :::spine
  n016["SP-016"] :::spine
  n017b["SP-017b"]
  n018a["SP-018a"] :::spine
  n019["SP-019"]
  n021["SP-021"] :::spine
  n022a["SP-022a"] :::spine
  n022b["SP-022b"]
  n023["SP-023"]
  n024b["SP-024b"]
  n026["SP-026"]
  n029["SP-029"]
  n030b["SP-030b"]
  n032["SP-032"]
  n040["SP-040"] :::spine
  n043["SP-043"]
  n047a["SP-047a"] :::p1
  n047b["SP-047b"] :::p1
  n047c["SP-047c"] :::p1
  n048a["SP-048a"] :::p1
  n048b["SP-048b"] :::p1
  n048c["SP-048c"] :::p1
  n049["SP-049"] :::p1
  n050["SP-050"] :::p1
  n051["SP-051"] :::p1
  n052a["SP-052a"] :::p1
  n052b["SP-052b"] :::p1
  n053["SP-053"] :::p1
  n054["SP-054"] :::p1
  n055["SP-055"] :::p1
  n056["SP-056"] :::p1
  n057["SP-057"] :::p1
  n058["SP-058"] :::p1
  n059["SP-059"] :::p1
  n060["SP-060"] :::p1
  n061["SP-061"] :::p1
  n062["SP-062"] :::p1
  n063["SP-063"] :::p1
  n064["SP-064"] :::p1
  n065["SP-065"] :::p1
  n001a --> n001c
  n004a --> n004b
  n006a --> n006b
  n004a --> n006b
  n001d --> n006b
  n001a --> n007a
  n002 --> n007a
  n001d --> n007a
  n009a1 --> n009a2
  n009a2 --> n009b
  n008a --> n009b
  n012a --> n012b
  n011 --> n013
  n002 --> n013
  n012a --> n014a
  n013 --> n014a
  n007a --> n014a
  n009a2 --> n014a
  n015 --> n014a
  n004b --> n014a
  n001a --> n015
  n002 --> n015
  n011 --> n015
  n005 --> n016
  n017a --> n017b
  n007b --> n017b
  n001b --> n018a
  n005 --> n018a
  n007a --> n018a
  n018a --> n019
  n020 --> n021
  n007a --> n021
  n017a --> n022a
  n007b --> n022a
  n022a --> n022b
  n018b --> n022b
  n017b --> n023
  n024a --> n024b
  n007a --> n024b
  n001d --> n024b
  n024b --> n026
  n008b --> n026
  n009b --> n026
  n024b --> n029
  n014b --> n029
  n024b --> n030b
  n030a --> n030b
  n025 --> n030b
  n024b --> n032
  n018a --> n032
  n007b --> n032
  n001a --> n040
  n002 --> n040
  n004a --> n040
  n005 --> n043
  n007a --> n043
  n016 --> n047a
  n018a --> n047a
  n003 --> n047a
  n047a --> n047b
  n032 --> n047b
  n022b --> n047b
  n047a --> n047c
  n019 --> n047c
  n017b --> n048a
  n048a --> n048b
  n048a --> n048c
  n013 --> n048c
  n004b --> n048c
  n022a --> n048c
  n009a2 --> n048c
  n018a --> n049
  n001c --> n049
  n003 --> n049
  n048a --> n050
  n049 --> n050
  n032 --> n050
  n030b --> n050
  n006b --> n051
  n013 --> n052a
  n014a --> n052a
  n004b --> n052a
  n052a --> n052b
  n012b --> n052b
  n029 --> n052b
  n024b --> n053
  n015 --> n053
  n024b --> n054
  n009b --> n054
  n009b --> n055
  n004b --> n055
  n023 --> n056
  n040 --> n056
  n024b --> n057
  n007a --> n058
  n026 --> n058
  n018a --> n059
  n021 --> n059
  n040 --> n059
  n001c --> n059
  n049 --> n059
  n047a --> n059
  n021 --> n060
  n009b --> n061
  n043 --> n061
  n043 --> n062
  n024b --> n062
  n032 --> n063
  n009a2 --> n064
  n010 --> n065
```

## Critical path

Post-freeze tickets (SP-039b, SP-041b, SP-046) are left out; times include 15 min of review per ticket and assume unlimited workers.
- **Longest pre-freeze chain (11.5 h, earliest finish 18:00 IST):** SP-002 (2) → SP-009a1 (1) → SP-009a2 (1.5) → SP-012a (2) → SP-014a (2) → SP-041a (1.5).
- **AI chain to approve (9.75 h):** SP-002 (2) → SP-009a1 (1) → SP-009a2 (1.5) → SP-012a (2) → SP-014a (2). The crawler split (SP-009a1/a2) and SP-012a sit here; give them the fastest review.
- **Money chain to the paid MCP call (9.75 h):** SP-002 (2) → SP-005 (1.5) → SP-016 (2) → SP-017a (1.5) → SP-022a (1.5).
- **W06 publish screen (11 h):** SP-002 (2) → SP-009a1 (1) → SP-009a2 (1.5) → SP-012a (2) → SP-014b (1) → SP-029 (2), with SP-014a as a soft dependency. On hard dependencies it couldn't merge before ~18:30 even with unlimited workers.
- **The binding constraint at 6 workers is capacity, not the chain:** every chain finishes before 18:00 on its own, but there are 72.5 worker-h of on-screen work for 69 worker-h of capacity.
- **Spine set (dispatch first):** SP-001a, SP-001b, SP-001c, SP-001d, SP-002, SP-003, SP-004a, SP-004b, SP-005, SP-007a, SP-007b, SP-009a1, SP-009a2, SP-010, SP-011, SP-012a, SP-013, SP-014a, SP-015, SP-016, SP-017a, SP-018a, SP-020, SP-021, SP-022a, SP-040, SP-044.

## Wave plan (6 workers)

A wave is every ticket whose dependencies are all in earlier waves. With 6 workers a wave takes longer than one ticket; a worker that frees up takes the next ready ticket in dispatch order from any wave. "Last P0 merge" is the projection for the wave's last P0 ticket at 6 workers.

| Wave | P0 tickets | P1 tickets (only when no P0 is ready) | P0 worker-h | Last P0 merge @6 |
|---|---|---|---|---|
| 1 | SP-001a, SP-001d, SP-002, SP-003, SP-004a, SP-006a, SP-010, SP-011, SP-024a, SP-044, SP-045 | – | 14.5 | 21:15 |
| 2 | SP-001b, SP-001c, SP-004b, SP-005, SP-006b, SP-007a, SP-009a1, SP-013, SP-015, SP-040 | SP-065 | 15 | 17:45 |
| 3 | SP-007b, SP-008a, SP-009a2, SP-016, SP-018a, SP-020, SP-024b, SP-025, SP-039a, SP-043 | SP-051 | 12 | 22:30 |
| 4 | SP-008b, SP-009b, SP-012a, SP-017a, SP-018b, SP-019, SP-021, SP-030a, SP-032 | SP-047a, SP-049, SP-053, SP-057, SP-062, SP-064 | 12 | 23:45 |
| 5 | SP-012b, SP-014a, SP-014b, SP-017b, SP-022a, SP-026, SP-027a, SP-030b, SP-031, SP-033, SP-034, SP-035, SP-037 | SP-047c, SP-054, SP-055, SP-059, SP-060, SP-061, SP-063 | 17.5 | 23:45 |
| 6 | SP-022b, SP-023, SP-027b, SP-028, SP-029, SP-036, SP-038, SP-041a, SP-042, SP-044b | SP-048a, SP-052a, SP-058 | 12.5 | 00:15 +1d |
| 7 | SP-039b, SP-041b | SP-047b, SP-048b, SP-048c, SP-050, SP-052b, SP-056 | 2 | 00:45 +1d |
| 8 | SP-046 | – | 3 | 00:45 +1d |

Rules:
- **Wave 1 is ten tickets**, so all 6 workers start at once: SP-001a, SP-001d, SP-002, SP-003, SP-004a, SP-006a, SP-010, SP-011, SP-024a, SP-044 (+ SP-045). Tickets other than SP-001a that live in a workspace SP-001a creates (SP-002's `apps/api/src/db`, SP-001d, SP-006a, SP-010, SP-011, SP-024a) code against the agreed layout and **rebase on SP-001a before merging**. **Schema freeze at SP-002's merge (~08:45 IST).**
- **Hooks instead of hard links:** the crawler exposes `onPageChanged`, `onRunFinished` and `onDiscoveryDone` (SP-009a2); the schema agent (SP-012a) and extraction wiring (SP-014a) register on them.
- **UI tickets may start in fixture mode** (SP-024a); a screen still merges only after it works against its merged API.
- **Money tests run on FakePayPal** (`PAYPAL_MODE=stub`, SP-001b/001c). Race and idempotency tests are acceptance criteria of the ticket that creates the race (SP-005, 016, 018a, 018b, 019, 020, 021, 022a/b, 035, 047a, 047c, 048a, 048c, 049, 059, 063).
- **Background jobs** run in-process under Postgres advisory locks (`runEvery`, SP-002; `*.job.ts`). Render cron is optional (SP-060, SP-061).
- **One writer per piece of state:** crawler → snapshots (SP-009a2), extractor → records (SP-013), ledger → money (SP-005).

## Checkpoints (IST, with PST)

| Checkpoint | IST | PST | Gate |
|---|---|---|---|
| Start | 06:30 | 17:00 Nov 11 | Wave 1 dispatched to 6 workers; human sets up the publisher sandbox account, `.env`, and `scripts/dev-db.sh`. |
| Schema freeze | ~08:45 | | SP-002 merged. |
| CP1 | ~11:15 | | SP-001a/b/c/d, SP-005 ledger, SP-007a auth, SP-009a1 crawler I/O merged; SP-003 S7/S8 results in. |
| **Kill checkpoint** | **~17:15** | 03:45 Nov 12 | Loop green locally with no hand-edited rows: crawl demo site → AI proposal → approve → ≥ 2,000 records → one real sandbox top-up → Claude Desktop `search_records` charged exactly. |
| Backend freeze | **18:00** | 04:30 | Spine, SP-040, SP-044 merged; deploy main to Render. |
| Recording pass 1 | 18:30–20:00 | 05:00–06:30 | Terminal 402, W11 top-up, Claude Desktop call, CLI payout (human). |
| Screen freeze | ~21:45 | | Last on-screen PR merged; SP-039b dry run done. |
| Recording pass 2 + publish | to ~23:00 | to 09:30 | Screen beats; YouTube; README URLs (SP-046); Devpost. |
| **Submit** | **23:30** | 10:00 | Devpost submitted. Hard deadline 01:30 IST Nov 13. |

## Circuit breakers

None of these removes a ticket; they change what the demo shows.
- **SP-003 S7b wallet fails:** card-fields top-up (SP-063) becomes the W11 path when it lands; until then the demo top-up is recorded with whatever passed, and the README says so.
- **S8 vault MIT fails:** auto top-up (SP-047a/b/c) returns an approval link instead of charging the vault; `PAYPAL_WALLET_VAULT=off`.
- **S9 refund fails:** claims stay as balance credits; SP-049 is parked.
- **Claude API down or no key yet:** `SCHEMA_AGENT_MODE=recorded` replays the hand-authored or last real proposal, labelled "replayed proposal" (SP-012a); JSON-LD-only fallback (SP-012b).
- **Render Workflows misbehaves:** `WORKFLOWS_MODE=inproc` stays the default (SP-041a/b); README states which ran.
- **Payout `INSUFFICIENT_FUNDS`:** lower the demo threshold or pre-fund the merchant sandbox account (SP-020).
- **Screens late at the screen freeze:** record pass 1 footage plus existing screens; README lists what wasn't recorded.

## Spec amendments (the owning ticket updates the spec file in its PR)

| Change | Spec file | Ticket |
|---|---|---|
| New columns, statuses and kinds: `records.updated_at` semantics, `crawl_runs.trigger APPROVE`, `topups` (`idempotency_key`, `pending_reason`, `paypal_fee_cents`, `needs_reconcile`, `REFUNDED`, `ABANDONED → COMPLETED`), `payout_items.fee_cents`, `payout_batches.needs_reconcile`, `UNCLAIMED → SUCCESS`, `balance_refunds` (`PENDING`, `error_code`, `idempotency_key`), `publishers.is_demo`, `buyers.mock_decline_next`, ledger kinds `REFUND_REVERSAL` and `DEMO_RESET`, `api_calls` (`commission_bps`, `served_record_keys`, `hidden_at`), dataset `DEMO_RESET` transition | data-model.md | SP-002 |
| Rule 4: the auto idempotency key includes a minute bucket; `409 IDEMPOTENCY_KEY_EXPIRED` after the body purge; a stored 402 is re-attempted, not replayed | data-model.md, api.md | SP-016 |
| Rule 11: cap and one-in-flight cover all `VAULT_MIT` top-ups (AUTO + MCP), CREATED + COMPLETED, calendar month UTC | data-model.md | SP-047a |
| `GET /api/datasets/:id` (schema, prices, 20 sample rows) | api.md | SP-014b |
| `GET /api/publishers/me/activity` | api.md | SP-027a |
| Gate hits payload gains per-bucket `isSimulated` | api.md | SP-001d |
| Changes cursor is opaque and encodes the dataset; `sort` only `updated_at` / `-updated_at` | api.md, features/05 | SP-015 |
| `POST /api/sites/:id/resume`; discovery hand-off on PARTIAL ≥ 90% | api.md, features/03 | SP-009b, SP-009a2 |
| `POST /admin/sites/:id/repropose`, `POST /admin/payouts/:batchId/reconcile` | api.md | SP-012a, SP-021 |
| Demo-site admin endpoints (`/admin/mutate`, `/admin/reset`), mutation log, `--focus`; leased rendered as `Offer.availability` + badge | features/01 | SP-004a, SP-004b |
| `CRAWL_MIN_GAP_MS` (25 ms for a gated, verified origin) to meet "< 4 min" | features/03 | SP-009a2 |
| Drift: probe before writing; no versions while `LIVE_STALE` | features/04 | SP-052a |

## Spec gaps and decisions taken in these tickets

| Topic | Decision | Ticket |
|---|---|---|
| Spec layout puts task code in `apps/api` but Workflows needs it too | Task functions stay in `apps/api/src/**`, exported as `@spigot/api/tasks`; `apps/workflows` is a thin Render entry. No `packages/core` | SP-001a, SP-041a |
| Kill checkpoint date already passed at start | ~17:15 IST at 6 workers | INDEX |
| `/v1` service vs routes | Split so MCP doesn't wait for HTTP routes | SP-017a, SP-017b |
| Webhooks priority | P1: feature 09 lists webhooks as P1 and pollers cover P0 (api.md) | SP-059 |
| SP-014a asserting the gate's `gatedPaths` would need SP-008b on the spine | SP-014a asserts the `policy_version` bump only; SP-008b asserts `gatedPaths` from LIVE datasets | SP-014a, SP-008b |
| Where `sim:buyers` gets a LIVE dataset | Depends on SP-014a; runs crawl + approve itself when none is LIVE | SP-036 |
| End-to-end dry run | SP-039b before the freeze (human-led); SP-046 repeats it on Render | SP-039a/b, SP-046 |
| Where the demo reset sends a buyer's balance | A `DEMO_RESET` ledger txn into platform revenue; no entry or call row is deleted | SP-038 |
| P1 tables | Created in the first migration so P1 never needs a migration | SP-002 |
| gstack "assignment" (talk to 2 site owners, 2 agent builders) | Not code; quoted in the README only if answers arrive | SP-044 |

## Review responses

Every finding in the three reviews is applied, except where noted below. The ticket that took each fix is named in the ticket itself.

| Review · item | Response |
|---|---|
| Data plane #3: "`records` has no `updated_at` column" | Partly wrong. data-model.md says every table has `created_at` and `updated_at`, so the column exists. The real gap was its meaning: a generic trigger would move it on a freshness-only refresh. Fixed: SP-013 sets it explicitly on content change only; SP-011 keeps it out of the hash; SP-002 adds the `(dataset_id, updated_at desc, id)` index. |
| Data plane #21: add SP-004a to SP-010 / SP-011 | Not applied as written; it conflicts with Cross-cutting #9 (start pure modules in Wave 1). SP-010 / SP-011 use hand-written fixtures that follow features/01's markup, and **SP-012a now depends on SP-004a** and re-runs the golden test on real demo-site pages. Same coverage, ~1.5 h earlier start. |
| Money #18, #19: SP-003 as a dependency | Applied as a hard dependency for SP-020, SP-047a and SP-049 (SP-003 is Wave 1, so it costs nothing). Kept as a **soft** dependency for SP-001b / SP-001c: a hard one would hold the PayPal client (on the spine) until a human finishes the wallet approval in S7b. |
| Cross-cutting #19: W15 copy owner "SP-024 or SP-017a" | Applied in **SP-001d** instead: the API (SP-017a, SP-022a) and the web (SP-024b, SP-032) both import it, and SP-001d lands in Wave 1, before either. |
| Cross-cutting #12: shared resources "with 8 workers" | Applied for 6 workers (the human's decision). |
| Money #3: claims need purged data | Applied with `api_calls.served_record_keys` (kept 7 days) rather than keeping full bodies for 7 days: smaller, and the 24 h body purge stays as the spec says. |
| Money #9 / Cross-cutting #24: `demo_run_id` or `hidden_at` | `hidden_at` plus rotating Acme's key. Rotation also removes the idempotency-collision risk the reviewer raised. |
| Data plane #16: mutation log "in env or on a Render disk" | Render disk. Env can't be written at runtime, so it can't hold a log. |
| Data plane #17: fold the dry run into SP-046 | Kept as its own ticket (SP-039b) so it runs **before** the freeze; SP-046 repeats it on Render. |
| Data plane #5: drift must write no versions | Applied with a dry-run probe on the first 20 changed pages before any write. A drift the probe misses is caught by the post-run backstop, which stops later runs and alerts; it can't retract versions already published. That limit is stated in SP-052a. |
| Data plane #1: crawl can't meet "< 4 min" | Agreed. `CRAWL_MIN_GAP_MS` defaults to 25 ms for a verified origin running our gate; concurrency stays at 2 per host, so spec 03's politeness rule still holds. |
| Data plane #10: SP-014a → SP-015 for `fieldExpr` | Applied. It adds no schedule cost because SP-015 is Wave 2. |
| New finding from re-planning | SP-029 (W06) now has SP-014a as a **soft** dependency; on hard dependencies W06 couldn't merge before ~18:30 even with unlimited workers. It still can't merge until Publish works against the merged SP-014a. |
