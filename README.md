# Spigot

> **Turn your site into a paid API for AI agents.** Bots stop scraping your HTML and buy clean, live records instead. PayPal funds the agents and pays you.
>
> **"Scrapers pay Bright Data. Spigot makes them pay you, and they get better data."**

Spigot is our second, separate entry for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/) (our other entry is Holdfast). A small site owner installs a tiny gate in front of their site. Declared AI bots and scraping libraries get an HTTP 402 that points them at a paid API. Claude reads the site once and writes an extractor for each kind of record it finds ("Listing, 2,341 records"). The owner approves it and sets a price. Agents top up a prepaid balance with PayPal, pay per record from it, and the owner is paid out through PayPal Payouts.

> [!IMPORTANT]
> **Status of this README.** It was written early (ticket SP-044) while the code was still being built, so every table has a **Status** column that says what is merged on `main`. Anything marked `TODO(SP-046)` is filled in at submission: the deployed URLs, the video link, and which Render Workflows mode ran the demo. Search this file for `TODO` to find them. The build plan is in [`docs/spec/`](docs/spec/README.md); ticket status is in [`docs/tickets/INDEX.md`](docs/tickets/INDEX.md).

- **Live API and dashboard:** `TODO(SP-046)`: deployed Render URL
- **Demo site (Bluebonnet Rentals, fictional):** `TODO(SP-046)`: deployed Render URL
- **Public catalog page:** `TODO(SP-046)`: `https://<api-host>/c/<site slug>` (the slug `seed:demo` prints; see [Setup](#setup))
- **Video:** `TODO(SP-046)`: public YouTube link
- **Licence:** [MIT](LICENSE)

---

## Contents

1. [The problem and who has it](#the-problem-and-who-has-it)
2. [How it works](#how-it-works)
3. [PayPal APIs used](#paypal-apis-used)
4. [AI used](#ai-used)
5. [Sponsor tools](#sponsor-tools)
6. [Setup](#setup)
7. [Test accounts (sandbox only)](#test-accounts-sandbox-only)
8. [What's real and what's simulated](#whats-real-and-whats-simulated)
9. [Honest limits](#honest-limits)
10. [What's next](#whats-next)
11. [PayPal sandbox gotchas](#paypal-sandbox-gotchas)
12. [Licence](#licence)
13. [Built during the hackathon](#built-during-the-hackathon)

## The problem and who has it

**Persona: the owner or CTO of a 5–50 person directory, classifieds or listings site** (a local services directory, a used-equipment marketplace, event listings, a niche real-estate or job board). Public scraper "actors" already target their site. Bot traffic is a real line on their hosting bill. Blocking breaks nothing for them, but it earns nothing either.

- **Bots now outnumber the clicks they send.** AI bots grew from about 1 per 200 human visits to **1 AI bot visit for every 31 human visits** in Q4 2025, while click-through from AI apps fell to 0.27%. Source: [TollBit, Scraper Index, 2026-04-13](https://tollbit.com/blog/scraper-index-and-audit/).
- **Buyers already pay for this data, just not to the site.** Bright Data reports **over $300M ARR**, and says 14 of the top 20 LLM labs use it. Source: [Bright Data](https://brightdata.com/blog/general/data-for-ai-is-fueling-massive-growth-at-bright-data).
- **Structured records sell for more than pages.** Apify's top actor, the Google Maps scraper (about 426K users), costs about **$2.10 per 1,000 places**. That is a third-party figure from our research notes; see the [actor page](https://apify.com/compass/crawler-google-places) for current pricing. Spigot's demo price is $1.50 per 1,000 records, paid to the site owner.
- **Licensing deals don't reach the long tail.** Licensing money is concentrated in a small group of large publishers ([DCN, 2026-06](https://digitalcontentnext.org/blog/2026/06/09/mapping-publisher-value-in-the-ai-marketplace/)), and blocking is already free ([Cloudflare blocks AI crawlers by default since July 2025](https://blog.cloudflare.com/content-independence-day-ai-options/)).

So the pitch isn't "now it's legal". It's "now it doesn't break when the site changes, it's cheaper than scraping, and the owner gets paid". The product background and the adversarial review are in [`docs/research/15-gstack-spigot.md`](docs/research/15-gstack-spigot.md).

## How it works

```
 Publisher's site ── spigot-gate ── human / Googlebot: pass
                                └── GPTBot / python-requests: 402 { price, API, MCP, catalog }
 Spigot crawler ── sitemap → pages → Claude proposes record types + extractor (once) → owner approves
 Plain code runs the extractor on every page (zero AI calls per page) → records + JSON Patch changes feed
 Buyer tops up with PayPal → REST /v1 or MCP /mcp → quote → serve → charge the ledger (only on 2xx)
 Payable accrues to the owner (minus 20% commission) → PayPal Payouts batch
```

1. **Gate.** `spigot-gate` runs inside the publisher's server. It classifies each request locally in under 1 ms and fails open. Humans and search crawlers pass. Declared AI bots and scraping libraries get **HTTP 402** with a JSON body: the price, the API endpoint, the MCP URL and a link to the public catalog page.
2. **Crawl.** Spigot reads the sitemap and fetches public pages with a secret header, at most 2 requests at a time per host.
3. **AI proposes, the owner approves.** Plain code groups pages by template; Claude then proposes record types ("I found 3 kinds of records on your site: Listing 2,341, Agent 88, Open House 40"), with fields and an extractor written as a JSON spec, not code. The owner hides fields (e.g. `agent_phone`), sets a price and publishes.
4. **Records and changes.** Each record has a stable key, a content hash and a version. Re-crawls emit RFC 6902 JSON Patch changes, so agents can ask "what changed today?".
5. **Buyers pay from a PayPal-funded balance.** A buyer tops up with PayPal, then pays per record via REST or MCP. The ledger is charged only after a 2xx response is built, and the same `Idempotency-Key` is never charged twice.
6. **Owner gets paid.** Earnings accrue in a double-entry ledger and go out as batched PayPal Payouts.

<details>
<summary>System diagram (from the build spec)</summary>

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

</details>

Full diagram, rules and code map: [`docs/architecture.md`](docs/architecture.md).

## PayPal APIs used

Only the backend calls PayPal, over REST, with a fixed `PayPal-Request-Id` per call so retries are idempotent. No language model ever holds PayPal credentials. "Proven" means a sandbox spike passed: S1–S4 ran for Holdfast on 2026-11-10 with the same sandbox app ([`spikes/paypal-spikes.mjs`](spikes/paypal-spikes.mjs)), and Holdfast's S7 is in [`spikes/s7-results.md`](spikes/s7-results.md). Spigot's own spikes S7–S11 are ticket SP-003.

| PayPal API | How Spigot uses it | Money moment | Proven / status |
|---|---|---|---|
| **Orders v2, `intent: CAPTURE`** | Buyer tops up a prepaid balance (PayPal wallet or card), captured in one step | Money in | S1 proved Orders + capture with `AUTHORIZE`; `CAPTURE` is spike S7 (SP-003). Code: SP-018a, not merged yet |
| **JS SDK v6** | "Top up with PayPal" button in the buyer portal (W11) | Money in | SP-032, not merged yet |
| **Vault** (card and PayPal wallet) | Save the payment method on the first top-up (`store_in_vault: ON_SUCCESS`) | Saved for auto top-up | Card vault proven (S2); wallet vault proven with `AUTHORIZE` (Holdfast S7), with `CAPTURE` in S8 (SP-003). Wallet vault on top-ups is behind `PAYPAL_WALLET_VAULT` until S8b passes |
| **Merchant-initiated (MIT) order from `vault_id`** | **Auto top-up:** when an agent runs low mid-session, charge the saved method with no buyer present (`stored_credential: MERCHANT, UNSCHEDULED, SUBSEQUENT`), within the buyer's monthly cap | Agent keeps going | Proven for `AUTHORIZE` (S2). P1: SP-047a/b/c, not merged yet |
| **Payouts v1 (batched)** | One batch per payout run, one item per publisher whose payable is ≥ $10 (demo threshold $1, labelled); poll items to SUCCESS / UNCLAIMED / RETURNED | Money out | Proven (S4; $1,000 item SUCCESS in Holdfast S7). Code: SP-020, SP-021, not merged yet |
| **Refunds** (partial, on the original capture) | Refund a buyer's unused balance to PayPal | Cash out | P1: spike S9, SP-049, not merged yet |
| **Webhooks + `verify-webhook-signature`** | Verify and reconcile capture and payout events; polling covers us if a webhook is missed | Books stay right | Spike S11; SP-001c, not merged yet. `TODO(SP-046)`: say whether a webhook id was registered on the deploy |
| **`PayPal-Request-Id`** | On every call, derived from our own row id, so a crash and retry never pays twice | (invisible) | Proven (S3) |

**Why not micropayments.** A record costs $0.0015. PayPal's standard fee is about 3.49% + $0.49 per capture, so capturing per call is uneconomic. Buyers fund a prepaid balance with PayPal instead (minimum $5), and each call is a ledger debit in micros (1 USD = 1,000,000 micros).

**Why not the PayPal Agent Toolkit or PayPal MCP server for the buyer agent.** Both run on the *merchant's* credentials, and only the payee's app can create an order. Giving them to a buyer's agent would hand it our merchant account. So the buyer agent tops up through **our** MCP `top_up` tool, and our backend calls Orders v2.

**Production path: PayPal multiparty.** In the sandbox demo, Spigot is the merchant of record and pays publishers through Payouts. In production the publisher would be the merchant, onboarded through PayPal's partner (multiparty) flow, with Spigot's commission taken as `platform_fees`. That needs approved-partner status and isn't built.

**Build aid.** We used the **APIMatic PayPal Context Plugin** while writing the PayPal client (`apps/api/src/paypal/*`, SP-001b/SP-001c). `TODO(SP-046)`: confirm it was used for that code, or remove this line.

## AI used

| Where | What the AI does | Guardrail | Status |
|---|---|---|---|
| **Schema agent** (Claude API, tool use) | Reads JSON-LD and a cleaned DOM outline of 3–5 sample pages per template, proposes record types and fields, writes the extractor, runs it on 20 samples, repairs it (≤ 2 rounds), flags PII | Output is a Zod-validated JSON spec of JSON-LD paths, CSS selectors and whitelisted transforms, **never code**. Page text is treated as data (SP-012a adds a prompt-injection test fixture). The owner approves before anything is sold | Template clustering + DOM outline merged (SP-010). Agent: SP-012a/SP-012b, not merged yet |
| **Claims triage** (P1) | Reads a "junk record" claim with the record's version history and the current page, and recommends credit or reject | Only deterministic cases auto-credit; the AI recommendation is shown to the publisher, with a capped amount | SP-048b, not merged yet |
| **Buyer agent: Claude Desktop over MCP** | Turns "3-bed rentals under $2k in Austin that changed today" into `list_datasets` → `describe_dataset` → `quote` → `search_records` / `get_changes`, and can top up within its cap | Spend caps, per-call max price and the auto top-up cap are enforced in code, not in the prompt. Records are returned as data; we never execute instructions found in them | SP-022a/SP-022b, not merged yet |

**Zero AI calls per page after approval.** Claude writes the extractor once per template. After the owner approves, plain code runs it on every page and every re-crawl, and no API request triggers a model call. That keeps the cost per record near zero and makes extraction deterministic and auditable. The model is set in `CLAUDE_MODEL`; `TODO(SP-046)`: record the model id used for the demo.

## Sponsor tools

| Sponsor | Used for | Evidence | Status |
|---|---|---|---|
| **Render** | API web service, demo-site web service (with a disk), paid Postgres (the free tier expires before judging ends on Dec 21) | `render.yaml` | SP-040, not merged yet |
| **Render Workflows** | Crawl fan-out (`crawlSite → fetchPage ×N → extractPage → publishWatermark`) and `payoutRun`. The same task code also runs in-process (`WORKFLOWS_MODE=inproc`, the default) | `apps/workflows/` | SP-041a/SP-041b, not merged yet. `TODO(SP-046)`: say which mode ran the demo (`inproc` or `workflows`) |
| **AG Grid** (Enterprise + AG Charts) | Publisher dashboard: bot traffic, schema-driven sample/records grid (columns generated from the approved schema), earnings by buyer and record type, ledger, payout items | `apps/web/` | SP-024a onward, not merged yet |
| **APIMatic** | PayPal Context Plugin while coding the PayPal path; (P1) TypeScript/Python SDK generated from our `openapi.yaml` into `packages/sdk` | `packages/sdk/` (P1) | Plugin: see [PayPal APIs used](#paypal-apis-used). SDK: SP-056, not merged yet |

We don't use the other sponsor tools (Bryntum, Channel3, Zapier, Postman, Astropods). Elastic and KERNEL appear only under [What's next](#whats-next).

## Setup

You need Node 22 or newer, Docker (for the local Postgres) and, for the real sandbox, a PayPal developer account. With `PAYPAL_MODE=stub` the whole stack runs on **FakePayPal**: no PayPal account and no network calls to PayPal.

> Verified from a fresh clone on 2026-11-12 (ticket SP-044b) with Node 24 / npm 11 and `PAYPAL_MODE=stub`, following only this section.

**1. Clone, configure, database.**

```sh
git clone https://github.com/Nemil21/spigot.git && cd spigot
cp .env.example .env
scripts/dev-db.sh               # starts the local Postgres container, creates the databases, prints two lines
```

`scripts/dev-db.sh` starts one Postgres container (`spigot-dev-pg`, on `127.0.0.1:54329`) and creates a database named after the checkout's directory (`spigot_<dir>` and `spigot_<dir>_test`). If another checkout on the machine has the same directory name, set `SPIGOT_DB_WORKTREE=<something-else> scripts/dev-db.sh` so the two don't share a database.

Now edit `.env`. For a FakePayPal run these are the only keys you need; leave the rest empty:

```sh
DATABASE_URL=…                  # the two lines scripts/dev-db.sh printed
TEST_DATABASE_URL=…
SESSION_SECRET=…                # 32+ characters: openssl rand -hex 32
PAYPAL_MODE=stub
PAYPAL_CLIENT_ID=stub           # still required at boot; any non-empty value works in stub mode
PAYPAL_CLIENT_SECRET=stub
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
APP_BASE_URL=http://localhost:3000
```

**2. Install, migrate, seed, build.**

```sh
npm install                     # npm 11 may warn that install scripts were skipped (argon2, esbuild); that's fine, both ship prebuilt binaries
npm run migrate
npm run seed:demo               # publisher, site, demo buyer, 20 SIM buyers (labelled); safe to re-run
npm run build                   # needed once: the API imports the built packages/shared, and serves the built web app
```

`seed:demo` prints everything you need next: the demo publisher's and demo buyer's logins (passwords are derived from `SESSION_SECRET`), the buyer's `sk_spg_` API key, and the demo site's `SPIGOT_API_BASE`, `SPIGOT_GATE_KEY` and `SPIGOT_VERIFY_TOKEN`.

**3. Run the API and the demo site** (two terminals).

```sh
npm run dev                     # the API on http://localhost:3000; it also serves the web app (/app, /buyers) and the catalog (/c/:site)

# Demo site "Bluebonnet Rentals" on http://localhost:4100. It doesn't read .env: pass the values seed:demo printed.
SPIGOT_API_BASE=http://localhost:3000 SPIGOT_GATE_KEY=gk_… SPIGOT_VERIFY_TOKEN=spigot-verify=… \
  npm run dev -w @spigot/demo-site
```

`npm run dev` starts only the API; start it before the demo site. A demo site started first logs `[spigot-gate] policy not loaded` and passes every request until its next policy refresh (60 s). If port 3000 is taken, set both `PORT` and `APP_BASE_URL` (e.g. `PORT=3100 APP_BASE_URL=http://localhost:3100 npm run dev`) and use that port for the demo site's `SPIGOT_API_BASE` too.

**4. Open it.**

- `http://localhost:3000/app`: the publisher dashboard; log in with the publisher email and password `seed:demo` printed.
- `http://localhost:3000/buyers`: the buyer portal; log in as "Acme Agents (demo)".
- `http://localhost:3000/c/localhost`: the catalog page. The site slug comes from the demo site's host name, so locally it is `localhost` (`seed:demo` prints it as `slug …`); on Render it is the first label of the demo site's host.
- `http://localhost:4100`: the demo site. Until a dataset is published, the gate passes every request, bots included: `seed:demo` connects and verifies the site but leaves the crawl for the live demo. Start it from the dashboard (W03), approve a record type, and declared bots then get the 402.

### Environment

Every key is listed, with no values, in `.env.example` (SP-001a). The ones you need to know:

| Key | What it is |
|---|---|
| `DATABASE_URL`, `SESSION_SECRET`, `APP_BASE_URL` | Required at boot |
| `PAYPAL_MODE` | `stub` (FakePayPal, no keys) or `sandbox` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE` | Sandbox REST app of the **merchant** account. Boot refuses a non-sandbox base unless `PAYPAL_ENV=live` |
| `PAYPAL_WEBHOOK_ID` | Only if webhooks are registered |
| `DEMO_PUBLISHER_PAYOUT_EMAIL` | The **separate publisher business** sandbox account that receives payouts |
| `VITE_PAYPAL_CLIENT_ID` | Same client id, for the JS SDK v6 button |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `SCHEMA_AGENT_MODE` | Schema agent; `recorded` replays a recorded proposal with no key (the default under `NODE_ENV=test`; otherwise `live`) |
| `AG_GRID_LICENSE_KEY`, `VITE_AG_GRID_LICENSE_KEY` | AG Grid Enterprise (watermarked without it) |
| `WORKFLOWS_MODE`, `RENDER_API_KEY`, `RENDER_WORKFLOWS_SERVICE_ID` | `inproc` (default) or `workflows` on Render |
| `SPIGOT_GATE_DEMO` | Lets the gate label `X-Spigot-Sim: 1` traffic as SIM |

Never commit `.env`; it is git-ignored, and CI runs gitleaks over the full history.

### Sandbox accounts (three, all in the US sandbox)

Create these in the PayPal Developer Dashboard → Sandbox → Accounts. Use **US** accounts (an India business account fails cards and Payouts).

1. **Merchant (business).** Owns the REST app whose client id and secret go in `.env`. Receives top-ups and sends payouts.
2. **Publisher (a second, separate business account).** Its email goes in `DEMO_PUBLISHER_PAYOUT_EMAIL`. It must not be the merchant: paying yourself fails with `SELF_PAY_NOT_ALLOWED`.
3. **Buyer (personal).** Logs in on PayPal's sandbox approval page when the demo buyer tops up with the PayPal wallet.

### Claude Desktop

Create an API key for the buyer in the buyer portal (W11 shows this config with the key filled in), then add to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "spigot": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<api-host>/mcp", "--header", "Authorization: Bearer <your sk_spg_ key>"]
    }
  }
}
```

Restart Claude Desktop and ask: *"Using Spigot, find 3-bedroom rentals under $2,000 in Austin on Bluebonnet Rentals that changed today. Quote first, then fetch."* Tools: `list_datasets`, `describe_dataset`, `quote`, `search_records`, `get_changes`, `get_balance`, `top_up`. More in `docs/demo/claude-desktop.md` (SP-039a).

### Demo scripts

| Command | What it does | Ticket |
|---|---|---|
| `npm run seed:demo` | Publisher, site, real demo buyer "Acme Agents (demo)", 20 SIM buyers with SIM sandbox top-ups | SP-035 |
| `npm run sim:bots -- --target <demo-site> [--minutes 10] [--backfill 7d]` | Real HTTP requests to the demo site with bot UAs (2–5 req/s each) and human UAs (`--human-rps`, default 60), header `X-Spigot-Sim: 1`, live tally by bot; counted SIM only when the gate runs with `SPIGOT_GATE_DEMO=1` (it warns otherwise). `--backfill 7d` first posts a week of SIM buckets to `/api/gate/hits` with `SPIGOT_GATE_KEY` (a few posts, ≥ 5 s apart; run it once per reset, re-posting sums) | SP-037 |
| `npm run sim:buyers [-- --live]` | Real `/v1` calls from SIM buyers over a simulated week | SP-036 |
| `npm run demo:mutate -- --prices 30 --leased 5 --new 3 [--focus …] [--target <url>]` | A labelled **demo mutation**: changes listings on the demo site (rents, leased, new) so the next crawl has exactly those changes; `POST /admin/reset` on the demo site puts them back | SP-004b |
| `npm run demo:reset`, `npm run demo:payout` | Clean take; "Run payout now" with the labelled $1 demo threshold | SP-038 |
| `python scripts/scraper-demo.py <demo-site>` | A plain scraper gets three 402s with the price and API link | SP-039a |

## Test accounts (sandbox only)

Everything here is PayPal **sandbox**: no real money moves. Passwords are **never** in this repository; they are in the Devpost "testing instructions" field.

| Account | For | Login |
|---|---|---|
| Demo publisher "Bluebonnet Rentals (demo)" | Dashboard: bot report, record types, dataset editor, earnings, payouts | `TODO(SP-046)`: email; password in Devpost |
| Demo buyer "Acme Agents (demo)" | Buyer portal: top up, API keys, Claude Desktop config | `TODO(SP-046)`: email; password in Devpost |
| Sandbox PayPal **personal** buyer | Approving a PayPal wallet top-up on PayPal's sandbox page | `TODO(SP-046)`: email; password in Devpost |
| Sandbox card | Card top-up | A test card from the PayPal Developer Dashboard (e.g. Visa 4111 1111 1111 1111, any future expiry) |

## What's real and what's simulated

Simulated items are always labelled **SIM** in the UI (a grey chip in every grid, and "incl. $X simulated" on KPI tiles). "Real" below means real code paths and, for money, real PayPal **sandbox** calls. The last column says whether that code is merged on `main` as of this README revision; nothing is claimed as working before it is.

| Item | Real or simulated | How it's labelled | Code on `main` |
|---|---|---|---|
| Demo site "Bluebonnet Rentals" | **Fictional site**, real server: 2,341 listings / 88 agents / 40 open houses from a fixed seed, JSON-LD, sitemap, ETags | "Not a real business" on the site's About page; this README | **Merged** (SP-004a, `apps/demo-site/`) |
| Gate decisions (pass / 402) | **Real** classification of every request by the gate | – | SP-006a/SP-006b, not merged yet |
| Background bot traffic | **Simulated** volume: real HTTP requests with bot User-Agents sent by our script, classified for real, counted as SIM | SIM chip; `X-Spigot-Sim: 1` | SP-037, not merged yet |
| Crawl of the demo site | **Real**, run live (not seeded) | – | SP-009a1/a2/b, not merged yet |
| AI proposal ("I found 3 kinds of records") | **Real** Claude call in the video. `--with-proposals` replays the last real proposal for retakes only | "replayed proposal" in the audit log | Clustering merged (SP-010); agent SP-012a, not merged yet |
| Records and changes feed | **Real** output of the approved extractor; `demo:mutate` makes the site changes | – | SP-011, SP-013, SP-015, not merged yet |
| Demo buyer's top-up | **Real** sandbox PayPal Orders v2 CAPTURE, approved on PayPal's page | – | SP-018a, SP-032, not merged yet |
| Claude Desktop paid call | **Real** MCP call, real ledger charge of `records × price` | – | SP-022a, SP-016, not merged yet |
| Background buyers (20) | **Simulated** buyers. Their balances come from real sandbox card top-ups (or ledger-only top-ups if rate-limited); their calls are real `/v1` calls backdated over a simulated week | SIM chip; "SIM (no PayPal)" for ledger-only top-ups | SP-035, SP-036, not merged yet |
| Payout to the publisher | **Real** sandbox Payouts batch to the separate publisher account | Demo $1 threshold labelled | SP-020, SP-021, not merged yet |

`TODO(SP-046)`: re-check this table against `main` at the freeze and record the count of "SIM (no PayPal)" top-ups in the recording seed.

## Honest limits

- **Stealth scrapers aren't stopped.** Scrapers on residential proxies with spoofed browser User-Agents pass the gate. Spigot gates **declared** bots and makes paying cheaper and better than evading. The demo's scraper script never shows a browser-UA variant.
- **The "licence" is a contract, not copyright.** Facts like prices aren't copyrightable, and logged-off scrapers generally aren't bound by a site's terms (Meta v. Bright Data). A 402 doesn't legally force anyone to pay; the reason to pay is clean, typed, live data that doesn't break.
- **We're merchant of record in the demo.** Production uses PayPal multiparty (partner onboarding) so the publisher is the merchant, with our fee as `platform_fees`. PayPal fees on top-ups and payouts come out of our commission in the demo.
- **Holding prepaid balances** needs the PayPal partner route (stored-value rules) in production.
- **The demo site is fictional;** simulated bot traffic and background buyers are labelled SIM.
- **Buyer demand is unproven.** Scraper revenue proves demand for this data, but not yet willingness to pay the site owner directly. We planned to ask 2 small-site owners and 2 agent builders before recording; `TODO(SP-046)`: quote any answers that arrived, or leave this line as is.
- **Server-rendered sites only.** The crawler doesn't run JavaScript (Playwright rendering is P2).
- **One site per publisher in the UI.**

## What's next

P2 items (described here only, not built) and the obvious follow-ons:

- **Web Bot Auth:** verify cryptographically signed bot requests, so the gate knows which declared bots really are who they say.
- **PayPal multiparty** (`platform_fees`) with the publisher as merchant of record.
- **PayPal Subscriptions** for flat-rate monthly change-feed plans.
- **Elastic `/search`** full-text endpoint over records.
- **Canary records** per API key, to trace resold data back to the buyer.
- **JS tag analytics** for owners who can't install server middleware.
- **Multi-site per publisher** in the UI.
- **Playwright rendering for JS-heavy sites** (KERNEL cloud browsers).
- **WordPress plugin** for the gate.

## PayPal sandbox gotchas

What we hit, so you don't have to (details in [`spikes/s7-results.md`](spikes/s7-results.md)):

- **`SELF_PAY_NOT_ALLOWED`:** a payout to the merchant's own account is denied (batch DENIED, item FAILED). Pay a **separate** sandbox business account.
- **`INSUFFICIENT_FUNDS` on large payouts:** payouts of $2,500 and up returned `422 INSUFFICIENT_FUNDS` (no batch created) even after about $106k of card captures; captured money didn't become payable within about an hour. $1,000 succeeded. Spigot's demo payout is small (about $400), and the payout run (SP-020) treats `INSUFFICIENT_FUNDS` as a definite failure: the payable is restored, the batch is marked FAILED, an alert fires and the next run retries.
- **Raw-card order create isn't replay-safe:** the same `PayPal-Request-Id` returns `422 TRANSACTION_REFUSED`. Orders from a `vault_id` or with no payment source replay cleanly; capture and void replays return the original result. Server-side card top-ups use deterministic ids saved before the PayPal call.
- **A mocked `INSTRUMENT_DECLINED` on capture comes back as 403 with an empty body.** Classify by HTTP status, not by issue code.
- **`GET /v1/reporting/balances` returns 403** for this app, so health checks can't read the merchant balance.
- **Test cards:** Visa 4111…1111, Visa 4012…1881, MC 5555…4444, Amex 3714…8431, Discover 6011…1117 all worked at concurrency 20. **5105 1051 0510 5100 is rejected.**
- **Use a US sandbox business account;** the India one fails cards and Payouts.

## Licence

[MIT](LICENSE). Copyright (c) 2026 Spigot contributors.

For data sold through Spigot, each catalog page states the contract terms for that site's factual data (no resale; attribution optional). Those terms are separate from this code licence.

## Built during the hackathon

Spigot is a new repository, built during the PayPal AI Hackathon 2026 on **Nov 11–12, 2026**; the first commit is the build spec. It is a separate, substantially different product from our other submission, Holdfast. We reused habits and the proven PayPal sandbox call patterns from Holdfast's spikes (copied into [`spikes/`](spikes/)), not its product code or UI.
