# Screen Inventory (Web W01–W16, Demo site D01–D04)

Every screen lists: features, priority, components, states, interactions.
Shared states everywhere: **Loading** = skeletons (never spinners on money numbers). **Error** = inline banner with retry. **Empty** = a short sentence + one action.
No native mobile app. The publisher dashboard targets ≥ 1024 px; the buyer portal, catalog page, 402 page and landing page are responsive down to 375 px.

**Money copy rule:**
- "**charged**" only after a 2xx response was built and the ledger posted;
- "**credited**" for a junk-data claim back to the balance (no PayPal call);
- "**refunded to PayPal**" only after a PayPal Refund completed;
- "**sent**" when a payout item is PENDING; "**paid out**" only on SUCCESS; "**waiting for you to claim**" for UNCLAIMED.
- Name PayPal on every money moment ("Top up with PayPal", "Paid out via PayPal").
- Show prices per 1,000 ("$1.50 / 1,000 records") and the actual charge with enough decimals ("$0.0555").

## Publisher web

### W01 Landing (P1)
- **Features:** 16
- **Components:** nav; hero ("Turn your site into a paid API for AI agents" + "Scrapers pay Bright Data. Spigot makes them pay you."), 2 CTAs (Connect your site, I'm an agent builder); the stat line "1 AI bot for every 31 human visits"; how-it-works 4 steps (Install → See your bots → Approve the schema → Get paid via PayPal); a mini proposal card visual; "for agents" block (MCP config, sample JSON); honest-limits strip; footer.
- **States:** static.
- **Interactions:** CTA → W02 or W11.

### W02 Sign up + connect site (P0)
- **Features:** 03, 14
- **Components:** 2-step card: (1) account (name, email, password, **PayPal payout email** with "This is where PayPal Payouts send your earnings"); (2) site URL input with live origin check (reachable, has sitemap).
- **States:** default; checking origin; origin unreachable ("We couldn't reach that site"); no sitemap ("Add a sitemap.xml or enter one"); success → W03.
- **Interactions:** submit; edit sitemap URL.

### W03 Install the gate + verify (P0)
- **Features:** 02, 03
- **Components:**
  - 3-step stepper: Verify → Install gate → First crawl;
  - verify box: file path + content with copy, "Check now" with status pill;
  - install box: `npm i @spigot/gate` + 3-line Express snippet, env vars (`SPIGOT_GATE_KEY`, `SPIGOT_CRAWL_KEY`) shown once with copy;
  - live "Gate status" pill (Waiting for first hit → Installed · last hit 4 s ago);
  - "Fails open: if Spigot is down, your site keeps working" note;
  - "Start first crawl" button → progress bar (pages found / fetched).
- **States:** pending verify; verified; gate not seen yet; gate seen; crawling; crawl failed (reason + retry); done → W05.
- **Interactions:** copy, check, start crawl.

### W04 Overview / bot report (P0)
- **Features:** 02, 13
- **Components:**
  - left nav (Overview, Record types, Earnings, Payouts, Crawls, Settings);
  - KPI row: Bot visits (7 d), "1 bot per N human visits", Bots sent to your API (402s), Bandwidth avoided (est.), **Earned this week** (with "incl. $X SIM" on hover);
  - stacked area chart (AG Charts) of hits by category over time;
  - **AG Grid "Who's crawling you"**: bot name, category, hits, decision (Passed / Sent to API), last seen, "would have paid" estimate; SIM chip;
  - activity feed (proposal ready, call charged, payout sent).
- **States:** empty ("Install the gate to see who's crawling you" → W03); gate installed but no bots yet; live (SSE row flash); unverified banner.
- **Interactions:** filter by category, toggle "include simulated", open bot row → detail drawer (sample paths, decisions).

### W05 Record types found (P0, hero)
- **Features:** 04, 13
- **Components:**
  - headline written by the agent: **"I found 3 kinds of records on your site"**;
  - one card per proposal: type name, record count ("Listing · 2,341"), URL pattern, source badge ("JSON-LD" / "CSS"), 4 key fields preview, field quality bar (null rates), suggested price, "Review" button;
  - "How this works" note: "Claude wrote the extractor once. It now runs with no AI on each page.";
  - agent rationale (expandable).
- **States:** proposing (cards stream in with a "reading 5 sample pages…" line per template); ready; one proposal failed ("Couldn't find consistent fields on /blog/*; skipped"); no proposals (site has no repeated structure).
- **Interactions:** Review → W06; Reject proposal.

### W06 Dataset editor + publish (P0)
- **Features:** 04, 06, 13
- **Components:**
  - field list: name, type, example, null rate, **visible toggle**, PII badge (phone/email auto-hidden), rights flag ("Byline 'AP' found: excluded by default"), filterable chips;
  - **AG Grid sample rows** (20 rows, columns generated from the schema; hidden fields shown struck-through and greyed);
  - price inputs: per 1,000 records, per 1,000 changes; live line "A buyer pulling all 2,341 listings pays $3.51; you get $2.81 after Spigot's 20%";
  - endpoint preview (`GET /v1/bluebonnet/datasets/listings/records?bedrooms[gte]=3`) with sample JSON;
  - rights attestation checkbox;
  - Publish button.
- **States:** editing; saving new version; validation (no visible fields; rights not ticked); publishing (extracting all pages: progress); live (endpoint copy + "Your gate now sends bots here"); stale (drift banner, P1).
- **Interactions:** toggle fields, edit price, publish, unpublish.

### W07 Records browser (P1)
- **Features:** 05, 13
- **Components:** AG Grid server-side row model over `records` (schema columns, version, last changed, freshness); side drawer with version history (JSON Patch diff view).
- **States:** empty; live; stale dataset banner.
- **Interactions:** filter, sort, open history.

### W08 Earnings (P0)
- **Features:** 07, 13
- **Components:**
  - KPI tiles: Gross, Spigot commission (20%), **Your earnings**, Payable now, Records sold, Buyers;
  - bar chart earnings per day by dataset;
  - **AG Grid** grouped by buyer and dataset: calls, records, changes, gross, net; SIM chip; row flash on new charges;
  - ledger tab: txn rows (kind, memo, amount, PayPal id link).
- **States:** empty ("No buyers yet. Your API is live at …"); live; includes SIM (toggle).
- **Interactions:** group/filter, export CSV, open call detail.

### W09 Payouts (P0)
- **Features:** 09
- **Components:**
  - card: "Next PayPal payout Monday · $412.75 payable · threshold $10";
  - "Run payout now" (demo publisher only, labelled "demo control");
  - payouts table: batch date, amount, PayPal batch id, item id, status pill (Sent / Paid out / Waiting for you to claim / Failed → retrying next batch);
  - statement drawer: period, records sold, gross, commission, net, rounding carried forward.
- **States:** none yet; sent (PENDING, polling); paid out; unclaimed (warn: "Log in to PayPal with publisher@… to claim"); failed (reason, retry next batch).
- **Interactions:** run now (confirm modal with numbers), open statement, change payout email (→ settings, applies to the next batch).

### W10 Crawls & health (P1)
- **Features:** 03, 04
- **Components:** crawl runs table (trigger, pages fetched / not modified / failed, records added/updated/removed, **AI calls: 0**, duration); drift alerts; "Crawl now".
- **States:** running (progress); paused (origin rate-limited); failed.
- **Interactions:** crawl now, open run.

### W16 Settings (P0 minimal)
- **Features:** 02, 09, 14
- **Tabs:** Account; Payout (PayPal email; P1 "Connect with PayPal"); Gate policy (per-category Pass / Send to API toggles, gated paths); Keys (rotate gate and crawl keys).
- **States:** saved toast; validation errors.

## Buyer web

### W11 Buyer portal: keys, balance, top-up (P0)
- **Features:** 08, 11, 14
- **Components:**
  - balance hero ("$19.94 balance" with micros tooltip);
  - **Top up with PayPal**: amount chips ($5, $20, $50), JS SDK v6 PayPal button; "Save for auto top-up" checkbox;
  - auto top-up card (P1): threshold, amount, monthly cap, saved method ("PayPal · sb-buyer@…" or "Visa ••1111"), remaining this month;
  - API keys table (create, one-time reveal, revoke);
  - "Connect Claude Desktop" snippet (MCP config with the key);
  - top-ups table (amount, method, trigger MANUAL/AUTO/MCP, PayPal order + capture id, status).
- **States:** no balance (CTA top up); approving in PayPal; completed (balance animates up); declined ("PayPal couldn't complete this payment"); auto top-up cap reached.
- **Interactions:** top up, toggle auto, create/revoke key, copy config.

### W12 Buyer usage & claims (P1)
- **Features:** 07, 10
- **Components:** usage grid (time, dataset, endpoint, records, charged, channel REST/MCP, replay flag); per-call drawer with "Report a bad record"; claims list; "Refund unused balance to PayPal" (P1).
- **States:** empty; claim auto-credited; claim pending publisher; refund requested / completed.

### W13 Public catalog page `/c/:site` (P0)
- **Features:** 06, 16
- **Components:** site name, "Data sold by the owner via Spigot"; dataset cards (type, records, fields, price, freshness); quick-start (curl + MCP); "Get an API key" → W11; terms link.
- **States:** live; dataset stale (badge); site paused.
- This is where every 402 points.

## Ops

### W14 Admin / audit (P1)
- **Features:** 14
- **Components:** search (publisher, buyer, PayPal id); audit events grid; health tiles (PayPal token, Workflows, last gate hit, open top-ups, pending payouts); "Ledger check" button (shows sum = 0); "Run payout now".
- **States:** healthy; degraded.

### W15 Error & edge states (P0 copy)
- **Insufficient balance (API/MCP):** "This call costs $0.0555 and your balance is $0.012. Top up with PayPal: <link>."
- **Price above max:** "This would return 1,000 records ($1.50), above your $1.00 per-call limit. Narrow the filters or raise `max_price_micros`."
- **Auto top-up cap reached:** "Auto top-up is at its $100 monthly cap. Top up by hand or raise the cap."
- **Auto top-up declined:** "PayPal declined the saved card. Auto top-up is off until you update it."
- **Dataset unpublished (410):** "The owner stopped selling this data."
- **Stale data:** freshness badge "Last good extract 6 h ago; the site changed layout."
- **Payout unclaimed:** "PayPal sent $412.75 to publisher@…, which has no PayPal account yet."
- **Crawl blocked by origin:** "Your site returned 429. We paused and will retry after 10 min."

## Demo site (Bluebonnet Rentals, fictional; feature 01)

### D01 Home / search
Search form (beds, max rent, neighbourhood), featured listings grid, footer "Fictional demo site for Spigot. Not a real business."

### D02 Listing page
Photo placeholder, title, rent, beds/baths, sq ft, address (fictional), neighbourhood, available date, status, agent card with phone (PII to hide), schema.org JSON-LD. Optional "Open house" box.

### D03 Agent page and Open House page
Agent: name, brokerage (fictional), phone, email, active listings (no JSON-LD: the AI must write CSS selectors). Open House: listing link, date, time window, host agent.

### D04 Gate 402 page (HTML variant)
Plain page: "Bluebonnet Rentals sells this data as an API. $1.50 per 1,000 listings, live, typed. Pay with a PayPal-funded balance." Links to W13 and the MCP endpoint. Static, no JS, < 2 KB.

## Feature → screen map
| Feature | Screens |
|---|---|
| 01 Demo site | D01–D04 |
| 02 Gate | W03, W04, W16, D04 |
| 03 Onboarding + crawl | W02, W03, W10 |
| 04 Schema agent | W05, W06, W10 |
| 05 Records + changes | W07, W06 |
| 06 Buyer API + pricing | W06, W13, W15 |
| 07 Ledger + metering | W08, W12, W14 |
| 08 Top-up + vault | W11, W15 |
| 09 Payouts | W09, W08 |
| 10 Claims + refunds | W12 |
| 11 MCP + SDK | W11, W13 |
| 12 Buyer agent demo | (Claude Desktop), W11 |
| 13 Dashboard | W04–W10 |
| 14 Auth/security/ops | W02, W11, W14, W16 |
| 15 Demo seeding | W04, W08 (SIM chips), W14 |
| 16 Landing + docs | W01, W13 |
