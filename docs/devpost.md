# Spigot: Devpost draft

Working copy of the Devpost submission text for Spigot (SP-045). Edit it here, then paste each section into the matching Devpost field. Everything above **"Paste into Devpost"** is for us, not for Devpost.

- Hackathon: PayPal AI Hackathon 2026. Deadline **Nov 12, 12:00 PST (01:30 IST Nov 13)**; we submit at **10:00 PST (23:30 IST)**.
- Save the Devpost draft by **19:00 IST** (spec deadline 08:00 PST = 21:30 IST). Pasting needs the human's Devpost account (INDEX §Time budget point 7).
- This is our **second** submission. Holdfast is the other. Spigot leads **Most Impactful** and **Best Use of PayPal + AI**; Holdfast leads Agentic Commerce and Most Creative.
- Never open with "402 + PayPal". Open with the owner's problem.

## Freeze read-through (do this at code freeze, 18:00 IST)

Read the draft against what actually shipped. Delete or soften any sentence whose ticket did not merge, and untick any "Built With" entry or sponsor that wasn't used for real. Lines marked `[P1 …]` in the draft are claims that depend on P1 work; remove the marker if it shipped, or the whole sentence if it didn't.

| Claim in the draft | Ticket(s) that must have shipped | Shipped? |
|---|---|---|
| Demo site Bluebonnet Rentals, 2,341 / 88 / 40 records | SP-004a | yes (merged) |
| Gate returns 402 to declared bots, fails open, humans pass | SP-006a, SP-006b, SP-008b | |
| Crawler reads the sitemap with `X-Spigot-Key` | SP-009a1, SP-009a2, SP-009b | |
| AI proposes "Listing, Agent, Open House" with schema + extractor | SP-010 (merged), SP-011, SP-012a | |
| Schema agent self-checks and repairs the extractor | SP-012b | |
| Owner hides fields, sets price, publishes | SP-014a, SP-029 | |
| Records, versions, JSON Patch changes feed | SP-013, SP-015 | |
| Buyer REST API, quote, charge only on 2xx, idempotent | SP-016, SP-017a, SP-017b, SP-005 | |
| PayPal top-up (Orders v2 CAPTURE, JS SDK v6 button) | SP-018a, SP-018b, SP-032 | |
| Card fields top-up | SP-063 | |
| Vault + merchant-initiated auto top-up `[P1]` | SP-047a, SP-047b, SP-047c | |
| Payouts batch to publisher, 20% commission | SP-020, SP-021, SP-031 | |
| Refund unused balance `[P1]` | SP-049, SP-050 | |
| Claims + AI claims triage `[P1]` | SP-048a, SP-048b | |
| PayPal webhooks with signature verification | SP-059 | |
| MCP server; Claude Desktop as buyer agent | SP-022a, SP-022b, SP-039b | |
| Drift detection + re-inference `[P1]` | SP-052a, SP-052b | |
| AG Grid dashboard (bots, proposals, earnings, payouts) | SP-024a, SP-027b, SP-028, SP-030b, SP-031 | |
| Hosted on Render; Render Workflows run crawl + payout | SP-040, SP-041a, SP-041b | |
| APIMatic Context Plugin used while coding PayPal | (process; confirm with the builders) | |
| APIMatic SDK from `openapi.yaml` `[P1]` | SP-023, SP-056 | |
| Log in with PayPal `[P1]` | SP-058 | |
| Live URLs, video URL, test accounts | SP-040, SP-046, SP-044b | |

### Built With (tick only what shipped)

Enter these as Devpost "Built With" tags. Remove any that didn't ship.

