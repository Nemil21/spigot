# Spigot: Build Spec

> Turn your site into a paid API for AI agents. Bots stop scraping your HTML and buy clean, live records instead. PayPal funds the agents and pays you.
>
> Pitch line: **"Scrapers pay Bright Data. Spigot makes them pay you, and they get better data."**

This folder is the build plan for our **second** PayPal AI Hackathon 2026 submission. Each file is meant to be implementable on its own.
- Product background and the adversarial review: [../research/15-gstack-spigot.md](../research/15-gstack-spigot.md) (source of truth for what Spigot is).
- PayPal sandbox proof we reuse: [../../spikes/paypal-spikes.mjs](../../spikes/paypal-spikes.mjs) and [../HOLDFAST.md](../HOLDFAST.md) §6 (S1, S2, S3-local, S4 passed on 2026-11-10).
- Our lead submission is Holdfast ([../spec/](../spec/)). Spigot is a separate, substantially different product with its own owner(s). It must not pull people off Holdfast.

## Index

| File | What's in it |
|---|---|
| [data-model.md](data-model.md) | Postgres tables, the double-entry ledger, state machines, locking and idempotency |
| [api.md](api.md) | Publisher, buyer and gate endpoints; the 402 contract; MCP tools; webhooks; the exact PayPal calls |
| [screens.md](screens.md) | Every web screen (W01–W16) and the demo site pages (D01–D04), with states and interactions |
| [features/01-demo-site.md](features/01-demo-site.md) | "Bluebonnet Rentals", our fictional listings site |
| [features/02-gate-middleware.md](features/02-gate-middleware.md) | `spigot-gate`: classify → pass or 402, fail-open |
| [features/03-site-onboarding-crawl.md](features/03-site-onboarding-crawl.md) | Connect a site, verify it, crawl it on Render Workflows |
| [features/04-ai-schema-extractor.md](features/04-ai-schema-extractor.md) | Claude proposes record types; deterministic extractor; owner approval |
| [features/05-records-changes-feed.md](features/05-records-changes-feed.md) | Records, versions, JSON Patch changes feed |
| [features/06-buyer-api-pricing.md](features/06-buyer-api-pricing.md) | Typed REST endpoints, quotes, 402 for unpaid calls |
| [features/07-ledger-metering.md](features/07-ledger-metering.md) | Double-entry ledger, charge only on 2xx, idempotent charges |
| [features/08-paypal-topup-vault.md](features/08-paypal-topup-vault.md) | Prepaid balance top-up (Orders v2), Vault, auto top-up |
| [features/09-payouts-commission.md](features/09-payouts-commission.md) | Weekly Payouts batches to publishers, minus commission |
| [features/10-claims-refunds.md](features/10-claims-refunds.md) | Junk-data credits and PayPal Refunds of unused balance |
| [features/11-mcp-server-sdk.md](features/11-mcp-server-sdk.md) | MCP server for agents; OpenAPI; APIMatic SDK |
| [features/12-buyer-agent-demo.md](features/12-buyer-agent-demo.md) | Claude Desktop buyer flow and the "dumb scraper gets a 402" shot |
| [features/13-publisher-dashboard.md](features/13-publisher-dashboard.md) | AG Grid dashboard: bots, schema approval, earnings, payouts |
| [features/14-auth-security-ops.md](features/14-auth-security-ops.md) | Auth, API keys, tenancy, prompt injection, audit and ops |
| [features/15-demo-seeding.md](features/15-demo-seeding.md) | Seed data, simulated bots and buyers (labelled SIM) |
| [features/16-landing-and-docs.md](features/16-landing-and-docs.md) | Landing page, public catalog page, README and Devpost copy |

## Glossary

