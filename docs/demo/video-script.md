# Video script (final, under 3:00)

From [features/12](../spec/features/12-buyer-agent-demo.md) §Video script, with what is **REAL** and what is **SIM** (simulated) called out per beat. Narration must say which is which (features/15). Beat ids (B1–B8) match [dry-run-checklist.md](dry-run-checklist.md). The buyer agent is the **Claude Code CLI** in a terminal ([claude-code-cli.md](claude-code-cli.md)); there is no Claude Desktop shot. How to record it: [MANUAL-STEPS.md §6](../MANUAL-STEPS.md#6-recording-runbook-sp-046).

| Beat | Time | Shot | PayPal / AI on screen | Real / simulated |
|---|---|---|---|---|
| B1 | 0:00–0:20 | "1 AI bot for every 31 human visits. Small sites pay the bandwidth and earn nothing; scrapers pay Bright Data." Bluebonnet Rentals site (fictional, labelled). | — | Stat is TollBit's (Q4 2025, [docs/research/15](../research/15-gstack-spigot.md)); keep the source on screen. Bluebonnet Rentals is a **fictional demo site** (say so) |
| B2 | 0:20–0:45 | Owner connects the site (W02/W03); W04 bot report fills in ("GPTBot 6,120 visits", SIM chips visible) | — | **SIM:** bot traffic (`sim:bots`, backfill + live). **REAL:** the gate classifying those requests, site verify, the crawl |
| B3 | 0:45–1:15 | W05: **"I found 3 kinds of records on your site"** cards stream in. W06: hide `agent_phone`, set $1.50 / 1,000, Publish. Caption: "Claude wrote the extractor once; it now runs with zero AI calls per page." | **AI:** Claude schema agent | **REAL:** crawl and the Claude proposal (unless `seed:demo --with-proposals` replayed it: then say "recorded proposal"), publish, re-extract |
| B4 | 1:15–1:30 | Terminal: `python scripts/scraper-demo.py <demo-site>` → three 402s with price and API link | — | **REAL:** real HTTP to the demo site, default `python-requests` UA, real gate. No browser-UA variant (honest limits) |
| B5 | 1:30–1:50 | W11: "Top up $20 with PayPal" → sandbox approval (hold 2 s) → balance $20.00 | **PayPal:** Orders v2 + JS SDK v6 | **REAL:** sandbox PayPal order + capture (ids exist in the sandbox). Don't say "Vault" here: wallet vault is off (`PAYPAL_WALLET_VAULT`) until spike S8b passes |
| B6 | 1:50–2:25 | Terminal, Claude Code CLI ([setup](claude-code-cli.md)): the [prompt card](prompt-card.md) → `quote` → `search_records` → typed JSON table; reply mentions "charged $X from your PayPal-funded balance". Cut to W08: earnings row flashes. Keep W11's "Connect Claude Desktop" card and the key name "Claude Desktop (demo)" out of frame | **AI:** Claude Code CLI over MCP · **PayPal-funded** ledger | **REAL:** the Claude Code call, the charge, the W08 row (channel MCP). **SIM:** the other buyers' rows in W08 (SIM chip). "$0.0555" is a spec placeholder: use the run's numbers |
| B7 | 2:25–2:40 | W09: "Run payout now" → PayPal batch id → Paid out; sandbox publisher account shows the payout | **PayPal:** Payouts | **REAL:** sandbox payout to the separate publisher business account. Its amount includes SIM buyers' earnings (SIM chip on the row); say so |
| B8 | 2:40–3:00 | Architecture slide (gate → crawl on Render → Claude schema → API/MCP → ledger → PayPal Orders/Vault/Payouts; AG Grid). Don't label Render Workflows as running the demo (it ran `WORKFLOWS_MODE=inproc`) and don't show APIMatic (not used); honest limits in one line; "Scrapers pay Bright Data. Spigot makes them pay you." | All named | Honest limits: stealth scrapers with browser UAs aren't stopped; bot traffic and background buyers are simulated |

## Narration line for real vs simulated

> "Bot traffic and the background buyers are simulated and marked SIM. The crawl, Claude's schema, the PayPal top-up, the Claude Code call over MCP and the payout are real, in the PayPal sandbox."

## Voiceover (final)

About 350 words: about 2:20 at 150 words a minute, which leaves room for the 2 s PayPal hold and the cuts. Words in `{braces}` come from the take (the dry-run report or the screen), never from the spec's placeholders. AI voiceover is fine.

**B1 (0:00–0:20).** "This is Bluebonnet Rentals, a fictional listings site we built for this demo. Sites like it now get one AI bot visit for every thirty-one human visits. The owner pays for the bandwidth and earns nothing. The scrapers' customers pay Bright Data instead."

**B2 (0:20–0:45).** "The owner installs Spigot's gate: a few lines of middleware. Humans and search engines pass straight through. Within seconds the bot report shows who is taking the data. This bot traffic is simulated and marked SIM; the gate classifying it is real."

**B3 (0:45–1:15).** "Spigot crawls the site and Claude reads a few sample pages. It found three kinds of records: {2,341} listings, 88 agents, 40 open houses. It wrote an extractor for each, checked it on samples, and already hid the agents' phone numbers as personal data. The owner sets a dollar fifty per thousand records and publishes. Claude wrote the extractor once; it now runs with zero AI calls per page."

**B4 (1:15–1:30).** "Now a plain Python scraper hits the site. Instead of HTML it gets HTTP 402, with the price and a link to the API."

**B5 (1:30–1:50).** "An agent builder tops up twenty dollars with PayPal. This is the real PayPal sandbox approval page. Captured: the balance is twenty dollars."

**B6 (1:50–2:25).** "Their agent here is Claude Code, connected to Spigot over MCP. We ask for three-bedroom rentals under two thousand dollars that changed today. It gets a free quote first, then fetches {N} typed records, and is charged {$X} from its PayPal-funded balance, only because the call succeeded. On the owner's dashboard, the sale appears live. The other buyers' rows are simulated and marked SIM."

**B7 (2:25–2:40).** "The owner clicks Run payout now. Spigot keeps twenty percent and sends the rest as a PayPal Payouts batch, {batch id} on screen, to the owner's PayPal account. The payout includes the simulated buyers' earnings."

**B8 (2:40–3:00).** "The gate, the crawl, Claude's schema, the PayPal top-up, the Claude Code call over MCP and the payout are all real, in the PayPal sandbox, hosted on Render. Spigot stops declared bots, not stealth scrapers on proxies; we make paying cheaper than evading. Scrapers pay Bright Data. Spigot makes them pay you."

## Rules for the recording (features/12)

- Never open with "402 + PayPal" (competitors' pitch). Open with the owner's problem.
- Say which numbers are simulated (bot traffic and background buyers) and which are real (the demo buyer's top-up, the Claude Code call, the payout).
- Cut loading; keep the PayPal approval screen visible for 2 s so judges see PayPal.
- Record the Claude Code shot early, in case of retakes.
- AI voiceover is allowed; no copyrighted music; no real brands on screen.
- Every PayPal id shown on screen must exist in the sandbox (record them in the checklist).
- Don't show a real API key: blur it, or rotate it after the take (`demo:reset` does).

## Edge cases

| Case | Handling |
|---|---|
| Claude picks a different tool order | Fine; the prompt card asks to quote first. Re-take if it skips quoting |
| Sandbox approval page slow | Pre-warm; cut in edit |
| Payout stays PENDING during recording | Record the publisher-account shot later; show W09 PENDING → Paid out as a cut |
| `scraper-demo.py` prints 200 instead of 402 | Gate off or dataset not live: check `SPIGOT_API_BASE` / `SPIGOT_GATE_KEY` on the demo site and that B3's Publish happened (`demo:reset` un-gates `/listings/` until re-approved) |
