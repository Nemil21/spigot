# Spigot tickets: index

Source of truth: `docs/spec/` (README, data-model, api, screens, features 01–16), with `docs/research/15-gstack-spigot.md` for product context, `spikes/paypal-spikes.mjs` for what is already proven (S1–S4) and `spikes/s7-results.md` (Holdfast's S7, copied here) for sandbox facts. Format follows Holdfast's `docs/tickets/`.

**Scope rule.** No feature in the spec is dropped. Every P0 item is a P0 ticket; every P1 item is a P1 ticket ordered after P0 (spec README P1 list #1–#10 first, then the P1 items named only inside feature files). P2 items are README-only, as the spec says, and live in SP-044's scope.

**Builders.** Agent Orchestrator workers, **4 at once** by default. A ticket is ready when every ticket on its "Depends on" line is merged. Estimates are worker-hours for one worker (1–2 h each; larger work is split a/b). Projections below add 15 min per ticket for review and merge.

**Dispatch order.** P0 before P1. Within P0: **S** (spine: the kill-criterion loop and money out) first, then **D** (on screen in the video), then the rest; ties go to the ticket with the longest remaining chain. P1 starts only when no P0 ticket is ready.

**Totals:** P0: 57 tickets, 77.5 worker-h of code (+ SP-046 video/submission, 3 h, human-led) · P1: 22 tickets, 32.5 worker-h.

## Time budget and what is at risk (read this first)

Now: **06:30 IST Nov 12** (= 17:00 PST Nov 11). Code freeze **18:00 IST** (04:30 PST). Deploy, video, Devpost after. Submit **23:30 IST** (10:00 PST); Devpost's hard deadline is 01:30 IST Nov 13 (12:00 PST Nov 12).

The window is 11.5 h. With 4 workers that is ~46 worker-h, against **77.5 worker-h of P0 code**. P0 does not fit on 4 workers. Projections (list scheduling over the dependency graph, dispatch order above):

| Workers | Kill-criterion loop green (crawl → AI proposal → approve → records → top-up → paid MCP call) | All P0 code merged | Everything incl. P1 | P0 tickets still open at 18:00 |
|---|---|---|---|---|
| 4 | 17:30 | **06:45 +1d** | 16:15 +1d | SP-004b, SP-006b, SP-009b, SP-012b, SP-017b, SP-019, SP-022b, SP-023, SP-024, SP-025, SP-026, SP-027a, SP-027b, SP-028, SP-029, SP-030a, SP-030b, SP-031, SP-032, SP-033, SP-034, SP-035, SP-036, SP-037, SP-038, SP-039, SP-040, SP-041, SP-042, SP-043, SP-044 |
| 6 | 16:30 | 23:15 | 05:30 +1d | SP-004b, SP-012b, SP-019, SP-022b, SP-023, SP-026, SP-027b, SP-028, SP-029, SP-030b, SP-031, SP-033, SP-034, SP-036, SP-037, SP-038, SP-039, SP-041, SP-042, SP-043, SP-044 |
| 8 | 15:45 | **19:30** | 00:45 +1d | SP-012b, SP-019, SP-022b, SP-023, SP-026, SP-034, SP-041, SP-042, SP-043 |

What this means:
1. **At 4 workers, the backend spine makes it by 18:00 and almost nothing on screen does**: no dashboard (W04/W05/W06/W08/W09), no buyer portal (W11), no gate middleware on the demo site, no seed, no Render blueprint, no README. That isn't a demoable submission.
2. **Recommended: run 8 workers from the start until 18:00.** Every **D** ticket (everything on screen in the video) then merges by ~17:45, the spine is green at ~15:45, and all P0 code lands by ~19:30. The tickets still open at 18:00 are the ones the video can live without for an hour (self-check/repair polish, poller, OpenAPI, onboarding UI, settings, Workflows adapter, security tests, admin endpoints). Note the laptop limit (16 GB, several workers): keep `vitest --maxWorkers=2`, no dev servers left running. If 8 is too many, 6 workers is the floor that gets every **D** screen merged by ~20:30 at the cost of the video window.
3. **If the human keeps 4 workers**, a decision is needed now: either move the code freeze to ~21:00 IST and compress deploy + video + Devpost into 21:00–23:30 (very tight; the video alone was budgeted at 2.5 h), or accept that P0 screens slip and the video shows the API/MCP loop over a thinner UI. Nothing is removed from the ticket set either way.
4. **P1 does not fit today on any worker count we can run.** Even at 8 workers, P1 finishes after midnight. P1 tickets stay in the set, ordered, and are dispatched only when no P0 ticket is ready. The best value per hour is P1 #1 auto top-up (SP-047a, ready from Wave 4).
5. **The spec's kill criterion is stale, and its replacement depends on the worker decision.** The spec said "loop working by Nov 11 18:00 PST", which is 07:30 IST today, one hour after we start. The loop is the same in every case: on a laptop, crawl → AI proposal → approve → one real sandbox top-up → paid Claude Desktop call. The time depends on workers:
   - **8 workers: kill checkpoint at 16:00 IST** (2:30 PST). The loop is projected green at ~15:45, which leaves 15 minutes of slack.
   - **6 workers: kill checkpoint at ~16:45 IST** (3:15 PST). The loop is projected green at ~16:30.
   - **4 workers (the default on line 7): the loop is projected green at ~17:30.** A 16:00 checkpoint would fail by design, and a 17:30 one leaves 30 minutes before the freeze. Neither is a useful go/no-go. If the human stays at 4, take the go/no-go **now, at dispatch time**: the projection already shows no screens, no gate on the demo site and no seed by 18:00. Either commit to the later freeze in point 3 (the checkpoint then moves to ~17:30 as a pure loop check), or don't start Spigot.
   - Either way, if the loop isn't green at its checkpoint, stopping Spigot is the human's call (the spec says to fold effort back into Holdfast).
6. **Render deploy is after the freeze.** SP-040 lands the blueprint and smoke script before 18:00 so the deploy is one click; any surprise there comes out of the video window. Render Workflows (SP-041) is the riskiest P0 ticket and the in-process mode stays the demo default unless it is green.
7. **Human-in-the-loop steps** (block workers if not ready): sandbox **publisher** business account (for payouts, see PayPal facts), sandbox Personal buyer for wallet approval (SP-003 S7b, SP-018, SP-032), `ANTHROPIC_API_KEY` for the one live schema-agent run (SP-012a), AG Grid licence key (SP-024), Render account (SP-040/041, after freeze), APIMatic account (SP-056), Log in with PayPal enabled on the sandbox app (SP-058), Claude Desktop on the recording machine (SP-039, SP-046).

## PayPal facts that shape these tickets

From Holdfast's `spikes/s7-results.md` (same sandbox app and US business account):
- **Payouts need a separate sandbox brand/publisher business account.** Paying the merchant's own account returns batch DENIED / item FAILED `SELF_PAY_NOT_ALLOWED`. The demo publisher's `payout_email` is that separate account (`DEMO_PUBLISHER_PAYOUT_EMAIL`): SP-003, SP-020, SP-035.
- **Large payouts need a funded balance.** Payouts of $2,500 and up returned `422 INSUFFICIENT_FUNDS` (no batch created) even after ~$106k of card captures; captured money did not become payable within ~1 h. $1,000 to the separate account succeeded (batch SUCCESS at 29 s). Spigot's demo payout is small (~$400 from the SIM week), but SP-020 treats `INSUFFICIENT_FUNDS` as a definite 4xx: reverse to payable, batch FAILED, alert, new batch next run. If it happens on camera day, pre-fund the merchant sandbox account.
- Raw-card order create is **not** replay-safe (same `PayPal-Request-Id` → `422 TRANSACTION_REFUSED`); `vault_id` and no-source orders replay cleanly. Our `topups` row is the dedupe for SIM card top-ups (SP-001b, SP-018, SP-035).
- Capture and void replays with the same request id return the original result. A mocked `INSTRUMENT_DECLINED` on capture came back as **403 with an empty body**; classify by status, not issue code (SP-001b).
- Wallet vault and wallet MIT worked with AUTHORIZE; Spigot needs them with CAPTURE, which SP-003 (S7/S8) proves first.
- Working sandbox cards at concurrency 20: Visa 4111…1111, Visa 4012…1881, MC 5555…4444, Amex 3714…8431, Discover 6011…1117. **Don't use 5105…5100.**
- `GET /v1/reporting/balances` returns 403 for this app, so we can't read the merchant balance in health checks.
- Use the **US** sandbox business account; the India one fails cards and Payouts.

## All tickets

Tag: **S** = spine (kill-criterion loop and money out, dispatched first) · **D** = on screen in the video · – = other. "Proj. merge" is the simulated merge time in IST (Nov 12 unless "+1d") with 4 or 8 workers.

| ID | Title | Pri | Tag | Wave | Est (h) | Proj. merge @4 | Proj. merge @8 | Depends on |
|---|---|---|---|---|---|---|---|---|
| [SP-001a](SP-001a-repo-skeleton-ci.md) | Repo skeleton, tooling, CI (check/db/security), gitleaks, config, shared money helpers | P0 | S | 1 | 1.5 | 08:15 | 08:15 | none |
| [SP-001b](SP-001b-paypal-client-fake.md) | PayPal client + FakePayPal stub ported from Holdfast (CAPTURE top-ups, refunds, payouts, webhook verify) | P0 | S | 2 | 2 | 11:45 | 10:30 | SP-001a |
| [SP-002](SP-002-postgres-schema.md) | Postgres schema, migrations and db helpers (tx, transition, advisory locks, job runner) | P0 | S | 1 | 2 | 08:45 | 08:45 | none |
| [SP-003](SP-003-paypal-spike-pack.md) | PayPal spike pack S7–S10 (+S11 script) for Spigot's CAPTURE / vault / refund / payout calls | P0 | – | 1 | 1.5 | 09:00 | 08:15 | none |
| [SP-004a](SP-004a-demo-site.md) | Demo site "Bluebonnet Rentals" (Express + EJS, seeded 2,341 / 88 / 40, JSON-LD, sitemap, ETag) | P0 | D | 1 | 1.5 | 08:15 | 08:15 | none |
| [SP-004b](SP-004b-demo-mutate.md) | `demo:mutate` script (prices, leased, new; reproducible seed) | P0 | D | 2 | 1 | 01:00 +1d | 09:30 | SP-004a |
| [SP-005](SP-005-ledger-core.md) | Ledger core: `ledger.post`, accounts, balance check, ledger-check function | P0 | S | 2 | 1.5 | 10:45 | 10:30 | SP-001a, SP-002 |
| [SP-006a](SP-006a-gate-classify.md) | Gate core: pure `classify`, UA table, 402 body builder (JSON + D04 HTML), bench | P0 | D | 2 | 1 | 17:30 | 09:30 | SP-001a |
| [SP-006b](SP-006b-gate-middleware.md) | Gate middleware: fail-open, policy refresher, hit flusher, SIM flag; installed on the demo site | P0 | D | 3 | 1.5 | 20:45 | 11:45 | SP-006a, SP-004a |
| [SP-007a](SP-007a-auth-core.md) | Auth core: publisher + buyer sessions, error envelope, CSRF, rate limits, audit + tenancy helpers, log redaction | P0 | S | 2 | 1.5 | 11:45 | 11:15 | SP-001a, SP-002 |
| [SP-007b](SP-007b-buyer-api-keys.md) | Buyer API keys: create / revoke, Bearer auth, scopes | P0 | S | 3 | 1 | 15:15 | 12:30 | SP-007a |
| [SP-008a](SP-008a-sites-connect-verify.md) | Sites: connect, verify, gate + crawl keys | P0 | D | 3 | 1 | 16:30 | 12:30 | SP-007a |
| [SP-008b](SP-008b-gate-endpoints.md) | Gate endpoints: `GET /api/gate/policy`, `POST /api/gate/hits`, gate-status | P0 | D | 4 | 1 | 17:45 | 13:45 | SP-008a |
| [SP-009a](SP-009a-crawler-core.md) | Crawler core: sitemap, pages, `fetchPage` (ETag, snapshots), in-process queue, SSRF guard | P0 | S | 2 | 2 | 11:00 | 11:00 | SP-001a, SP-002 |
| [SP-009b](SP-009b-crawl-api.md) | Crawl API: `POST /crawl`, runs list, progress SSE, verify → discovery crawl | P0 | D | 4 | 1 | 22:00 | 13:45 | SP-009a, SP-008a |
| [SP-010](SP-010-template-clustering.md) | Template clustering + cleaned DOM outline (pure) | P0 | S | 2 | 1 | 09:30 | 09:30 | SP-001a |
| [SP-011](SP-011-extractor-dsl.md) | Extractor DSL `extract.ts`, transforms whitelist, canonical JSON + hash (pure) | P0 | S | 2 | 1.5 | 10:00 | 10:00 | SP-001a |
| [SP-012a](SP-012a-schema-agent-propose.md) | Schema agent: Claude `propose_schema`, PII / rights guard, persist proposals, crawl hook | P0 | S | 3 | 2 | 14:00 | 13:15 | SP-010, SP-011, SP-009a, SP-002 |
| [SP-012b](SP-012b-schema-selfcheck-repair.md) | Schema agent self-check + repair, injection fixture, JSON-LD-only fallback | P0 | – | 4 | 1.5 | 03:30 +1d | 18:30 | SP-012a |
| [SP-013](SP-013-records-versions-watermark.md) | Records upsert, versions, JSON Patch, watermark (`extractPage`, `extractTemplate`, `publishWatermark`) | P0 | S | 3 | 2 | 14:00 | 12:15 | SP-011, SP-002 |
| [SP-014](SP-014-approve-api.md) | Proposals / dataset PATCH / approve / unpublish API (filter indexes, re-extract, policy bump) | P0 | S | 4 | 1.5 | 16:15 | 15:00 | SP-012a, SP-013, SP-007a, SP-009a |
| [SP-015](SP-015-records-query-changes.md) | Records query (filters → SQL, keyset cursor) + changes reader (watermark, hidden-field stripping) | P0 | S | 2 | 1.5 | 12:30 | 11:15 | SP-001a, SP-002 |
| [SP-016](SP-016-metering-charge.md) | Metering: `chargeAndRecord`, client idempotency, charge-on-2xx, commission split | P0 | S | 3 | 1.5 | 12:45 | 12:15 | SP-005 |
| [SP-017a](SP-017a-paid-read-service.md) | Paid-read service layer: `paidRead`, `quote`, catalog, 402 contract builder | P0 | S | 4 | 1.5 | 15:45 | 14:00 | SP-015, SP-016 |
| [SP-017b](SP-017b-v1-routes.md) | Buyer data API `/v1` routes, Spigot-* headers, max price, rate limit | P0 | D | 5 | 1.5 | 21:00 | 15:45 | SP-017a, SP-007b |
| [SP-018](SP-018-topup-core.md) | Top-up core: wallet order, capture, `creditTopup`, card vault, return URL | P0 | S | 3 | 2 | 14:45 | 13:30 | SP-001b, SP-005, SP-007a |
| [SP-019](SP-019-jobs-poller-sweeps.md) | Jobs: top-up poller, ABANDONED sweep, response-body purge, change retention | P0 | – | 4 | 1 | 06:00 +1d | 19:30 | SP-018 |
| [SP-020](SP-020-payout-run.md) | `payoutRun`: batch build, PAYOUT_SENT, `pp.payout`, crash-resume, INSUFFICIENT_FUNDS | P0 | S | 3 | 1.5 | 14:30 | 12:15 | SP-001b, SP-005 |
| [SP-021](SP-021-payout-status-api.md) | Payout status poll + item reconcile, payouts API, "Run payout now" endpoint | P0 | S | 4 | 1.5 | 16:30 | 14:00 | SP-020, SP-007a |
| [SP-022a](SP-022a-mcp-server-read-tools.md) | MCP server `/mcp`: auth, rate limit, list / describe / quote / search_records / get_changes | P0 | S | 5 | 1.5 | 17:30 | 15:45 | SP-017a, SP-007b |
| [SP-022b](SP-022b-mcp-balance-topup.md) | MCP `get_balance` + `top_up` (approval link) | P0 | – | 6 | 1 | 04:15 +1d | 18:15 | SP-022a, SP-018 |
| [SP-023](SP-023-openapi.md) | OpenAPI 3.1 from Zod, served at `/v1/openapi.yaml` | P0 | – | 6 | 1 | 04:45 +1d | 18:15 | SP-017b |
| [SP-024](SP-024-web-scaffold.md) | Web scaffold: React + Vite + Tailwind, AG Grid / AG Charts, tokens, shell, shared components | P0 | D | 2 | 1.5 | 18:15 | 10:00 | SP-001a |
| [SP-025](SP-025-publisher-sse.md) | Publisher SSE event bus (`/api/publishers/me/events`) | P0 | D | 3 | 1 | 18:45 | 13:00 | SP-007a |
| [SP-026](SP-026-w02-w03-onboarding.md) | W02 sign up + connect and W03 install + verify + first crawl | P0 | – | 5 | 1.5 | 03:00 +1d | 18:30 | SP-024, SP-008b, SP-009b |
| [SP-027a](SP-027a-bots-api.md) | Bots API: `GET /api/sites/:id/bots` (totals, byBot, series, estimates) | P0 | D | 5 | 1 | 19:00 | 15:00 | SP-008b |
| [SP-027b](SP-027b-w04-bot-report.md) | W04 Overview / bot report (AG Grid + AG Charts, live) | P0 | D | 6 | 1.5 | 00:00 +1d | 17:00 | SP-024, SP-027a, SP-025 |
| [SP-028](SP-028-w05-proposals.md) | W05 Record types found (hero) | P0 | D | 5 | 1.5 | 23:45 | 16:45 | SP-024, SP-014 |
| [SP-029](SP-029-w06-dataset-editor.md) | W06 Dataset editor + publish (schema-driven AG Grid) | P0 | D | 5 | 2 | 22:15 | 17:15 | SP-024, SP-014 |
| [SP-030a](SP-030a-earnings-ledger-usage-api.md) | Earnings, ledger and buyer-usage read APIs | P0 | D | 4 | 1 | 20:00 | 13:30 | SP-016, SP-007a |
| [SP-030b](SP-030b-w08-earnings.md) | W08 Earnings (KPIs, AG Charts, grouped AG Grid, ledger tab) | P0 | D | 5 | 1.5 | 00:30 +1d | 15:30 | SP-024, SP-030a, SP-025 |
| [SP-031](SP-031-w09-payouts.md) | W09 Payouts (master/detail grid, Run payout now) | P0 | D | 5 | 1.5 | 22:45 | 16:30 | SP-024, SP-021 |
| [SP-032](SP-032-w11-buyer-portal.md) | W11 Buyer portal: balance, Top up with PayPal (JS SDK v6), keys, Claude Desktop config | P0 | D | 4 | 2 | 22:15 | 15:45 | SP-024, SP-018, SP-007b |
| [SP-033](SP-033-w13-catalog-page.md) | W13 public catalog page `/c/:site` + terms | P0 | D | 5 | 1 | 02:30 +1d | 17:45 | SP-017a |
| [SP-034](SP-034-w16-settings.md) | W16 Settings (account, payout email, gate policy, key rotation) | P0 | – | 5 | 1 | 06:45 +1d | 19:30 | SP-024, SP-008b |
| [SP-035](SP-035-seed-demo.md) | `seed:demo`: publisher, site, Acme + 20 SIM buyers, SIM sandbox top-ups | P0 | D | 4 | 1.5 | 20:00 | 15:15 | SP-018, SP-008a, SP-007b |
| [SP-036](SP-036-sim-buyers.md) | `sim:buyers` (backdated week + `--live`) | P0 | D | 6 | 1 | 01:15 +1d | 17:00 | SP-035, SP-017b, SP-014 |
| [SP-037](SP-037-sim-bots.md) | `sim:bots` (real HTTP with bot UAs, SIM-flagged) | P0 | D | 5 | 1 | 01:15 +1d | 16:45 | SP-006b, SP-008b |
| [SP-038](SP-038-demo-reset-payout.md) | `demo:reset` + `demo:payout` | P0 | D | 5 | 1 | 01:45 +1d | 17:00 | SP-035, SP-021 |
| [SP-039](SP-039-buyer-agent-demo-kit.md) | Buyer agent demo kit: `scraper-demo.py`, Claude Desktop config, prompt card, dry-run checklist | P0 | D | 6 | 1 | 02:15 +1d | 17:00 | SP-022a, SP-006b |
| [SP-040](SP-040-render-deploy-config.md) | Render deploy config: `render.yaml`, paid Postgres, env, migrate on deploy, demo site service | P0 | D | 2 | 1.5 | 19:15 | 11:15 | SP-001a, SP-002, SP-004a |
| [SP-041](SP-041-render-workflows-adapter.md) | Render Workflows adapter (`WORKFLOWS_MODE=workflows`) for crawl, extract and payout tasks | P0 | – | 5 | 2 | 06:00 +1d | 19:15 | SP-009b, SP-014, SP-020, SP-040 |
| [SP-042](SP-042-security-tests.md) | Security tests: cross-tenant matrix, hidden-field sweep, revoked keys, SSRF, checklist | P0 | – | 6 | 1.5 | 06:00 +1d | 19:30 | SP-017b, SP-022a, SP-014 |
| [SP-043](SP-043-admin-ops-endpoints.md) | Admin ops endpoints: audit search, ledger check, health | P0 | – | 3 | 1 | 03:45 +1d | 18:15 | SP-005, SP-007a |
| [SP-044](SP-044-readme-license.md) | README + LICENSE (MIT) | P0 | D | 3 | 1.5 | 00:00 +1d | 14:45 | SP-040 |
| [SP-045](SP-045-devpost-draft.md) | Devpost draft | P0 | – | 1 | 0.5 | 07:15 | 07:15 | none |
| [SP-046](SP-046-video-devpost-submission.md) | Demo video + Devpost submission (after code freeze) | P0 | D | 7 | 3 | 05:30 +1d | 20:30 | SP-039, SP-038, SP-044, SP-045, SP-036, SP-037, SP-027b, SP-028, SP-029, SP-030b, SP-031, SP-032 |
| [SP-047a](SP-047a-auto-topup-core.md) | Auto top-up core: vault MIT inside `chargeAndRecord`, monthly cap, one in flight | P1 | – | 4 | 1.5 | 07:45 +1d | 20:15 | SP-016, SP-018 |
| [SP-047b](SP-047b-auto-topup-settings-ui.md) | Auto top-up settings API, W11 card, MCP `top_up` from vault, `demo:decline` | P1 | – | 7 | 1.5 | 13:45 +1d | 23:30 | SP-047a, SP-032, SP-022b |
| [SP-048a](SP-048a-claims-core.md) | Claims core: `/v1/claims`, MCP `report_bad_record`, deterministic checks, CREDIT | P1 | – | 6 | 2 | 08:15 +1d | 20:30 | SP-017b, SP-009a, SP-022a |
| [SP-048b](SP-048b-claims-triage-agent.md) | Claims triage agent (Claude recommendation) + publisher decide endpoint | P1 | – | 7 | 1.5 | 12:00 +1d | 22:15 | SP-048a |
| [SP-049](SP-049-refund-unused-balance.md) | Refund unused balance via PayPal Refunds | P1 | – | 4 | 1.5 | 07:45 +1d | 20:15 | SP-018 |
| [SP-050](SP-050-w12-usage-claims-refund.md) | W12 Buyer usage & claims (refund button) + publisher claims tab | P1 | – | 7 | 2 | 10:30 +1d | 22:45 | SP-048a, SP-049, SP-032, SP-030b |
| [SP-051](SP-051-gate-reverse-dns.md) | Gate reverse-DNS verification for search crawlers (async, cached) | P1 | – | 4 | 1 | 16:15 +1d | 00:45 +1d | SP-006b |
| [SP-052a](SP-052a-drift-detection.md) | Drift detection, LIVE_STALE, `DEMO_LAYOUT=v2` | P1 | – | 5 | 1.5 | 08:30 +1d | 21:00 | SP-013, SP-014, SP-004b |
| [SP-052b](SP-052b-reinference.md) | Re-inference (`/reinfer`), approve v(n+1), W06 stale banner | P1 | – | 6 | 1.5 | 13:30 +1d | 23:00 | SP-052a, SP-012b, SP-029 |
| [SP-053](SP-053-w07-records-browser.md) | W07 Records browser (server-side rows, version history) | P1 | – | 3 | 2 | 10:00 +1d | 21:45 | SP-024, SP-015 |
| [SP-054](SP-054-w10-crawls-health.md) | W10 Crawls & health | P1 | – | 5 | 1.5 | 10:15 +1d | 21:15 | SP-024, SP-009b |
| [SP-055](SP-055-cms-ping.md) | CMS ping `POST /api/sites/:id/ping` + `demo:mutate --ping` | P1 | – | 5 | 1 | 15:00 +1d | 00:00 +1d | SP-009b, SP-004b |
| [SP-056](SP-056-apimatic-sdk.md) | APIMatic TypeScript + Python SDK from `openapi.yaml` | P1 | – | 7 | 1.5 | 11:45 +1d | 22:00 | SP-023, SP-040 |
| [SP-057](SP-057-w01-landing.md) | W01 Landing page | P1 | – | 3 | 1.5 | 14:00 +1d | 23:45 | SP-024 |
| [SP-058](SP-058-login-with-paypal.md) | Log in with PayPal for publishers | P1 | – | 6 | 2 | 10:00 +1d | 21:45 | SP-007a, SP-026 |
| [SP-059](SP-059-paypal-webhooks.md) | PayPal webhooks: verify, dedupe, handlers; spike S11 | P1 | – | 5 | 1.5 | 15:15 +1d | 23:45 | SP-018, SP-021, SP-040 |
| [SP-060](SP-060-weekly-payout-cron.md) | Weekly payout cron + failed-item retry | P1 | – | 5 | 1 | 14:45 +1d | 23:30 | SP-021 |
| [SP-061](SP-061-scheduled-recrawl-nightly-check.md) | Scheduled re-crawl (15 min) + nightly ledger check | P1 | – | 5 | 1 | 16:00 +1d | 00:15 +1d | SP-009b, SP-043 |
| [SP-062](SP-062-w14-admin-audit.md) | W14 Admin / audit screen | P1 | – | 4 | 1.5 | 11:45 +1d | 22:00 | SP-043, SP-024 |
| [SP-063](SP-063-card-fields-topup.md) | Card-fields top-up (JS SDK v6 card fields, vaulted) | P1 | – | 5 | 1.5 | 13:30 +1d | 23:30 | SP-032 |
| [SP-064](SP-064-playwright-render.md) | Playwright render for JS-heavy templates | P1 | – | 3 | 1.5 | 12:15 +1d | 22:45 | SP-009a |
| [SP-065](SP-065-dom-fingerprint-clustering.md) | DOM-fingerprint cluster confirmation | P1 | – | 3 | 1 | 15:15 +1d | 00:00 +1d | SP-010 |

## Dependency graph

P0 (spine in amber). An arrow means "must merge before".

```mermaid
flowchart LR
  classDef spine fill:#fde68a,stroke:#b45309
  classDef p1 fill:#e5e7eb,stroke:#6b7280,color:#374151
  n001a["SP-001a"] :::spine
  n001b["SP-001b"] :::spine
  n002["SP-002"] :::spine
  n003["SP-003"]
  n004a["SP-004a"]
  n004b["SP-004b"]
  n005["SP-005"] :::spine
  n006a["SP-006a"]
  n006b["SP-006b"]
  n007a["SP-007a"] :::spine
  n007b["SP-007b"] :::spine
  n008a["SP-008a"]
  n008b["SP-008b"]
  n009a["SP-009a"] :::spine
  n009b["SP-009b"]
  n010["SP-010"] :::spine
  n011["SP-011"] :::spine
  n012a["SP-012a"] :::spine
  n012b["SP-012b"]
  n013["SP-013"] :::spine
  n014["SP-014"] :::spine
  n015["SP-015"] :::spine
  n016["SP-016"] :::spine
  n017a["SP-017a"] :::spine
  n017b["SP-017b"]
  n018["SP-018"] :::spine
  n019["SP-019"]
  n020["SP-020"] :::spine
  n021["SP-021"] :::spine
  n022a["SP-022a"] :::spine
  n022b["SP-022b"]
  n023["SP-023"]
  n024["SP-024"]
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
  n039["SP-039"]
  n040["SP-040"]
  n041["SP-041"]
  n042["SP-042"]
  n043["SP-043"]
  n044["SP-044"]
  n045["SP-045"]
  n046["SP-046"]
  n001a --> n001b
  n004a --> n004b
  n001a --> n005
  n002 --> n005
  n001a --> n006a
  n006a --> n006b
  n004a --> n006b
  n001a --> n007a
  n002 --> n007a
  n007a --> n007b
  n007a --> n008a
  n008a --> n008b
  n001a --> n009a
  n002 --> n009a
  n009a --> n009b
  n008a --> n009b
  n001a --> n010
  n001a --> n011
  n010 --> n012a
  n011 --> n012a
  n009a --> n012a
  n002 --> n012a
  n012a --> n012b
  n011 --> n013
  n002 --> n013
  n012a --> n014
  n013 --> n014
  n007a --> n014
  n009a --> n014
  n001a --> n015
  n002 --> n015
  n005 --> n016
  n015 --> n017a
  n016 --> n017a
  n017a --> n017b
  n007b --> n017b
  n001b --> n018
  n005 --> n018
  n007a --> n018
  n018 --> n019
  n001b --> n020
  n005 --> n020
  n020 --> n021
  n007a --> n021
  n017a --> n022a
  n007b --> n022a
  n022a --> n022b
  n018 --> n022b
  n017b --> n023
  n001a --> n024
  n007a --> n025
  n024 --> n026
  n008b --> n026
  n009b --> n026
  n008b --> n027a
  n024 --> n027b
  n027a --> n027b
  n025 --> n027b
  n024 --> n028
  n014 --> n028
  n024 --> n029
  n014 --> n029
  n016 --> n030a
  n007a --> n030a
  n024 --> n030b
  n030a --> n030b
  n025 --> n030b
  n024 --> n031
  n021 --> n031
  n024 --> n032
  n018 --> n032
  n007b --> n032
  n017a --> n033
  n024 --> n034
  n008b --> n034
  n018 --> n035
  n008a --> n035
  n007b --> n035
  n035 --> n036
  n017b --> n036
  n014 --> n036
  n006b --> n037
  n008b --> n037
  n035 --> n038
  n021 --> n038
  n022a --> n039
  n006b --> n039
  n001a --> n040
  n002 --> n040
  n004a --> n040
  n009b --> n041
  n014 --> n041
  n020 --> n041
  n040 --> n041
  n017b --> n042
  n022a --> n042
  n014 --> n042
  n005 --> n043
  n007a --> n043
  n040 --> n044
  n039 --> n046
  n038 --> n046
  n044 --> n046
  n045 --> n046
  n036 --> n046
  n037 --> n046
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
  n004b["SP-004b"]
  n006b["SP-006b"]
  n007a["SP-007a"] :::spine
  n009a["SP-009a"] :::spine
  n009b["SP-009b"]
  n010["SP-010"] :::spine
  n012b["SP-012b"]
  n013["SP-013"] :::spine
  n014["SP-014"] :::spine
  n015["SP-015"] :::spine
  n016["SP-016"] :::spine
  n017b["SP-017b"]
  n018["SP-018"] :::spine
  n021["SP-021"] :::spine
  n022a["SP-022a"] :::spine
  n022b["SP-022b"]
  n023["SP-023"]
  n024["SP-024"]
  n026["SP-026"]
  n029["SP-029"]
  n030b["SP-030b"]
  n032["SP-032"]
  n040["SP-040"]
  n043["SP-043"]
  n047a["SP-047a"] :::p1
  n047b["SP-047b"] :::p1
  n048a["SP-048a"] :::p1
  n048b["SP-048b"] :::p1
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
  n004a --> n004b
  n006a --> n006b
  n004a --> n006b
  n001a --> n007a
  n002 --> n007a
  n001a --> n009a
  n002 --> n009a
  n009a --> n009b
  n008a --> n009b
  n001a --> n010
  n012a --> n012b
  n011 --> n013
  n002 --> n013
  n012a --> n014
  n013 --> n014
  n007a --> n014
  n009a --> n014
  n001a --> n015
  n002 --> n015
  n005 --> n016
  n017a --> n017b
  n007b --> n017b
  n001b --> n018
  n005 --> n018
  n007a --> n018
  n020 --> n021
  n007a --> n021
  n017a --> n022a
  n007b --> n022a
  n022a --> n022b
  n018 --> n022b
  n017b --> n023
  n001a --> n024
  n024 --> n026
  n008b --> n026
  n009b --> n026
  n024 --> n029
  n014 --> n029
  n024 --> n030b
  n030a --> n030b
  n025 --> n030b
  n024 --> n032
  n018 --> n032
  n007b --> n032
  n001a --> n040
  n002 --> n040
  n004a --> n040
  n005 --> n043
  n007a --> n043
  n016 --> n047a
  n018 --> n047a
  n047a --> n047b
  n032 --> n047b
  n022b --> n047b
  n017b --> n048a
  n009a --> n048a
  n022a --> n048a
  n048a --> n048b
  n018 --> n049
  n048a --> n050
  n049 --> n050
  n032 --> n050
  n030b --> n050
  n006b --> n051
  n013 --> n052a
  n014 --> n052a
  n004b --> n052a
  n052a --> n052b
  n012b --> n052b
  n029 --> n052b
  n024 --> n053
  n015 --> n053
  n024 --> n054
  n009b --> n054
  n009b --> n055
  n004b --> n055
  n023 --> n056
  n040 --> n056
  n024 --> n057
  n007a --> n058
  n026 --> n058
  n018 --> n059
  n021 --> n059
  n040 --> n059
  n021 --> n060
  n009b --> n061
  n043 --> n061
  n043 --> n062
  n024 --> n062
  n032 --> n063
  n009a --> n064
  n010 --> n065
```

## Critical path

- **Longest P0 code chain (11 h incl. review):** SP-002 (2) → SP-005 (1.5) → SP-016 (1.5) → SP-017a (1.5) → SP-017b (1.5) → SP-042 (1.5). The schema → ledger → metering → paid-read chain sets the floor: even with unlimited workers, P0 code can't finish before ~17:30 IST. Keep these tickets on the fastest workers and review them first.
- **Demo-critical chain (10.5 h):** SP-002 (2) → SP-005 (1.5) → SP-016 (1.5) → SP-017a (1.5) → SP-022a (1.5) → SP-039 (1). Ends with SP-039's local Claude Desktop check (the tools listed and a `quote` answered) and the written dry-run checklist. The end-to-end dry run itself is SP-046, which can start only once the video's screens and scripts have merged (SP-027b, SP-028, SP-029, SP-030b, SP-031, SP-032, SP-036, SP-037, SP-038); see its projected time in the ticket table.
- **AI chain (parallel, ~9.5 h):** SP-002 (2) → SP-009a crawler (2) → SP-012a schema agent (2) → SP-014 approve (1.5) → SP-029 W06 (2).
- **Spine set (dispatch first):** SP-001a, SP-001b, SP-002, SP-005, SP-007a, SP-007b, SP-009a, SP-010, SP-011, SP-012a, SP-013, SP-014, SP-015, SP-016, SP-017a, SP-018, SP-020, SP-021, SP-022a.

## Wave plan

A wave is every ticket whose dependencies are all in earlier waves. With 4–8 workers a wave takes longer than one ticket; dispatch inside a wave follows the order above, and a worker that frees up takes the next ready ticket from any wave. Targets are the projected time the wave's last P0 ticket merges (Wave 7 is SP-046, the human-led video and submission after the freeze; its projection only reflects when its inputs are ready).

| Wave | P0 tickets | P1 tickets (only when no P0 is ready) | P0 worker-h | Last P0 merge @8 | Last P0 merge @4 |
|---|---|---|---|---|---|
| 1 | SP-001a, SP-002, SP-003, SP-004a, SP-045 | – | 7 | 08:45 | 09:00 |
| 2 | SP-001b, SP-004b, SP-005, SP-006a, SP-007a, SP-009a, SP-010, SP-011, SP-015, SP-024, SP-040 | – | 16 | 11:15 | 01:00 +1d |
| 3 | SP-006b, SP-007b, SP-008a, SP-012a, SP-013, SP-016, SP-018, SP-020, SP-025, SP-043, SP-044 | SP-053, SP-057, SP-064, SP-065 | 16 | 18:15 | 03:45 +1d |
| 4 | SP-008b, SP-009b, SP-012b, SP-014, SP-017a, SP-019, SP-021, SP-030a, SP-032, SP-035 | SP-047a, SP-049, SP-051, SP-062 | 13.5 | 19:30 | 06:00 +1d |
| 5 | SP-017b, SP-022a, SP-026, SP-027a, SP-028, SP-029, SP-030b, SP-031, SP-033, SP-034, SP-037, SP-038, SP-041 | SP-052a, SP-054, SP-055, SP-059, SP-060, SP-061, SP-063 | 18 | 19:30 | 06:45 +1d |
| 6 | SP-022b, SP-023, SP-027b, SP-036, SP-039, SP-042 | SP-048a, SP-052b, SP-058 | 7 | 19:30 | 06:00 +1d |
| 7 | SP-046 | SP-047b, SP-048b, SP-050, SP-056 | 3 | 20:30 | 05:30 +1d |

Rules:
- **Wave 1 runs SP-001a, SP-002, SP-003, SP-004a (and SP-045) in parallel.** SP-002 codes against the agreed layout (`db/migrations`, `npm run migrate`, `npm run test:db`) and rebases on SP-001a before merging. SP-004a is its own workspace. **Schema freeze at SP-002's merge (target ~08:45 IST)**; later changes are new migrations reviewed against open tickets.
- **Hooks instead of hard links.** The crawler exposes `onPageChanged`, `onRunFinished` and `onDiscoveryDone` (SP-009a); the schema agent (SP-012a) and extraction wiring (SP-014) register on them, so the crawler never waits for the AI work.
- **UI tickets may start in fixture mode.** SP-024 ships `VITE_FIXTURES=1` with JSON fixtures per api.md endpoint; a screen ticket still lists its API ticket as a dependency, but an idle worker may start on fixtures and must verify against the merged API before its PR merges.
- **Money tests run on FakePayPal** (`PAYPAL_MODE=stub`, SP-001b). Race and idempotency tests are acceptance criteria of the ticket that creates the race: SP-005, SP-016, SP-018, SP-019, SP-020, SP-021, SP-022a/b, SP-035, SP-047a, SP-048a, SP-049, SP-059, SP-063. Each adds its test path as a line in the CI `db` job, as Holdfast does.
- **Background jobs** run in-process under Postgres advisory locks (`runEvery`, SP-002). Render cron is optional (SP-060, SP-061).
- **One writer per piece of state**, as the spec requires: crawler → snapshots (SP-009a), extractor → records (SP-013), ledger → money (SP-005). Reviewers reject any other writer.

## Checkpoints (IST, with PST)

| Checkpoint | IST | PST | Gate |
|---|---|---|---|
| Start | 06:30 | 17:00 Nov 11 | Wave 1 dispatched; human sets up the publisher sandbox account and `.env`. |
| Schema freeze | ~08:45 | 19:15 | SP-002 merged. |
| CP1 | ~11:00 | 21:30 | SP-001b PayPal client + fake, SP-005 ledger, SP-009a crawler, SP-007a auth merged; SP-003 S7a/S7b/S8 results in. |
| **Kill checkpoint** | **16:00** at 8 workers · ~16:45 at 6 · ~17:30 at 4 (see time budget point 5) | **02:30 Nov 12** · ~03:15 · ~04:00 | Loop green locally with no hand-edited rows: crawl demo site → AI proposal → approve → ≥ 2,000 records → one real sandbox top-up → Claude Desktop `search_records` charged exactly. At 4 workers the real go/no-go is taken at dispatch (point 5); the 17:30 check only confirms the loop. |
| Code freeze | **18:00** | 04:30 | Merge what is green; open PRs that aren't green wait. |
| Deploy | 18:00–19:30 | 04:30–06:00 | SP-040 blueprint on Render, migrate, seed, smoke. Auto-deploy off. |
| Record | 19:30–21:30 | 06:00–08:00 | Two dry runs on Render, then record (SP-046). |
| Publish | 21:30–23:00 | 08:00–09:30 | YouTube public, README final (URLs, which modes ran), Devpost filled (SP-045 draft). |
| **Submit** | **23:30** | 10:00 | Devpost submitted; no edits afterwards. |

## Circuit breakers

None of these removes a ticket; they change what the demo shows.
- **SP-003 S7b wallet fails:** card-fields top-up (SP-063) becomes the W11 path when it lands; until then the demo top-up is recorded with whatever passed, and the README says so.
- **S8 vault MIT fails:** auto top-up (SP-047a/b) returns an approval link instead of charging the vault.
- **S9 refund fails:** claims stay as balance credits; SP-049 is parked.
- **Claude API down or slow:** `SCHEMA_AGENT_MODE=recorded` replays the last real proposal, labelled "replayed proposal" (SP-012a); JSON-LD-only fallback (SP-012b).
- **Render Workflows misbehaves:** `WORKFLOWS_MODE=inproc` stays the default (SP-041); README states which ran.
- **Payout `INSUFFICIENT_FUNDS`:** lower the demo threshold or pre-fund the merchant sandbox account (SP-020).

## Spec gaps and decisions taken in these tickets

| Topic | Decision | Ticket |
|---|---|---|
| Spec layout puts task code in `apps/api` but Workflows needs it too | Task functions stay in `apps/api/src/**`, exported as `@spigot/api/tasks`; `apps/workflows` is a thin Render entry. No `packages/core` | SP-001a, SP-041 |
| Kill checkpoint date already passed at start | 16:00 IST at 8 workers, ~16:45 at 6; at 4 workers, go/no-go at dispatch and a ~17:30 loop check | INDEX |
| `/v1` service vs routes | Split so MCP doesn't wait for HTTP routes (cuts the critical path by 1.25 h) | SP-017a, SP-017b |
| Webhooks priority | P1: feature 09 lists webhooks as P1 and pollers cover P0 (api.md) | SP-059 |
| SP-014 asserting the gate's `gatedPaths` would need SP-008b on the spine | SP-014 asserts the `policy_version` bump only; SP-008b asserts `gatedPaths` from LIVE datasets | SP-014, SP-008b |
| Where `sim:buyers` gets a LIVE dataset | Depends on SP-014; runs crawl + approve itself when none is LIVE | SP-036 |
| End-to-end dry run | Executed in SP-046 (which depends on every screen it touches); SP-039 writes the checklist | SP-039, SP-046 |
| Where the demo reset sends a buyer's balance | A `DEMO_RESET` ledger txn into platform revenue; no entry is deleted | SP-038 |
| P1 tables | Created in the first migration so P1 never needs a migration | SP-002 |
| gstack "assignment" (talk to 2 site owners, 2 agent builders) | Not code; quoted in the README only if answers arrive | SP-044 |