| Term | Meaning |
|---|---|
| **Publisher** | The owner of a site that Spigot turns into an API. Gets paid via PayPal Payouts. |
| **Site** | One origin (e.g. `bluebonnet-rentals.onrender.com`) registered by a publisher. |
| **Gate** | `spigot-gate`, a small middleware the publisher installs at their origin. Classifies each request locally and either passes it or returns HTTP 402. Fails open. |
| **Declared bot** | A bot that says who it is (User-Agent like `GPTBot`, `ClaudeBot`, `python-requests`). Stealth scrapers that pretend to be browsers are **not** stopped, and we never claim they are. |
| **Crawler** | Our own fetcher. Reads the publisher's origin directly with a secret `X-Spigot-Key` header. Only public URLs from the sitemap. No visitor capture, ever. |
| **Snapshot** | The raw HTML of one page at one fetch. Owned by the crawler. |
| **Template** | A group of pages with the same layout (e.g. `/listings/:slug`). One extractor per template. |
| **Record type / dataset** | A typed kind of record found on a site: Listing, Agent, Open House. Has a schema, a price and an API endpoint. |
| **Proposal** | The AI's suggested schema plus extractor for one template ("Listing, 2,341 records"). The owner edits and approves it. |
| **Extractor** | A JSON spec (JSON-LD paths and CSS selectors plus whitelisted transforms). Written by the AI once, then run by plain code with **no per-page AI call**. |
| **Record** | One typed object (one listing). Identified by a stable `record_key`. Has a content hash and a version. |
| **Change** | One add, update or remove of a record, as a JSON Patch (RFC 6902), with a cursor. |
| **Drift** | When an extractor's field null-rates jump (usually after a redesign). Triggers re-inference and owner review (P1). |
| **Buyer** | An AI agent builder (or their agent) with an API key and a prepaid balance. |
| **Balance** | Prepaid money held in our ledger for a buyer. Funded by PayPal top-ups. Stored in **micros** (1 USD = 1,000,000 micros) so we can charge $0.0015 per record. |
| **Top-up** | A PayPal Orders v2 `CAPTURE` payment that adds to a buyer's balance. **Auto top-up** charges a vaulted payment method (merchant-initiated) when the balance drops below a threshold, within the buyer's monthly cap. |
| **Charge** | A ledger debit for a paid API call. Happens **only after a 2xx response is built**. Keyed by `Idempotency-Key`. |
| **Quote** | The price of a call before it runs (`records × unit price`). Free. Also the body of every 402. |
| **Credit** | Money returned to a buyer's balance for a junk record (claim approved). Internal ledger move, no PayPal call. |
| **Refund** | A PayPal Refund of unused balance back to the buyer's original top-up capture (P1). |
| **Commission** | Our cut of each charge (default 20%, `commission_bps=2000`). The rest accrues to the publisher's payable. |
| **Payout** | A PayPal Payouts item to the publisher. Sent in weekly batches, or when payable ≥ $10. |
| **SIM** | Simulated bot traffic, buyers or calls used for demo volume. Always labelled "SIM" in the UI. |

## System overview

```
                     Publisher origin (Bluebonnet Rentals, Express)
                     ┌───────────────────────────────────────────────┐
  human / Googlebot ─┤ spigot-gate: classify(req) ── pass ──> site    │── sitemap.xml, POST /ping (P1)
  GPTBot / scraper  ─┤             (local, <1 ms, fail-open) ── 402 ──┼─> { price, api_url, terms }
                     └───────────────┬───────────────────────────────┘
                     batched hit counts (async, droppable)
                                     ▼
 ┌──────────────────────────────── Render web service: spigot-api (Node/TS, Fastify) ─────────────────────────────┐
 │  /gate/hits   /publisher/*   /v1/* (buyer REST)   /mcp (Streamable HTTP)   /webhooks/paypal   /topups/return   │
 │        │            │                │                   │                       │                             │
 │        ▼            ▼                ▼                   ▼                       ▼                             │
 │   bot_hits    sites, datasets    Query → Quote → Serve → Charge (ledger)   reconcile topups/payouts            │
 │                    │                                     │                                                      │
 │      Schema agent (Claude API): propose schema + extractor from 3–5 samples, self-check, owner approves        │
 └────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────────────┘
                      │ start run                            │
           Render Workflows                                 Postgres (paid): records, record_versions,
           crawlSite → fetchPage ×N → extractPage → publish  ledger_accounts, ledger_entries, payouts, audit
           payoutRun (weekly or "Run now") ──────────────────────┐
                                                                 ▼
                      PayPal REST: Orders v2 (top-up, CAPTURE) · Vault (auto top-up, MIT) · Refunds (P1)
                                   Payouts (batched) · Webhooks (verify + reconcile)
 Buyer: Claude Desktop ──MCP──> /mcp      Python scraper ──HTML──> gate 402 ──> catalog page ──> sign up + top up
```

