# 15 — gstack stress test: publisher data API ("Spigot"), v1 → v3

> Local working doc (2026-11-10). This is an adversarial review of idea 2, "publishers add our tag, we turn their site into a paid API, scrapers must pay through our SDK", using Garry Tan's gstack. The questions were re-read from a read-only shallow clone of https://github.com/garrytan/gstack:
> - **Business:** `office-hours/sections/phase-2a-startup-diagnostic.md` (Q1–Q6), `phase-2b-builder-brainstorm.md`, `plan-ceo-review/SKILL.md` (premise check, 10x check, "scrap it?").
> - **Engineering:** `plan-eng-review/sections/review-sections.md` (Scope Challenge, architecture, design-twice and the eight red flags, failure modes, tests, performance).
>
> Ratings: **Strong**, **Weak**, **Fails**. **UNVERIFIED** marks anything not confirmed by a primary source. "Spigot" is a working name.

## Takeaways first

- **v1 fails on four counts.**
  1. A JS tag can't block anyone, because the HTML ships before any JS runs.
  2. Capturing pages from visitors' browsers invites US wiretap class actions.
  3. Big news publishers (Times of India, Al Jazeera type) already sell to AI labs directly. OpenAI–TOI is reported at about $5M a year.
  4. "Agent pays per request with PayPal" is already a polished entry in this hackathon (`Bortlesboat/paypal-402`).
- **What survives is a real gap.** Nobody gives a site owner **typed endpoints + a change feed + payment** from the publisher's side:
  - Firecrawl, Diffbot and Apify all work from the scraper's side.
  - NLWeb, llms.txt and Cloudflare Markdown have no payment.
  - TollBit and Cloudflare sell access to pages, settled in stablecoins or through their own networks.
- **The right customer isn't news. It's long-tail sites with structured data**: directories, classifieds, listings, event and ticket inventory, local data. That's where scraper demand is (Apify's top actor: Google Maps, about 426K users, about $2.10 per 1,000 places, third-party figure), and big content deals don't reach those sites.
- **The pitch moves from "now it's legal" to "now it doesn't break, and it's cheaper than scraping."** Facts like prices aren't copyrightable, and logged-off scrapers aren't bound by a site's terms (Meta v. Bright Data). The license is a contract and a convenience, not the reason anyone pays.
- **Verdict: conditional GO as a *separate* submission with its own owner.** It's weaker than Standing Orders on demand evidence, stronger on "every developer gets it in 10 seconds." Don't let it pull people off Standing Orders before the money path works (Nov 11, 12:00 PST).

---

## v1 as pitched

Publishers (Times of India, Al Jazeera, any data site) add our JS tag. We scrape and keep an ever-updating API of every page as a tree, and turn dynamic pages into proper APIs. Scrapers hit our firewall and must use our SDK to pay. The publisher earns, we take a commission, the buyer gets the data legally. Payments run on PayPal's agentic layer.

---

## Fact-check summary (full notes and URLs: research agents, 2026-11-10)