| Tag | Ship condition |
|---|---|
| `paypal-orders-v2` | top-up works (SP-018a) |
| `paypal-vault` | card/wallet saved for auto top-up (SP-047a) |
| `paypal-payouts` | payout run works (SP-020) |
| `paypal-refunds` | refund unused balance works (SP-049) |
| `paypal-webhooks` | webhook handler + signature verify (SP-059) |
| `paypal-js-sdk-v6` | buyer portal button (SP-032) |
| `claude-api` | schema agent (SP-012a) |
| `claude-desktop` | buyer agent demo (SP-039b) |
| `mcp` | MCP server (SP-022a) |
| `render` | deployed (SP-040) |
| `render-workflows` | crawl or payout runs as a Workflow (SP-041a/b) |
| `ag-grid` | dashboard grids (SP-024a+) |
| `apimatic` | Context Plugin used, or SDK generated (SP-056) |
| `node.js`, `typescript`, `postgresql` | always |

### Sponsors to tick on the form

- **Render**: only if deployed on Render and at least one Render Workflow runs.
- **AG Grid**: only if the dashboard grids shipped.
- **APIMatic**: only if the PayPal Context Plugin was really used while coding, or the SDK was generated.
- Nothing else (Elastic, KERNEL, Bryntum, Channel3, Zapier, Postman, Astropods: not used).

### Fill in before pasting