Rules:
- **Humans never call us.** The gate decides locally and fails open.
- **The crawler owns snapshots, the extractor owns records, the ledger owns money.** One writer per piece of state.
- **AI writes the extractor once; code runs it.** No LLM call per page or per API request.
- **Only the backend calls PayPal.** No LLM ever holds PayPal credentials or calls a money endpoint directly.

## Where PayPal shows up (every money moment)

| Money moment | PayPal API | Visible in demo | Proven? |
|---|---|---|---|
| Buyer funds the agent's balance | Orders v2 `intent: CAPTURE` (PayPal wallet via JS SDK v6 button, or card) | W11 "Top up $20 with PayPal" → sandbox approval → balance ticks up | **New spike S7** (S1 proved Orders + capture with `AUTHORIZE`; `CAPTURE` intent is the simpler variant) |
| Payment method saved for the agent | Vault (`attributes.vault.store_in_vault: ON_SUCCESS`) | W11 "Saved for auto top-up" | **Proven for cards** (S2). PayPal-wallet vault needs **S8** |
| Agent runs low mid-session | Merchant-initiated order from `vault_id` (`stored_credential: MERCHANT, UNSCHEDULED, SUBSEQUENT`) | Claude Desktop keeps going; W11 shows "Auto top-up $20 (PayPal)" row | **Proven for AUTHORIZE holds** (S2). CAPTURE intent with `vault_id` needs **S8** |
| Publisher gets paid | Payouts v1 batch, one item per publisher | W09 "Run payout now" → batch PENDING → SUCCESS; sandbox publisher account shows the money | **Proven** (S4). Item-level statuses and webhooks need **S10** |
| Buyer cashes out unused balance | Refunds `POST /v2/payments/captures/{id}/refund` (partial) | W12 "Refund $7.40 to PayPal" (P1) | **New spike S9** |
| Every PayPal event lands in our books | Webhooks + `verify-webhook-signature` | W14 audit rows with PayPal IDs | **New spike S11** (never tested in Holdfast either) |
| Idempotency on every call | `PayPal-Request-Id` | (invisible; tested) | **Proven** (S3) |
| Production money flow (not built) | Multiparty `platform_fees` (publisher as merchant) | Architecture slide + README | Doc only (Holdfast S6, not run) |

Not used, on purpose:
- **Subscriptions** (flat monthly change-feed plans): P2, README only. No spike.
- **PayPal Agent Toolkit / PayPal MCP server for the buyer agent:** both run on the *merchant's* credentials, and only the payee's app can create an order (noted by `paypal-402`). Giving them to a buyer's agent would hand it our merchant account. The buyer agent tops up through our MCP `top_up` tool instead, and our backend calls Orders v2. We say this plainly in the README.
- **Micropayments per request:** PayPal fees (~$0.49 fixed per capture) make per-call captures uneconomic. That is why there is a prepaid balance and an internal ledger.

## Where AI shows up