### Publisher side
- AI bots grew from about 1 per 200 human visits to **1 per 31** in Q4 2025. Click-through from AI apps fell to 0.27%. AI apps sent 0.12% of referrals, against Google's 80.5%. [TollBit, 2026-04-13](https://tollbit.com/blog/scraper-index-and-audit/)
- **Licensing money is concentrated.** OpenAI has about 35 publisher deals, and Microsoft's marketplace launched with 8 invited publishers. "Licensing revenue remains concentrated among a relatively small group of publishers." [DCN, 2026-06](https://digitalcontentnext.org/blog/2026/06/09/mapping-publisher-value-in-the-ai-marketplace/)
- Reported deals: Amazon–NYT $20–25M a year; OpenAI–News Corp over $250M across 5 years; OpenAI–TOI about $5M a year (UNVERIFIED, [exchange4media](https://www.exchange4media.com/digital-news/openais-toi-ie-deals-spark-wider-interest-among-news-publishers-158488.html)).
- **Blocking is already free.** Cloudflare has blocked AI crawlers by default since July 2025. [Cloudflare](https://blog.cloudflare.com/content-independence-day-ai-options/)

### Buyer side
- **Buyers pay scrapers, not publishers.** Bright Data reports over $300M ARR, and 14 of the top 20 LLM labs use it ([Bright Data](https://brightdata.com/blog/general/data-for-ai-is-fueling-massive-growth-at-bright-data)). Exa raised at $2.2B, and Nebius bought Tavily for $275M plus milestones.
- **Price ceiling for a raw page is fractions of a cent** (Firecrawl works out to about $0.0006–0.005 per page). Per-*record* structured data sells for more (Google Maps actor about $2.10 per 1,000 places).
- No evidence that agent builders voluntarily pay long-tail publishers.

### Competitors
| Product | How it blocks | How it pays | Gap we use |
|---|---|---|---|
| Cloudflare Pay per Crawl / AI Index | Edge 402 (Cloudflare zones only) | Fiat via Cloudflare / x402 stablecoins | Private beta; raw pages; Cloudflare-only |
| AWS WAF AI monetization (2026-06-15) | WAF 402 | x402 via Coinbase, stablecoins | Crypto wallet required |
| TollBit (about 7,000 sites, "Agent Site", MCP) | CDN/WAF redirect to TollBit | Fiat | Content focus, no typed records or change feed |
| Skyfire, Supertab | Signed tokens / Fastly | Own rails | Infrastructure for big sites |
| NLWeb, llms.txt, Cloudflare Markdown for Agents | None | None | No payment, no typed schema |
| Firecrawl, Diffbot, Apify, Bright Data | Scraper side | Buyer pays them | Publisher earns nothing; breaks on layout changes |

### Crowding in this hackathon (`gh search repos`, created after 2026-09-01)
- **[Bortlesboat/paypal-402](https://github.com/Bortlesboat/paypal-402)**: Express 402 middleware, PayPal Vault agent wallet with spend policy, Claude agent, 38 tests. Strongest competitor on the *payment* mechanic.
- **[entitySource/agent-tab](https://github.com/entitySource/agent-tab)**: 402 metered tab on vaulted PayPal, batched capture. Same as our prepaid balance.
- Others: `Manu2954/x402-paypal`, `liutingqiu/paypal-agentic-checkout-sdk`, `jamesparser/paypal-commerce-mcp`.
- Non-PayPal crawler paywalls (USDC): forgemeshlabs pay-per-crawl suite, `flavioricardo/ai-bot-paywall-wordpress`, `P2Flux/agent-paywall`.
- Website-to-API: `adibfarah/agenticweb` (publisher-side, no payment); `vexdzphone911-max/site-to-api`, `jatinag22/site-to-api` (scraper-side).
- **No repo combines a publisher-side typed API, a change feed and PayPal settlement.** → Don't lead with "402 + PayPal". Lead with the publisher-side data API.

### Legal (not legal advice)
- Meta v. Bright Data: logged-off scrapers aren't bound by the site's terms. Google v. SerpApi: anti-circumvention claims dismissed in July 2026. → A 402 wall doesn't *force* anyone legally.
- Thomson Reuters v. ROSS (3d Cir., 2026-09-29): no fair use, and the court recognized a market for licensing AI training data. That helps for *content*, but it's narrow.
- Only the rights holder can license. Wire copy (AP/Reuters) on a publisher's page usually can't be sublicensed. Facts (prices, scores, listings) aren't copyrightable, so for data sites the "license" is a contract.
- **Visitor capture is the worst exposure.** Session-replay wiretap suits are live (Third Circuit found standing in May 2026; federal statutory damages up to $10,000; [Barnes & Thornburg](https://btlaw.com/en/insights/alerts/2026/cipa-ecpa-website-tracking-privacy-litigation-in-2026)). CNIL's draft says consent will "often" be needed. Reselling what visitors' browsers captured is the worst case.

### PayPal constraints
- Micropayments pricing (4.99% + $0.09, third-party sources; requires applying, whole account) still kills per-request captures. → **Prepaid balance and an internal ledger.**
- Payouts cost about 2% with a disputed cap. → **Batch publisher payouts** with a minimum threshold.
- Only the payee's app can create an order (noted by paypal-402). → **We are merchant of record** in the demo; production uses PayPal multiparty (partner onboarding).
- No PayPal x402 or "agent pay" product announced in 2026. The Agent Toolkit has orders, invoices, subscriptions and refunds, but no per-request primitive and no Payouts.

---

## Round 1 — Q1 Demand Reality, Q2 Status Quo, Q3 Desperate Specificity

| Q | v1 (news publishers) | Rating |
|---|---|---|
| **Q1 Demand** | Publishers are angry (1 bot per 31 humans), but the ones with valuable content already get paid directly or block for free. Buyers show no evidence of paying long-tail publishers. | **Fails** for news |
| **Q2 Status quo** | Publishers: Cloudflare default block (free), TollBit, direct deals. Buyers: Bright Data, Firecrawl, Apify at fractions of a cent per page. | **Weak**: free blocking plus cheap scraping |
| **Q3 Specificity** | "Times of India" is a logo, not a person. Their head of digital revenue already has an OpenAI contract. | **Fails** |

**Reframe after Round 1.** Look for an owner whose data is *scraped heavily*, *structured*, and *not covered by big deals*:

> **The owner or CTO of a 5–50 person directory, classifieds or listings site** (local services directory, used-equipment marketplace, event listings, niche real-estate or job board). There are public Apify actors scraping their site. Bot traffic is a real line on their hosting bill. Blocking breaks nothing for them, but earns nothing either. What gets them promoted: a new revenue line that isn't ads. What keeps them up at night: a competitor republishing their listings, and the AWS bill.

| Q | v2 (structured-data owner) | Rating |
|---|---|---|
| **Q1** | Scraper demand for this data is proven by scraper revenue (Apify's top actors are maps, listings and search). Willingness to pay the *owner* is still unproven. | **Weak → plausible** |
| **Q2** | Buyers today pay for proxies, headless browsers and maintenance whenever a layout changes. Owners pay for bandwidth and earn nothing. | **Strong**: both sides pay a "scraping tax" |
| **Q3** | Named persona above. | **Strong** |

## Round 2 — Q4 Narrowest Wedge, Q5 Observation, Q6 Future-Fit

**Q4 wedges (1–5 each: demand, buildable by Nov 12, demo clarity, PayPal depth, uncrowded; 25 max)**

| Wedge | D | B | Demo | PP | Unc. | Total |
|---|---|---|---|---|---|---|
| A. 402 paywall for news pages (v1) | 1 | 4 | 3 | 3 | 1 | 12 |
| B. "Pay through PayPal" 402 middleware for any API | 2 | 5 | 3 | 4 | 1 | 15 |
| **C. Structured-data site → typed API + change feed, bots routed and billed, PayPal in and out** | 3 | 3 | 5 | 5 | 4 | **20** |
| D. Bot analytics only ("who scrapes you, what it costs") | 3 | 5 | 3 | 1 | 2 | 14 |

**C wins**, with D folded in as the free first step: the owner gets value before a single buyer exists. That answers gstack's bonus question, "What if the user didn't have to do anything at all to get value?":
- install once, and see the bot report immediately;
- our cache serves bots, cutting bandwidth at once;
- revenue comes later.

**Q5 Observation: Fails, as for every idea so far.** We haven't watched one site owner or one agent builder. Assignment below.

**Q6 Future-Fit: Strong.** Agent traffic only grows, layout-breaking scrapers only get more expensive, and Web Bot Auth (RFC 9421 drafts; ChatGPT agent already signs with `Signature-Agent`) makes paying agents *identifiable*. That's the precondition for charging them. The risk is the opposite: Cloudflare and AWS make this a checkbox for big sites. Long-tail sites on a $20 VPS are where they don't reach.

## Round 3 — Premise, do-nothing, proxy vs direct, Search Before Building, CEO 10x, "scrap it?"

- **Is this the right problem?** v1 targeted "scrapers take content." The deeper problem is that **the same data gets extracted badly thousands of times, at a cost to both sides.** One clean, owner-sanctioned extraction sold many times beats N brittle scrapes. That's the eureka: **the publisher's own copy is the best scraper there is.**
- **Do nothing:** owners keep paying bandwidth for free, and buyers keep paying Bright Data. Painful but survivable. Expect slow adoption: this is a "vitamin with a bill attached."
- **Proxy vs direct:** v1's "block them" is a proxy. Blocking doesn't make money, it just stops traffic, and stealth scrapers get through anyway. The direct fix is **a better product for the buyer**, so paying beats evading.
- **Search Before Building:**
  - **Layer 1 (tried and true):** schema.org/JSON-LD already on many pages; ETag/304; sitemaps and IndexNow; JSON Patch; verified-bot IP lists.
  - **Layer 2 (new and popular):** x402 headers, Web Bot Auth, NLWeb, MCP.
  - **Layer 3 (first principles):** *price records and changes, not pages*. Cloudflare's own finding is that over half of bot crawls re-fetch unchanged pages.
- **CEO 10x check:** Is it 10x better for the buyer than Firecrawl? It's not 10x cheaper per page. It *is* 10x better on:
  - **reliability:** it never breaks on a redesign, because the owner's renderer is the source;
  - **freshness:** a push change feed instead of polling;
  - **and it's legitimate.**

  For the owner it's ∞x, because they currently earn $0.
- **"Scrap it and do this instead?"** We considered pivoting to the buyer side (an agent data wallet). That's crowded (paypal-402, agent-tab). **Keep the publisher-side version.**

## Round 4 — Builder mode ("Delight is the currency")

The delight moment for the demo:
- The owner pastes their URL. Within a minute the AI agent shows: **"I found 3 kinds of records on your site: Listing (2,341), Agent (88), Open House (40). Here's the schema. Price per 1,000 records?"**
- The owner toggles fields (hide phone numbers), sets $1.50 per 1,000, and clicks Publish.
- Moments later, Claude Desktop asks "find 3-bed rentals under $2k near Austin that changed today", gets a 402 quote, pays from its PayPal-funded balance, and gets typed JSON.
- The owner's dashboard ticks up. The scraper that hit the HTML gets a polite 402 pointing to the API.

---

## Engineering review (gstack `plan-eng-review`)

### Step 0 — Scope Challenge
- **What already exists:** PayPal Orders/Vault/Payouts/Subscriptions/Refunds (sandbox-proven in Standing Orders' spikes S1–S4); JSON-LD on many pages; Mozilla Readability; Playwright for rendering; x402 header shapes; Render Workflows for fan-out; AG Grid for the dashboard.
- **Minimum to hit the goal:** one demo site we own, one middleware, one render → extract → API pipeline, one buyer agent, one ledger, one payout. Everything else goes to NOT in scope.
- **Complexity:** about 6 services/modules (gate middleware, crawler/extractor workflow, API + MCP, ledger + PayPal, buyer agent, dashboard). Over the gstack "fewer than 2 new services" bar, so it needs a hard cut list (below).

### Problems in v1 and the fix for each

| # | Problem (v1) | Severity | Fix in v3 |
|---|---|---|---|
| E1 | **A JS tag can't block.** HTML ships before JS; curl and most crawlers never run JS; headless browsers can strip the tag. | Critical | **Blocking lives in origin middleware** (Express/Next) or an edge Worker. The JS tag is dropped from the MVP (optional analytics later). |
| E2 | **Visitor-captured DOM can be forged** (anyone can POST a fake snapshot and poison the API) **and it captures personal or paywalled content** (wiretap liability). | Critical | **No visitor capture.** Our crawler fetches the origin directly with a secret bypass header (`X-Spigot-Key`), only public URLs from the sitemap, and renders in headless Chromium. |
| E3 | **The gate can take the publisher's site down.** If our service is slow or down, every request stalls. | Critical (blast radius) | **Humans never call us.** The middleware classifies locally (UA plus cached verified-bot IP list), with a 50 ms budget, and **fails open** on any error. Only bot requests go to the 402 path, and the 402 body is static. |
| E4 | **Blocking Googlebot kills SEO.** | Critical | Allowlist search crawlers by **reverse-DNS verification** (Googlebot, Bingbot). Training and agent bots (`GPTBot`, `ClaudeBot`, `Google-Extended` token) get the 402. |
| E5 | **Stealth scrapers** (residential proxies, headless browsers) can't be detected by small middleware. | High (honesty) | Don't claim to. Gate **declared and signed bots** (UA, IP ranges, Web Bot Auth). The pitch is *paying is cheaper and better than evading*. |
| E6 | **"Every page as a tree" is noise.** A raw DOM tree isn't an API, and an LLM call per page is slow and costly. | High | **One extractor per page template.** Cluster URLs by template; the AI infers a schema from 3–5 samples, using JSON-LD first; it emits a deterministic CSS/JSON-LD extractor; the owner approves it; it then runs without an LLM. **Drift check:** if field null-rates jump, re-infer and ask the owner. |
| E7 | **"Ever-updating"** means re-crawling everything constantly. | Medium | Sitemap `lastmod`, plus an optional `POST /ping` webhook from the publisher's CMS, plus ETag. Hash each **normalized record** (Merkle per record); emit JSON Patch to `/changes?since=<cursor>`. |
| E8 | **Micropayments are uneconomic per capture.** | High | **Prepaid balance** (Orders v2, $5–$50 top-up, Vault for agent auto top-up within the owner's cap). Double-entry ledger in Postgres; `Idempotency-Key` per API call; **charge only on 2xx**; batched Payouts weekly or over $10. |
| E9 | **Only the payee's app can create a PayPal order**, so we can't route buyer money straight to the publisher. | Medium | **We're merchant of record** in the demo. Publishers are paid via Payouts net of commission. Production path: PayPal multiparty (`platform_fees`), documented in the README. |
| E10 | **Holding balances is stored value / money transmission.** | Medium (production) | Fine for a sandbox demo. Production goes through the PayPal partner route. Called out under Honest limits. |
| E11 | **Rights.** Wire copy and user-generated content can't be sublicensed. | Medium | The owner attests they own selected fields. The AI flags bylines like "Reuters"/"AP" and excludes them by default. Target is factual data sites. |
| E12 | **Paid data gets resold.** | Low (P2) | License terms on each receipt; per-key canary records. Describe it in the README only. |

### Architecture (two shapes, gstack "design-twice")

**Shape A (v1): the tag captures; we scrape; a proxy firewall sits in front.** The publisher's traffic flows through us. Red flags: **split ownership** (both the tag and the crawler write page state), a single point of failure on every human request, forgeable input.

**Shape B (chosen): origin pull + local gate.** One owner per piece of state:
- the **crawler owns snapshots**;
- the **extractor owns records**;
- the **ledger owns money**.

The gate is a deep module with one function, `classify(req) → pass | quote402`, a small surface with all the bot policy hidden inside.

```
 Publisher origin ──(sitemap, ping)──> Render Workflows: crawl → render → extract(template) → diff ──> Postgres (records, versions)
      │                                         ▲ schema approved by owner (AI-proposed)               │
 spigot-gate middleware                         │                                                       ▼
   human ──────────────> pass (local, fail-open)                                   Spigot API: /v1/{type}?q=…  /changes?since=
   declared bot ───────> 402 {price, api_url, terms}                               MCP server: search_records, get_changes, quote
                                                                                                  │ charge per record (ledger)
 Buyer agent (Claude + PayPal Agent Toolkit) ──top-up (Orders v2 + Vault)──> Ledger ──batch──> PayPal Payouts → publisher
                                                └──── stale record? auto-refund (Refunds) ◄── freshness check
```

**Money state machine (ledger entry):** `QUOTED → CHARGED (2xx served) → [REFUNDED if stale]` · payout `ACCRUED → BATCHED → PAID | FAILED → RETRY`.

### Failure modes
| Path | Realistic failure | Handling | User sees |
|---|---|---|---|
| Gate | Our API down | Fail open, log locally | Nothing (humans unaffected) |
| Gate | Googlebot misclassified | Reverse-DNS verify plus a test in CI | — |
| Crawl | Origin rate-limits us | Respect `Retry-After`, concurrency 2 per host | Dashboard "crawl paused" |
| Extract | Redesign breaks the extractor | Null-rate drift → re-infer → owner approves; serve last good version, marked `stale_since` | Buyer gets a `freshness` field |
| Charge | Agent retries the same call | `Idempotency-Key` → same charge | One charge |
| Charge | Balance runs out mid-request | 402 with a top-up link; never serve unpaid | Clear 402 |
| Payout | Publisher email unclaimed or invalid | Payout item FAILED → retry next batch, alert the owner | Dashboard alert |
| Webhook | Our DB write lost after PayPal success | Reconcile from PayPal webhooks (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.*`) | — |

No path above is silent, untested and unhandled, so there's no critical gap. That holds as long as the fail-open gate and the idempotent charge are tested.

### Tests (minimum)
- Unit: `classify()` against a UA/IP fixture table (Googlebot pass, GPTBot 402, human pass, timeout fails open); ledger never goes negative; charge only on 2xx; idempotent charge; record hashing and JSON Patch diff.
- Integration (sandbox): top-up order → balance; 1,000 paid calls → one payout batch; stale record → refund.
- E2E: Claude Desktop over MCP → 402 → paid → typed JSON.

### Performance
- The gate is on every request. It must be local (no network) and add under 1 ms p50. The verified-bot IP list is refreshed hourly in memory.
- The API serves from Postgres with an index on `(site_id, type, updated_at)`, and `/changes` paginates by cursor. Demo scale is about 5k records, which is no concern.

---

## Final spec (v3): Spigot

### Name and pitch
**Spigot: turn your site into a paid API for AI agents.** Bots stop scraping your HTML and buy clean, live records instead. PayPal funds the agents and pays you.
Pitch line: **"Scrapers pay Bright Data. Spigot makes them pay you, and they get better data."**

### Persona
The owner or CTO of a small structured-data site (directory, listings, classifieds, events) being scraped by Apify actors.

### Wedge
Install middleware → **free bot report and bandwidth savings on day 1** → AI proposes a schema → the owner sets a price → agents pay per record or per change.

### Must-have scope (build order)
1. **Demo site we own** (e.g. a fictional "Austin rentals" listings site with JSON-LD; not a real brand) with `spigot-gate` middleware (classify → pass or 402).
2. **Crawl → extract pipeline on Render Workflows:** sitemap → render → AI schema proposal (Claude) → deterministic extractor → records and versions → `/changes` feed.
3. **Ledger and PayPal:** top-up (Orders v2 + Vault), per-record charge, Payouts batch, webhooks reconcile.
4. **API + MCP server:** `quote`, `search_records`, `get_changes`; a 402 for unpaid calls.
5. **Buyer agent demo:** Claude Desktop over MCP, with a PayPal Agent Toolkit top-up within a spend cap.
6. **Owner dashboard (AG Grid):** bots seen, bandwidth saved, earnings per buyer and record type, schema approval, payout status.

### Cut list (cut from the top)
Web Bot Auth signature verification → PayPal Subscriptions for feeds → freshness auto-refunds → Elastic search endpoint → APIMatic-generated SDK per site → canary records → JS tag analytics → multi-site support.

### PayPal APIs used
Orders v2 (top-up) · Vault (agent auto top-up) · Payouts (batched publisher pay) · Refunds (stale data, P1) · Subscriptions (change feed, P1) · Webhooks · Agent Toolkit (buyer agent's top-up and refund tools).

### Sponsors
Render (host + Workflows pipeline) · AG Grid (owner dashboard) · APIMatic (Context Plugin while coding the PayPal path; generated SDK as a stretch) · Elastic (stretch: `/search` endpoint).

### Scores against judging (1–5, honest)
| Criterion | Score | Why |
|---|---|---|
| Tech implementation | 4 | Real pipeline, AI that writes extractors, 5+ PayPal APIs; risk is breadth |
| Design | 3–4 | Dashboard plus the "AI found 3 record types" moment |
| Potential impact | 3 | Clear persona and pain; buyer willingness unproven |
| Innovation | 3–4 | Publisher-side typed API with change feed is new; the 402 part isn't |
| Presentation | 4 | The scraper-gets-402 → agent-pays → owner-earns loop is easy to follow |

### Demo script (≤ 3:00)
| Time | Shot |
|---|---|
| 0:00–0:20 | "1 AI bot visit for every 31 humans. Small sites pay the bandwidth and earn nothing; scrapers pay Bright Data." |
| 0:20–0:50 | Owner installs middleware; dashboard shows bots hitting the site |
| 0:50–1:20 | AI proposes the Listing schema; owner hides phone numbers, sets the price, publishes |
| 1:20–1:40 | A Python scraper gets a 402 with the price and the API link |
| 1:40–2:20 | Claude Desktop: "3-beds under $2k that changed today" → quote → pays from its PayPal-funded balance → typed JSON |
| 2:20–2:40 | Payout batch lands in the sandbox publisher account; ledger rows shown |
| 2:40–3:00 | Architecture slide (PayPal APIs, Render Workflows, AG Grid); honest limits; what's next |

### Honest limits (put these in the README)
Stealth scrapers aren't stopped. A license for factual data is a contract, not copyright. We're merchant of record in the demo (production: PayPal multiparty). Holding balances needs the partner route in production. The demo site is fictional.

### Top risks
1. **Scope:** 6 modules in about 36 hours. Mitigation: the cut list, and reuse Standing Orders' PayPal client.
2. **Buyer demand unproven.** Mitigation: Q5 assignment, and price below scraper all-in cost.
3. **Looks like paypal-402 at a glance.** Mitigation: never open with "402 + PayPal". Open with the owner's dashboard and the AI schema moment.

### Go / no-go
**Conditional GO** as a second submission, if and only if a dedicated owner can start tonight and Standing Orders' owners stay on Standing Orders. Kill criterion: if the crawl → extract → paid MCP call loop isn't working by **Nov 11, 18:00 PST**, stop and fold the effort back into Standing Orders.

### Assignment (gstack: end with the assignment)
1. Before building, message 2 owners of small directory or listings sites (find them via public Apify actors that scrape them) with: "Would you take money from scrapers instead of blocking them?" Record the answers verbatim.
2. Ask 2 agent builders: "Would you pay $1.50 per 1,000 clean, live records instead of running a scraper?"
3. Put any surprises in this doc before recording the video.