- `<DEMO_SITE_URL>`, `<APP_URL>`, `<CATALOG_URL>`: Render URLs (SP-040).
- `<REPO_URL>`: https://github.com/Nemil21/spigot
- `<VIDEO_URL>`: YouTube URL (SP-046).
- Test accounts: copy from the README "Test accounts" section (SP-044 / SP-044b). Sandbox only, never real credentials.

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
2. **The AI finds the data.** Spigot crawls the site's public pages from its sitemap. Claude reads a few sample pages from each layout and proposes record types: on our demo site it finds **Listing (2,341), Agent (88) and Open House (40)**, with fields and sample rows. It also writes the extractor for each one, runs it on 20 samples, checks the results and repairs its own mistakes. It flags personal data such as phone numbers.
3. **The owner approves.** The owner hides `phone`, sets **$1.50 per 1,000 records** and clicks Publish. From then on the extractor is plain code: **zero AI calls per page**. Every re-crawl turns into versioned records and a changes feed (JSON Patch), so buyers can ask "what changed today?".
4. **Agents pay with PayPal.** An agent builder gets an API key and tops up a prepaid balance with PayPal (Orders v2, JS SDK v6 button). [P1 SP-047: The payment method is saved in PayPal Vault, so when the agent runs low mid-task Spigot tops it up automatically, inside a monthly cap the human set.]
5. **The agent buys data, not pages.** In Claude Desktop, over our MCP server, the agent asks for "3-bed rentals under $2k that changed today". It gets a free quote, then typed JSON. It's charged exactly `records × $0.0015`, only after a successful response, and a retried call with the same idempotency key is never charged twice.
6. **The owner gets paid.** Every charge lands in a double-entry ledger: 80% to the publisher, 20% Spigot commission. Payouts go out as PayPal Payouts batches, weekly or with "Run payout now", and the dashboard shows the batch go from PENDING to SUCCESS.
7. [P1 SP-048/SP-049: **Fair for buyers.** A buyer can flag a junk record; Claude reviews the claim against the record's history and recommends a credit. Unused balance can be refunded to the original PayPal payment with PayPal Refunds.]

The publisher dashboard (built with AG Grid) shows the bot report, the AI's proposals, the dataset editor, earnings by buyer and record type, the ledger and payouts. Every simulated bot, buyer and call in the demo is labelled **SIM**.

### How we built it

- **Backend:** Node.js and TypeScript (Fastify, Zod), Postgres. One writer per piece of state: the crawler owns snapshots, the extractor owns records, the ledger owns money.
- **AI (Claude API):** the schema agent clusters pages into templates, reads JSON-LD and 3 to 5 sample pages, and returns a Zod-validated JSON spec (JSON-LD paths, CSS selectors and a whitelist of transforms), never code. It runs the spec on 20 samples and repairs it up to two rounds. The owner approves before anything is sold. After that, extraction is deterministic code with no model call per page.
- **AI (Claude Desktop + MCP):** our MCP server exposes `describe_dataset`, `quote`, `search_records`, `get_changes`, `get_balance` and `top_up`. Claude Desktop is the buyer agent. Spend caps are enforced in code, not in the prompt.
- **PayPal:**
  - **Orders v2 (`intent: CAPTURE`)** for top-ups, with the **JS SDK v6** PayPal button on the buyer portal.
  - [P1 SP-047: **Vault** (`store_in_vault: ON_SUCCESS`) and merchant-initiated orders from the `vault_id` for auto top-up.]
  - **Payouts** batches to publishers, net of commission, with crash-safe resubmits keyed on `sender_batch_id`.
  - [P1 SP-049: **Refunds** (partial) of unused balance back to the original capture.]
  - **Webhooks** with `verify-webhook-signature` to reconcile captures and payout items, with polling as a backup.
  - **`PayPal-Request-Id`** on every money call, so retries never double-charge or double-pay.
  - Only the backend calls PayPal. No language model ever holds PayPal credentials.
- **Money:** a double-entry ledger in Postgres, in micros (1 USD = 1,000,000) so we can charge $0.0015 per record. Every transaction must balance to zero, and every money event has an audit row with its PayPal IDs.
- **Render:** hosts the API, the web app, the demo site and a paid Postgres. **Render Workflows** run the crawl fan-out (`crawlSite → fetchPage × N → extractPage`) and the payout run.
- **AG Grid:** the publisher dashboard; the records grid builds its columns from the approved schema.
- **APIMatic:** we used the PayPal Context Plugin while writing the Orders, Payouts and Refunds code. [P1 SP-056: We also generated a TypeScript SDK for buyers from our `openapi.yaml`.]
- **Demo site:** "Bluebonnet Rentals", a fictional Austin rentals site (Express + EJS, JSON-LD on listing pages) with `spigot-gate` installed, and a script that changes prices so the next crawl produces real changes.

### Challenges we ran into

- **Micropayments don't work per request.** PayPal's fixed fee per capture is far more than a $0.0015 record. We moved to a prepaid balance, an internal double-entry ledger and batched payouts, so PayPal moves real money a few times and the ledger meters the rest.
- **Charging agents fairly.** Agents retry. We charge only after a successful response is built, keyed by an idempotency key, and we test that concurrent retries charge exactly once.
- **Keeping the AI off the hot path.** Calling a model on every page would be slow, costly and non-deterministic. Having Claude write a validated extractor spec once, check it on samples and repair it, then running it as plain code, took several prompt and schema iterations.
- **The buyer agent can't use PayPal's agent tools directly.** The PayPal Agent Toolkit and MCP server run on the merchant's credentials; handing them to a buyer's agent would hand it our merchant account. Our MCP `top_up` tool asks the backend to create the order instead.
- **No visitor capture.** We crawl the owner's public pages directly with a secret header and never record what visitors' browsers see, so nobody can poison the data and we never resell personal browsing.

### Accomplishments that we're proud of

- The whole loop works end to end in the PayPal sandbox: crawl → AI-proposed schema → owner approves → buyer tops up with PayPal → Claude Desktop pays for a query over MCP → ledger charge → PayPal Payouts to the publisher.
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

paypal-orders-v2, paypal-vault, paypal-payouts, paypal-refunds, paypal-webhooks, paypal-js-sdk-v6, claude-api, claude-desktop, mcp, render, render-workflows, ag-grid, apimatic, node.js, typescript, postgresql

## Try it out (links)

- Live demo (publisher dashboard + buyer portal): `<APP_URL>`
- Demo site with the gate installed: `<DEMO_SITE_URL>`
- Public catalog (where every 402 points): `<CATALOG_URL>`
- Source code (MIT): `<REPO_URL>`

## Video demo link

`<VIDEO_URL>`

## Testing access (for judges)

Sandbox only; no real money moves. Full setup and accounts are in the README.

- PayPal sandbox **buyer** (Personal) login for the top-up: `<from README>`
- Demo **publisher** login for the dashboard: `<from README>`
- Claude Desktop MCP config: README "Use it from Claude Desktop".