| Where | What the AI does | Guardrail |
|---|---|---|
| Schema agent (04) | Clusters templates, reads JSON-LD and 3–5 sample pages, proposes record types and fields, writes the extractor, runs it on 20 samples, repairs it (≤ 2 rounds), flags PII and wire copy | Output is a Zod-validated JSON spec, never code; the owner approves before anything is sold |
| Drift re-inference (04, P1) | Re-proposes an extractor after a redesign | Old version keeps serving, marked `stale_since`, until the owner approves |
| Claims triage (10, P1) | Reads a "junk record" claim plus the record's version history and current page, recommends credit or reject | Auto-credit only for deterministic cases; AI recommendation is shown to the publisher, capped amount |
| Buyer agent (12) | Claude Desktop turns "3-beds under $2k that changed today" into `describe_dataset` → `quote` → `get_changes`/`search_records`, tops up within its cap | Spend caps and auto top-up cap are enforced in code, not in the prompt |

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node 20+ / TypeScript, Fastify, Zod validation (same as Holdfast so code and habits transfer) |
| DB | Postgres (Render **paid** instance; the free one expires in ~30 days and judging runs to Dec 21) |
| Jobs | Render Workflows (crawl fan-out, extraction, payout run); Render cron (weekly payout, nightly sitemap re-check, payout status poll) |
| Fetching | `undici` fetch with `X-Spigot-Key`; `cheerio` for CSS extraction; `jsonpath-plus` for JSON-LD. Playwright rendering is P1 (the demo site is server-rendered) |
| Diff | Canonical JSON → SHA-256 per record; `fast-json-patch` for RFC 6902 patches |
| Frontend | React + Vite, AG Grid Enterprise / AG Charts (licence in `AG_GRID_LICENSE_KEY`), Tailwind |
| Demo site | Separate Render web service: Express + EJS, server-rendered, JSON-LD on listing pages, with `spigot-gate` installed |
| AI | Claude API (latest Claude model, set in `CLAUDE_MODEL`) with tool use / structured output; MCP via `@modelcontextprotocol/sdk` |
| Payments | PayPal REST, direct. Client copied from `spikes/paypal-spikes.mjs` (token cache, `PayPal-Request-Id`, `Prefer: return=representation`). JS SDK v6 on the buyer top-up page |
| Realtime | Server-sent events for the dashboard (hits, earnings, payout status) |
| SDK | OpenAPI 3.1 (`openapi.yaml`, generated from Zod) → APIMatic TypeScript/Python SDK (P1) |
| Build aid | APIMatic PayPal Context Plugin while coding the PayPal path (say so in README and video) |

## Repo layout (proposed)

Separate public repo `spigot` (separate submission, separate LICENSE). Copy the PayPal client from this repo's spikes.

```
apps/
  api/                Fastify: publisher REST, buyer /v1, /mcp, /gate/hits, webhooks
    src/paypal/       client.ts (token cache, request-id; from spikes), orders.ts, payouts.ts, refunds.ts, webhooks.ts
    src/ledger/       ledger.ts (post(txn) with balanced-entry check), accounts.ts
    src/meter/        quote.ts, charge.ts (charge-on-2xx, idempotency store)
    src/records/      query.ts (filters → SQL), changes.ts (cursor)
    src/schema-agent/ propose.ts, repair.ts, prompts/, pii.ts
    src/extract/      run.ts (pure: html + spec → record), transforms.ts (whitelist)
    src/mcp/          server.ts, tools.ts
    src/webhooks/     paypal.ts
  workflows/          Render Workflows tasks: crawlSite, fetchPage, extractPage, publishWatermark, payoutRun
  web/                React: publisher dashboard, buyer portal, catalog pages, landing
  demo-site/          "Bluebonnet Rentals" (Express + EJS), seeded data, mutate script
packages/
  gate/               spigot-gate (npm-style package, zero runtime deps): classify.ts, policy.ts, middleware.ts
  shared/             zod schemas, extractor spec types, money helpers (micros ↔ cents)
  sdk/                APIMatic-generated client (P1)
db/migrations/        SQL
scripts/              seed-demo.ts, sim-bots.ts, sim-buyers.ts, scraper-demo.py, spikes-spigot.mjs
openapi.yaml
```

## Priorities

P0 = must ship for the demo. P1 = ship if time allows. P2 = describe in README only.

### P0 path (the kill-criterion loop, then money out)
`crawl demo site → AI proposes schema → owner approves → records + changes → buyer tops up with PayPal → paid MCP call → ledger charge → Payouts batch to publisher`

