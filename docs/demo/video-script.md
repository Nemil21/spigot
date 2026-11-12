# Video script (≤ 3:00)

From [features/12](../spec/features/12-buyer-agent-demo.md) §Video script, with what is **REAL** and what is **SIM** (simulated) called out per beat. Narration must say which is which (features/15). Beat ids (B1–B8) match [dry-run-checklist.md](dry-run-checklist.md).

| Beat | Time | Shot | PayPal / AI on screen | Real / simulated |
|---|---|---|---|---|
| B1 | 0:00–0:20 | "1 AI bot for every 31 human visits. Small sites pay the bandwidth and earn nothing; scrapers pay Bright Data." Bluebonnet Rentals site (fictional, labelled). | — | Stat is TollBit's (Q4 2025, [docs/research/15](../research/15-gstack-spigot.md)); keep the source on screen. Bluebonnet Rentals is a **fictional demo site** (say so) |
| B2 | 0:20–0:45 | Owner connects the site (W02/W03); W04 bot report fills in ("GPTBot 6,120 visits", SIM chips visible) | — | **SIM:** bot traffic (`sim:bots`, backfill + live). **REAL:** the gate classifying those requests, site verify, the crawl |
| B3 | 0:45–1:15 | W05: **"I found 3 kinds of records on your site"** cards stream in. W06: hide `agent_phone`, set $1.50 / 1,000, Publish. Caption: "Claude wrote the extractor once; it now runs with zero AI calls per page." | **AI:** Claude schema agent | **REAL:** crawl and the Claude proposal (unless `seed:demo --with-proposals` replayed it: then say "recorded proposal"), publish, re-extract |
| B4 | 1:15–1:30 | Terminal: `python scripts/scraper-demo.py <demo-site>` → three 402s with price and API link | — | **REAL:** real HTTP to the demo site, default `python-requests` UA, real gate. No browser-UA variant (honest limits) |
| B5 | 1:30–1:50 | W11: "Top up $20 with PayPal" → sandbox approval (hold 2 s) → balance $20.00 | **PayPal:** Orders v2 + JS SDK v6, Vault | **REAL:** sandbox PayPal order + capture (ids exist in the sandbox) |
| B6 | 1:50–2:25 | Terminal, Claude Code CLI ([setup](claude-code-cli.md)): the [prompt card](prompt-card.md) → `quote` → `search_records` → typed JSON table; reply mentions "charged $X from your PayPal-funded balance". Cut to W08: earnings row flashes. | **AI:** Claude Code CLI over MCP · **PayPal-funded** ledger | **REAL:** the Claude Code call, the charge, the W08 row (channel MCP). **SIM:** the other buyers' rows in W08 (SIM chip). "$0.0555" is a spec placeholder: use the run's numbers |
| B7 | 2:25–2:40 | W09: "Run payout now" → PayPal batch id → Paid out; sandbox publisher account shows the payout | **PayPal:** Payouts | **REAL:** sandbox payout to the separate publisher business account. Its amount includes SIM buyers' earnings (SIM chip on the row); say so |
| B8 | 2:40–3:00 | Architecture slide (gate → crawl on Render Workflows → Claude schema → API/MCP → ledger → PayPal Orders/Vault/Payouts; AG Grid; APIMatic); honest limits in one line; "Scrapers pay Bright Data. Spigot makes them pay you." | All named | Honest limits: stealth scrapers with browser UAs aren't stopped; bot traffic and background buyers are simulated |

## Narration line for real vs simulated

> "Bot traffic and the background buyers are simulated and marked SIM. The crawl, Claude's schema, the PayPal top-up, the Claude Code call over MCP and the payout are real, in the PayPal sandbox."

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
