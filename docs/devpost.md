# Spigot: Devpost draft

Final copy of the Devpost submission text for Spigot (SP-045, finalised in SP-046). Paste each section under **"Paste into Devpost"** into the matching Devpost field. Everything above that line is for us, not for Devpost. A person pastes and submits; agents never touch the Devpost form.

- Hackathon: PayPal AI Hackathon 2026. Deadline **Nov 12, 12:00 PST (01:30 IST Nov 13)**; we submit at **10:00 PST (23:30 IST)**.
- This is our **second** submission. Holdfast is the other. Spigot leads **Most Impactful** and **Best Use of PayPal + AI**; Holdfast leads Agentic Commerce and Most Creative.
- Never open with "402 + PayPal". Open with the owner's problem.
- The buyer agent in the video is the **Claude Code CLI** over MCP ([demo/claude-code-cli.md](demo/claude-code-cli.md)), not Claude Desktop.

## Freeze read-through (done in SP-046 against `main`)

Every claim in the text below was checked against what is merged on `main` on Nov 12. Claims whose ticket didn't merge were cut or reworded.

| Claim in the draft | Ticket(s) | Shipped? |
|---|---|---|
| Demo site Bluebonnet Rentals, 2,341 / 88 / 40 records | SP-004a | yes |
| Gate returns 402 to declared bots, fails open, humans pass | SP-006a, SP-006b, SP-008b | yes |
| Crawler reads the sitemap with `X-Spigot-Key` | SP-009a1, SP-009a2, SP-009b | yes |
| AI proposes "Listing, Agent, Open House" with schema + extractor | SP-010, SP-011, SP-012a | yes |
| Schema agent self-checks and repairs the extractor | SP-012b | yes |
| Owner hides fields, sets price, publishes | SP-014a, SP-029 | yes |
| Records, versions, JSON Patch changes feed | SP-013, SP-015 | yes |
| Buyer REST API, quote, charge only on 2xx, idempotent | SP-016, SP-017a, SP-017b, SP-005 | yes |
| PayPal top-up (Orders v2 CAPTURE, JS SDK v6 button) | SP-018a, SP-018b, SP-032 | yes |
| Card fields top-up (P1) | SP-063 | yes |
| Vault + merchant-initiated auto top-up (P1) | SP-047a, SP-047b, SP-047c | yes (card vault; wallet vault stays off until spike S8b passes) |
| Payouts batch to publisher, 20% commission | SP-020, SP-021, SP-031 | yes |
| Refund unused balance (P1) | SP-049 (API), SP-050 (W12 button) | API yes (`POST /api/buyer/refunds`); W12 button **no**, so the text says "can be refunded", not "click to refund" |
| Claims + AI claims triage (P1) | SP-048a, SP-048b | yes; SP-048c (re-fetch, MCP `report_bad_record`) **no** |
| PayPal webhooks with signature verification (P1) | SP-059 | yes |
| MCP server; Claude Code as buyer agent | SP-022a, SP-022b, SP-039b | yes |
| Drift detection (P1) | SP-052a | yes; re-inference (SP-052b) **no**, so the text doesn't claim it |
| Log in with PayPal for publishers (P1) | SP-058 | yes |
| AG Grid dashboard (bots, proposals, earnings, payouts) | SP-024a, SP-027b, SP-028, SP-030b, SP-031 | yes |
| Hosted on Render | SP-040 | yes |
| Render Workflows run crawl + payout | SP-041a, SP-041b | task code yes; **the demo ran `WORKFLOWS_MODE=inproc`**, so the text says the tasks are built for Workflows, not that Workflows ran the demo |
| APIMatic Context Plugin used while coding PayPal | (process) | **no evidence in the repo**: cut |
| APIMatic SDK from `openapi.yaml` (P1) | SP-023, SP-056 | OpenAPI yes; SDK **no**: cut |
| "Whole loop works end to end" (Accomplishments) | every row above, run on Render | the two Render dry runs before recording ([MANUAL-STEPS.md](MANUAL-STEPS.md) §6) |
| Live URLs, video URL, test accounts | SP-040, SP-046, SP-044b | URLs and video: [[fill]] after deploy and upload |