| # | Feature | Owner | Effort |
|---|---|---|---|
| 01 | Demo site (Bluebonnet Rentals) | A | 2 h |
| 02 | Gate middleware (UA table, 402, fail-open, hit counts) | A | 2.5 h |
| 03 | Site onboarding + crawl (sitemap, fetch, Workflows with in-process fallback) | A | 3 h |
| 04 | AI schema proposal + deterministic extractor + approve | A | 5 h |
| 05 | Records, versions, changes feed | A | 2.5 h |
| 06 | Buyer REST API, quote, 402 | B | 2.5 h |
| 07 | Ledger + charge-on-2xx + idempotency | B | 3 h |
| 08 | PayPal top-up (Orders v2 CAPTURE, card vault) | B | 3 h |
| 09 | Payouts batch + commission + webhook/poll reconcile | B | 2.5 h |
| 11 | MCP server (`describe_dataset`, `quote`, `search_records`, `get_changes`, `get_balance`, `top_up`) | B | 2.5 h |
| 12 | Buyer agent demo (Claude Desktop config, scraper script) | B | 1 h |
| 13 | Publisher dashboard: bots, proposals, dataset editor, earnings, payouts | A | 5 h |
| 14 | Auth (publisher session, buyer API keys), audit rows | B | 1.5 h |
| 15 | Demo seeding + SIM labelling | B | 2 h |
| 16 | Catalog page (where every 402 points), README, Devpost copy | A + B | 1.5 h |

That is ~20 h for A and ~18.5 h for B, plus ~3 h together for deploy, video and Devpost. It fits 2 people in ~24 h only if P1 waits. **Solo builder:** do 01 → 03 → 04 (JSON-LD only) → 05 → 07 → 06 → 11 → 08 → 09 → 13 (proposal + earnings + payouts only) → 02 → 15, and skip all P1.

### P1 (in this order, only after the kill checkpoint passes)
1. Auto top-up from vault (08) — the best extra PayPal moment.
2. Junk-data claims with balance credit (10).
3. Refund unused balance via PayPal Refunds (10).
4. Search-crawler reverse-DNS verification in the gate (02).
5. Drift check + re-inference (04).
6. Records browser and crawl-run screens (13).
7. `POST /ping` CMS webhook (05).
8. APIMatic SDK from `openapi.yaml` (11).
9. Landing page (16).
10. Log in with PayPal for publishers (14).

### P2 (README only)
Web Bot Auth signature verification · PayPal Subscriptions for flat-rate change feeds · Elastic `/search` endpoint · canary records per API key · JS tag analytics · multi-site per publisher in the UI · Playwright render for JS-heavy sites (KERNEL cloud browsers) · PayPal multiparty (`platform_fees`) with the publisher as merchant.

## Build order and owners (deadline **Nov 12, 12:00 pm PST**)

| Owner | Track | Features | Must be done by |
|---|---|---|---|
| **A: data** | Demo site, gate, crawler, schema agent, records, dashboard, catalog page | 01, 02, 03, 04, 05, 13, 16 (pages) | Nov 11, 18:00 PST: approved Listing dataset with records and a changes feed |
| **B: money + agent** | Ledger, PayPal, buyer API, MCP, payouts, seeding, README | 06, 07, 08, 09, 11, 12, 14, 15, 16 (README/Devpost) | Nov 11, 18:00 PST: a funded sandbox balance pays for an MCP call |

Timeline (assumes start Nov 11, 09:00 PST; if you start later, the kill checkpoint does **not** move):

| When (PST) | A: data | B: money + agent |
|---|---|---|
| Nov 11 09:00–10:30 | Repo skeleton, migrations, demo site with seeded data + sitemap + JSON-LD | Copy PayPal client; run new spikes S7, S8, S9 (`scripts/spikes-spigot.mjs`); ledger tables |
| 10:30–13:30 | Crawler (sitemap → fetch → snapshots), template clustering, schema agent v1 (JSON-LD first) | Ledger `post()`, buyer API keys, top-up endpoint + return URL, balance |
| 13:30–16:00 | Extractor runner, records + versions + changes; minimal approve endpoint | Quote, paid `/v1/.../records` + `/changes` with charge-on-2xx and idempotency; 402 |
| 16:00–18:00 | Gate middleware + 402 body; wire hit counts | MCP server tools over the same services; Claude Desktop connected |
| **Nov 11 18:00** | **Kill checkpoint (below)** | |
| 18:00–22:00 | Dashboard: proposals (hero), dataset editor, bots, earnings (AG Grid) | Payouts run + webhook/poll reconcile; S10/S11; seeding + SIM bots/buyers |
| 22:00–01:00 | Deploy both services + Workflows on Render; polish hero screens | Auto top-up (P1-1); claims credit (P1-2) if green |
| Nov 12 01:00–06:00 | Sleep / buffer | Sleep / buffer |
| 06:00–08:30 | Record the video (script in 12) | README, architecture slide, upload to YouTube early |
| 08:30–10:00 | Devpost: description, Built With, sponsors ticked, test accounts | |
| **Nov 12 10:00** | **Submitted.** The last 2 hours are buffer only. | |

