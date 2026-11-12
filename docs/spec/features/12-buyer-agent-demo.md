# 12: Buyer Agent Demo & Video Script

**Priority:** P0 · **Owner:** B (scripts), A + B (recording) · **Effort:** 1 h build + 2.5 h recording

## Purpose
Show the whole loop with real AI and real PayPal sandbox money: a scraper gets turned away politely, an agent pays and gets better data, the owner earns and gets paid out. Judges may never run the project, so the video carries the submission.

## User stories
- As a judge, I understand in 20 seconds who has the problem and why it matters.
- As a judge, I see PayPal move money three times (top-up in, per-call metering against it, payout out) and AI do real work twice (schema agent, buyer agent).

## Pieces to build
1. **`scripts/scraper-demo.py`** (~20 lines): `requests.get` 3 listing URLs with the default UA → prints status 402 and the JSON body's price and API link, in a readable terminal format. Then the same with `-A "Mozilla/5.0 …"` is **not** shown (we don't pretend to stop stealth scrapers; it's in Honest limits).
2. **Buyer setup:** buyer account "Acme Agents (demo)", sandbox Personal account for PayPal approval, API key, Claude Desktop config (11).
3. **Prompt card** for the recording: "Using Spigot, find 3-bedroom rentals under $2,000 in Austin on Bluebonnet Rentals that changed today. Quote first, then fetch." Expected tool sequence: `list_datasets` → `describe_dataset` → `quote` → `search_records` (→ `top_up` if the P1 auto top-up is shown).
4. **`npm run demo:reset`**: reset the demo publisher's dataset to PROPOSED, buyer balance to $0, delete the demo buyer's calls (keep SIM history), restore demo-site data, so every take starts clean. Never touches PayPal history.
5. **`npm run demo:mutate`** (01) before the "changed today" beat so there are fresh changes.

## Video script (≤ 3:00)
| Time | Shot | PayPal / AI on screen |
|---|---|---|
| 0:00–0:20 | "1 AI bot for every 31 human visits. Small sites pay the bandwidth and earn nothing; scrapers pay Bright Data." Bluebonnet Rentals site (fictional, labelled). | — |
| 0:20–0:45 | Owner connects the site; W04 bot report fills in ("GPTBot 6,120 visits", SIM chips visible) | — |
| 0:45–1:15 | W05: **"I found 3 kinds of records on your site"** cards stream in. W06: hide `agent_phone`, set $1.50 / 1,000, Publish. Caption: "Claude wrote the extractor once; it now runs with zero AI calls per page." | **AI:** Claude schema agent |
| 1:15–1:30 | Terminal: `python scraper-demo.py` → 402 with price and API link | — |
| 1:30–1:50 | W11: "Top up $20 with PayPal" → sandbox approval → balance $20.00 | **PayPal:** Orders v2 + JS SDK v6, Vault |
| 1:50–2:25 | Claude Desktop: the prompt → `quote` ($0.0555) → `search_records` → typed JSON table; reply mentions "charged $0.0555 from your PayPal-funded balance". Cut to W08: earnings row flashes. | **AI:** Claude Desktop over MCP · **PayPal-funded** ledger |
| 2:25–2:40 | W09: "Run payout now" → PayPal batch id → Paid out; sandbox publisher account shows the payout | **PayPal:** Payouts |
| 2:40–3:00 | Architecture slide (gate → crawl on Render Workflows → Claude schema → API/MCP → ledger → PayPal Orders/Vault/Payouts; AG Grid; APIMatic); honest limits in one line; "Scrapers pay Bright Data. Spigot makes them pay you." | All named |

Rules for the recording:
- Never open with "402 + PayPal" (competitors' pitch). Open with the owner's problem.
- Say which numbers are simulated (bot traffic and background buyers) and which are real (the demo buyer's top-up, the Claude Desktop call, the payout).
- Cut loading; keep the PayPal approval screen visible for 2 s so judges see PayPal.
- Record the Claude Desktop shot **before 22:00 Nov 11** in case of retakes.
- AI voiceover is allowed; no copyrighted music; no real brands on screen.

## Edge cases
| Case | Handling |
|---|---|
| Claude picks a different tool order | Fine; the prompt card asks to quote first. Re-take if it skips quoting |
| Sandbox approval page slow | Pre-warm; cut in edit |
| Payout stays PENDING during recording | Record the publisher-account shot later; show W09 PENDING → Paid out as a cut |

## Acceptance criteria
- [ ] The full script runs end to end twice in a row after `demo:reset`.
- [ ] Every PayPal id shown on screen exists in the sandbox.
- [ ] Video < 3:00, public on YouTube, uploaded by Nov 12 08:30 PST.

## Test plan
Two full dry runs on the deployed Render services on Nov 11 evening; one after deploy freeze on Nov 12 morning.