**If the Render Workflows check passes before submitting** ([deploy.md §Render Workflows check](deploy.md#render-workflows-check-sp-041b-post-freeze)) and the demo is re-run with `WORKFLOWS_MODE=workflows`, add `render-workflows` back to Built With and change the Render bullet in "How we built it" to say Workflows ran the crawl and payout.

### Built With

Enter these as Devpost "Built With" tags (the same list is under [Built With](#built-with) below):

`paypal-orders-v2`, `paypal-vault`, `paypal-payouts`, `paypal-refunds`, `paypal-webhooks`, `paypal-js-sdk-v6`, `log-in-with-paypal`, `claude-api`, `claude-code`, `mcp`, `render`, `ag-grid`, `node.js`, `typescript`, `postgresql`, `fastify`, `react`

Left out on purpose: `claude-desktop` (the demo uses Claude Code), `render-workflows` (see above), `apimatic` (not used).

### Sponsors to tick on the form

- **Render**: yes. Everything is hosted on Render (`render.yaml`: API, demo site, paid Postgres).
- **AG Grid**: yes. Every dashboard grid is AG Grid Enterprise.
- **APIMatic**: no (SDK not built, plugin use not shown).
- Nothing else (Elastic, KERNEL, Bryntum, Channel3, Zapier, Postman, Astropods: not used).

### Fill in before pasting

Only these are left, all known only after deploy, recording and upload. Search for `[[fill]]`.

- `[[fill]] APP_URL`: Render URL of `spigot-api` (dashboard `/app`, buyer portal `/buyers`).
- `[[fill]] DEMO_SITE_URL`: Render URL of `bluebonnet-rentals`.
- `[[fill]] CATALOG_URL`: `<APP_URL>/c/bluebonnet` (`seed:demo` always uses the slug `bluebonnet`).
- `[[fill]] VIDEO_URL`: the public YouTube link.
- `[[fill]] screenshots` for the Devpost image gallery (suggested: W05 proposal cards, W06 publish, W11 top-up with the PayPal button, Claude Code terminal with the charge, W08 earnings, W09 Paid out). No real brands, no keys on screen.

Test-account **passwords** go only in Devpost's private testing-instructions field, never in this file.

---

# Paste into Devpost

## Project name

Spigot: turn your site into a paid API for AI agents

## Tagline (elevator pitch)

AI bots scrape small listings sites for free. Spigot lets the owner sell them clean, live records instead: Claude writes the API, PayPal funds the agents and pays the owner.

## About the project

### Inspiration

Picture the owner of a small rental listings site. Five people, a few thousand listings, a hosting bill. Their logs now show one AI bot visit for every 31 human visits (TollBit, Q4 2025), up from one in 200. Those bots download every page, strip the HTML and resell the data. The buyers pay scraping companies: Bright Data alone reports over $300M a year in revenue. A public scraper for Google Maps places charges about $2.10 per 1,000 records. The site that made the data earns nothing.

The owner's choices today are bad. Blocking bots is free but earns nothing, and the scrapers come back through proxies. Big publishers sign licensing deals with AI labs; a directory with 2,000 listings will never get that call.

The buyers aren't happy either. Scrapers break every time a site changes its layout, and they hand back messy HTML, not records.

So we asked: what if the site itself was the cheapest, cleanest way to get its own data, and the owner got paid for it?

### What it does

Spigot turns a website into a typed, paid API for AI agents, in minutes, without the owner writing code.

1. **The gate.** The owner adds `spigot-gate`, a small middleware, to their site. Humans and search engines pass straight through. Declared AI bots and scrapers (GPTBot, `python-requests` and friends) get an HTTP 402 with a price and a link to the API. The gate decides locally in under a millisecond and fails open, so the site never goes down because of us.
2. **The AI finds the data.** Spigot crawls the site's public pages from its sitemap. Claude reads a few sample pages from each layout and proposes record types: on our demo site it finds **Listing (2,341), Agent (88) and Open House (40)**, with fields and sample rows. It also writes the extractor for each one, runs it on 20 samples, checks the results and repairs its own mistakes. It flags personal data such as agents' phone numbers and hides it by default.
3. **The owner approves.** The owner reviews the proposal (Spigot has already hidden `agent_phone` as personal data), sets **$1.50 per 1,000 records** and clicks Publish. From then on the extractor is plain code: **zero AI calls per page**. Every re-crawl turns into versioned records and a changes feed (JSON Patch), so buyers can ask "what changed today?".
4. **Agents pay with PayPal.** An agent builder gets an API key and tops up a prepaid balance with PayPal (Orders v2, JS SDK v6 button or card fields). A card can be saved in PayPal Vault, so when the agent runs low mid-task Spigot tops it up automatically, inside a monthly cap the human set.
5. **The agent buys data, not pages.** In the Claude Code CLI, over our MCP server, the agent asks for "3-bed rentals under $2k that changed today". It gets a free quote, then typed JSON. It's charged exactly `records × $0.0015`, only after a successful response, and a retried call with the same idempotency key is never charged twice.
6. **The owner gets paid.** Every charge lands in a double-entry ledger: 80% to the publisher, 20% Spigot commission. Payouts go out as PayPal Payouts batches, weekly or with "Run payout now", and the dashboard shows the batch go from PENDING to SUCCESS.
7. **Fair for buyers.** A buyer can flag a junk record; Claude reviews the claim against the record's history and recommends a credit, which the publisher decides on. Unused balance can be refunded to the original PayPal payment with PayPal Refunds.

The publisher dashboard (built with AG Grid) shows the bot report, the AI's proposals, the dataset editor, earnings by buyer and record type, the ledger and payouts. Every simulated bot, buyer and call in the demo is labelled **SIM**.

### How we built it

- **Backend:** Node.js and TypeScript (Fastify, Zod), Postgres. One writer per piece of state: the crawler owns snapshots, the extractor owns records, the ledger owns money.
- **AI (Claude API):** the schema agent clusters pages into templates, reads JSON-LD and 3 to 5 sample pages, and returns a Zod-validated JSON spec (JSON-LD paths, CSS selectors and a whitelist of transforms), never code. It runs the spec on 20 samples and repairs it up to two rounds. The owner approves before anything is sold. After that, extraction is deterministic code with no model call per page.
- **AI (Claude API):** claims triage. Claude reads a buyer's "junk record" claim with the record's version history and recommends credit or reject; the publisher decides, and only deterministic cases credit automatically.
- **AI (Claude Code + MCP):** our MCP server (Streamable HTTP) exposes `list_datasets`, `describe_dataset`, `quote`, `search_records`, `get_changes`, `get_balance` and `top_up`. In the demo the buyer agent is the Claude Code CLI; any MCP client works. Spend caps are enforced in code, not in the prompt.
- **PayPal:**
  - **Orders v2 (`intent: CAPTURE`)** for top-ups, with the **JS SDK v6** PayPal button and card fields on the buyer portal.
  - **Vault** (`store_in_vault: ON_SUCCESS`) and merchant-initiated orders from the `vault_id` for auto top-up.
  - **Payouts** batches to publishers, net of commission, with crash-safe resubmits keyed on `sender_batch_id`.
  - **Refunds** (partial) of unused balance back to the original capture.
  - **Webhooks** with `verify-webhook-signature` reconcile captures and payout items as events arrive, with polling of Orders and Payouts status as the backup.
  - **Log in with PayPal** for publishers.
  - **`PayPal-Request-Id`** on every money call, so retries never double-charge or double-pay.
  - Only the backend calls PayPal. No language model ever holds PayPal credentials.
- **Money:** a double-entry ledger in Postgres, in micros (1 USD = 1,000,000) so we can charge $0.0015 per record. Every transaction must balance to zero, and every money event has an audit row with its PayPal IDs.
- **Render:** hosts the API, the web app, the demo site and a paid Postgres from one `render.yaml` blueprint. The crawl fan-out (`crawlSite → fetchPage × N → extractPage`) and the payout run are written as Render Workflows tasks; for the demo they run in-process in the API service (`WORKFLOWS_MODE=inproc`), with the same task code.
- **AG Grid:** the publisher dashboard; the records grid builds its columns from the approved schema.
- **Frontend:** React (Vite) for the publisher dashboard and buyer portal; the buyer API is described by an OpenAPI 3.1 file generated from our Zod schemas.
- **Demo site:** "Bluebonnet Rentals", a fictional Austin rentals site (Express + EJS, JSON-LD on listing pages) with `spigot-gate` installed, and a script that changes prices so the next crawl produces real changes.

### Challenges we ran into

- **Micropayments don't work per request.** PayPal's fixed fee per capture is far more than a $0.0015 record. We moved to a prepaid balance, an internal double-entry ledger and batched payouts, so PayPal moves real money a few times and the ledger meters the rest.
- **Charging agents fairly.** Agents retry. We charge only after a successful response is built, keyed by an idempotency key, and we test that concurrent retries charge exactly once.
- **Keeping the AI off the hot path.** Calling a model on every page would be slow, costly and non-deterministic. Having Claude write a validated extractor spec once, check it on samples and repair it, then running it as plain code, took several prompt and schema iterations.
- **The buyer agent can't use PayPal's agent tools directly.** The PayPal Agent Toolkit and MCP server run on the merchant's credentials; handing them to a buyer's agent would hand it our merchant account. Our MCP `top_up` tool asks the backend to create the order instead.
- **No visitor capture.** We crawl the owner's public pages directly with a secret header and never record what visitors' browsers see, so nobody can poison the data and we never resell personal browsing.

### Accomplishments that we're proud of

- The whole loop works end to end in the PayPal sandbox: crawl → AI-proposed schema → owner approves → buyer tops up with PayPal → Claude Code pays for a query over MCP → ledger charge → PayPal Payouts to the publisher.
- Zero AI calls per page or per API request after approval.
- A ledger that balances to zero after every demo run, with PayPal IDs on every money row.
- An honest product: we say clearly what it doesn't do (below).

### What we learned

- The right customer isn't news sites, who already get licensing deals. It's long-tail sites with structured data (listings, directories, events), where scrapers already prove the demand.
- Facts like prices aren't copyrightable, so the pitch isn't "now it's legal". It's "now it doesn't break, it's fresher, and it's cheaper than scraping".
- PayPal's building blocks (Orders, Vault, Payouts, Refunds, Webhooks) cover a full two-sided marketplace once you put a ledger in the middle.

### Honest limits

- Spigot gates **declared** bots. Stealth scrapers using residential proxies and fake browser user agents are not stopped; we make paying cheaper and better than evading.
- For factual data the "license" is a contract, not copyright.
- In the demo, Spigot is the merchant of record. In production the publisher would be the merchant through PayPal multiparty (partner onboarding), which also covers the rules for holding prepaid balances.
- The demo site is fictional. Simulated traffic, buyers and calls are labelled SIM.

### What's next for Spigot

- **Web Bot Auth**: verify signed agents (RFC 9421 drafts) so paying agents are identifiable and can't be spoofed.
- **PayPal multiparty** with `platform_fees`, so the publisher is the merchant and is paid directly.
- **PayPal Subscriptions** for flat-rate change-feed plans.
- A **WordPress plugin** for the gate, so non-developers can install it in one click.
- Talking to real directory and listings owners and agent builders to price it properly.

### About this submission

Spigot is a new repository built during the hackathon (Nov 11–12, 2026). It's our team's **second, substantially different** submission; our other one is **Holdfast** (a private bidding book for brand overstock backed by PayPal authorization holds). The two share no product, UI or user: Holdfast is about agents buying goods, Spigot is about websites selling data to agents.

## Built With

paypal-orders-v2, paypal-vault, paypal-payouts, paypal-refunds, paypal-webhooks, paypal-js-sdk-v6, log-in-with-paypal, claude-api, claude-code, mcp, render, ag-grid, node.js, typescript, postgresql, fastify, react

## Try it out (links)

- Live demo (publisher dashboard `/app` + buyer portal `/buyers`): [[fill]] APP_URL
- Demo site with the gate installed: [[fill]] DEMO_SITE_URL
- Public catalog (where every 402 points): [[fill]] CATALOG_URL
- Source code (MIT): https://github.com/Nemil21/spigot

## Video demo link

[[fill]] VIDEO_URL

## Testing access (for judges)

Sandbox only; no real money moves. Full setup is in the README ("Setup" and "Test accounts").

- Demo **publisher** ("Bluebonnet Rentals (demo)") at `<APP_URL>/app`: `owner@bluebonnet-rentals.example.com`, password: *(paste the one `seed:demo` printed for the deploy; private field only)*
- Demo **buyer** ("Acme Agents (demo)") at `<APP_URL>/buyers`: `acme@acme-agents.example.com`, password: *(paste from `seed:demo`; private field only)*
- PayPal sandbox **buyer** (Personal) for approving a wallet top-up: *(paste the sandbox Personal account email and password; private field only)*. Or pay with a sandbox test card, e.g. Visa 4111 1111 1111 1111, any future expiry.
- MCP from Claude Code: create an API key on the buyer portal, then follow README "Use it from Claude Code (MCP)" with `https://<APP_URL host>/mcp`.
- Note for judges: `demo:reset` between our recording takes rotates the demo buyer's API key, so create your own key on the buyer portal rather than reusing one from the video.