### Kill criterion (from the review)
If the **crawl → extract → paid MCP call** loop is not working by **Nov 11, 18:00 PST**, stop Spigot and fold the effort back into Holdfast.

"Working" means, on a laptop or on Render, with no hand-edited DB rows:
1. The crawler reads the demo site's sitemap and stores snapshots.
2. The schema agent proposes a Listing schema and an approved extractor produces ≥ 2,000 records.
3. Claude Desktop calls `search_records` over MCP, gets typed JSON, and the buyer's balance (funded by one real sandbox top-up) goes down by the quoted amount in the ledger.

Payouts, the dashboard polish and the gate's 402 shot can follow after 18:00. Without step 3, there is no product.

## Definition of done (whole product)
- [ ] The demo site runs on Render with `spigot-gate` installed; humans and Googlebot-UA requests pass; `GPTBot` and `python-requests` get a 402 pointing to the API.
- [ ] The publisher connects the site; the crawler reads it; the AI proposes "Listing (2,341), Agent (88), Open House (40)" with sample rows.
- [ ] The owner hides `phone`, sets $1.50 per 1,000 records, and publishes. The extractor then runs with no per-page AI call (a log line proves it).
- [ ] A buyer tops up $20 through PayPal (sandbox approval) and the balance appears.
- [ ] Claude Desktop answers "3-bed rentals under $2k that changed today" via MCP; it's charged exactly `records × $0.0015`; a retry with the same idempotency key isn't charged twice.
- [ ] A mutate script changes prices on the demo site; the next crawl emits JSON Patch changes; `get_changes` returns only those.
- [ ] "Run payout now" sends a PayPal Payouts batch to the sandbox publisher account, net of 20% commission; status goes PENDING → SUCCESS.
- [ ] Every money event has a ledger transaction and an audit row with PayPal IDs; the ledger balances to zero.
- [ ] Simulated bots, buyers and calls are labelled SIM everywhere.
- [ ] README covers problem, persona, PayPal APIs, AI use, sponsors, setup, test accounts, honest limits; MIT license detectable in the repo About.
- [ ] Video under 3 min, public on YouTube.

## New PayPal spikes needed (run first, ~1.5 h total, `scripts/spikes-spigot.mjs`)

Same shape as `spikes/paypal-spikes.mjs`. Use the **US** sandbox business account (the India one fails cards and Payouts).

| # | Test | Why | Fallback if it fails |
|---|---|---|---|
| S7 | Orders v2 `intent: CAPTURE`: (a) card source, captured in one call; (b) PayPal wallet with `return_url`, approved in a browser with a sandbox Personal account, then `POST /orders/{id}/capture` | P0 top-up | Card-only top-up in the demo |
| S8 | `CAPTURE` with card `store_in_vault: ON_SUCCESS`, then a merchant-initiated `CAPTURE` from `vault_id` with `stored_credential`; (b) PayPal-wallet vault (`payment_source.paypal.attributes.vault.usage_type: MERCHANT`) | Auto top-up (P1-1) | Card vault only (S2 already proved the MIT pattern for AUTHORIZE). If both fail: auto top-up returns an approval link instead |
| S9 | Partial refund `POST /v2/payments/captures/{id}/refund` `{amount}` with `PayPal-Request-Id`; replay returns the same refund id | Refund unused balance (P1-3) | Cut the refund; claims stay as balance credits |
| S10 | One Payouts batch with 3 items (2 valid sandbox emails, 1 unregistered email); poll `GET /v1/payments/payouts/{batch_id}` for item statuses (`SUCCESS`, `UNCLAIMED`); re-submit the same `sender_batch_id` and record the duplicate error | Payout item failure path and crash-safe resubmit | Poll only; show UNCLAIMED as "waiting for publisher to claim" |
| S11 | Webhook delivery to the Render URL + `POST /v1/notifications/verify-webhook-signature` for `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` | Reconcile | Poll Orders and Payouts status (already enough for the demo) |

Already proven, reuse as-is: OAuth token, Orders v2 create + capture (S1), card vault + merchant-initiated order (S2, AUTHORIZE), `PayPal-Request-Id` idempotent replay (S3), Payouts create (S4).

## Sponsors (only where they fit)

| Sponsor | Prize | Role in Spigot | Priority |
|---|---|---|---|
| Render | $1k / $750 / $500 credits | Hosts the API, web app, demo site and paid Postgres. **Render Workflows** run the crawl fan-out (`crawlSite → fetchPage ×N → extractPage`) and the payout run. Fits the "data pipeline" use Render describes | P0 |
| AG Grid | $5k / $2k / 3 × $1k | Publisher dashboard: bot traffic grid, schema-driven sample/records grid (columns generated from the approved schema), earnings by buyer and record type, ledger and payout items | P0 |
| APIMatic | 3 × $1k + 6 mo Business | (1) PayPal Context Plugin while coding Orders/Payouts/Refunds (zero cost, P0); (2) generate a TypeScript + Python SDK from our `openapi.yaml` for buyers (P1). Real fit: Spigot is an API product | P0 / P1 |
| Elastic | none | `/search` full-text endpoint | P2, skip |
| KERNEL | none | Cloud browsers for JS-heavy publisher sites | P2, skip |
| Bryntum, Channel3, Zapier, Postman, Astropods | — | No genuine fit | Skip |

Note: Holdfast also enters AG Grid and Render. Each project has its own prize cap, so both can compete; don't reuse Holdfast's UI, build Spigot's own.

## Judging lane
Holdfast leads Agentic Commerce and Most Creative. Spigot leads **Most Impactful** (a named persona, small structured-data site owners who earn $0 from bots today) and **Best Use of PayPal + AI** (AI writes the extractor; PayPal funds, meters out and pays out). Never open the video with "402 + PayPal" (that's `Bortlesboat/paypal-402`'s pitch); open with the owner's bot report and the "I found 3 kinds of records" moment.

## Top risks
1. **Scope: 6 modules in ~24 h.** Mitigation: the P0 list above, the 18:00 kill checkpoint, reuse Holdfast's PayPal client and habits, in-process queue fallback if Render Workflows costs time.
2. **Looks like `paypal-402` / `agent-tab` at a glance.** Mitigation: lead with the publisher-side typed API, AI schema and changes feed; the 402 is a 10-second shot, not the story.
3. **Buyer demand is unproven, and stealth scrapers aren't stopped.** Mitigation: say so in Honest limits; price below scraping's all-in cost; do the review's assignment (2 site owners, 2 agent builders) and quote the answers if any arrive before recording.

## Honest limits (put these in the README)
- Stealth scrapers (residential proxies, spoofed browser UAs) are not stopped. Spigot gates **declared** bots and makes paying cheaper and better than evading.
- For factual data, the "license" is a contract, not copyright.
- We're merchant of record in the demo. Production uses PayPal multiparty (partner onboarding) so the publisher is the merchant.
- Holding prepaid balances needs the PayPal partner route (stored-value rules) in production.
- The demo site is fictional; simulated traffic and buyers are labelled SIM.

## Designs
No Figma file yet. Reuse Holdfast's design system approach (semantic colour tokens, Tailwind) but a different palette so the two submissions don't look alike. Screens are listed in [screens.md](screens.md); build W05 (proposals) and W08 (earnings) first.
