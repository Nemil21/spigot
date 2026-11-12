# Demo dry-run checklist

Executed in **SP-039b** (local stack, a person at Claude Desktop and the PayPal approval) and again by SP-046 on Render. Two full runs in a row with `demo:reset` between them. Fill in the blanks: ids, timings, failures (link the fix ticket or PR comment). Beats B1–B8 are the rows of [video-script.md](video-script.md); every beat appears below.

Run: ☐ 1 ☐ 2 · Date ________ · Operator ________ · Stack: ☐ local ☐ Render · Git SHA ________ · `PAYPAL_ENV` ________

Command owners, in case one still prints "not yet" (`scripts/not-yet.mjs`): `seed:demo` SP-035, `sim:bots` SP-037, `sim:buyers` SP-036, `demo:reset` / `demo:payout` SP-038, `demo:mutate` SP-004b, `demo:decline` SP-047b.

## 0. Prerequisites (once per machine)

| # | Command / screen | Expected | Done / notes |
|---|---|---|---|
| 0.1 | `.env` has `PAYPAL_CLIENT_ID/SECRET` (sandbox), `DEMO_PUBLISHER_PAYOUT_EMAIL` (**separate** US sandbox business account), `DEMO_MODE=true`, `DEMO_ADMIN_TOKEN`, `DEMO_SITE_URL=http://localhost:4100`, `ALLOW_LOCAL_ORIGINS=true`, `VITE_PAYPAL_CLIENT_ID`, `VITE_AG_GRID_LICENSE_KEY` | Keys present (don't print them) | ☐ |
| 0.2 | Sandbox Personal (buyer) account login at hand for the PayPal approval | Can log in at sandbox.paypal.com | ☐ |
| 0.3 | `npm run dev:db && npm run migrate` | Migrations applied, no errors | ☐ |
| 0.4 | `npm run build -w @spigot/gate` then `npm run dev` (API on :3000) | `GET /healthz` 200 | ☐ |
| 0.5 | `pip install requests` (for `scraper-demo.py`) | `python -c "import requests"` OK | ☐ |
| 0.6 | Claude Desktop installed, Node 18+ on its PATH ([claude-desktop.md](claude-desktop.md)) | — | ☐ |

## 1. Seed

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 1.1 | — | `npm run seed:demo` | Publisher "Bluebonnet Rentals (demo)", site verified, **gate + crawl keys** and **Acme API key** printed; 20 SIM buyers with SIM top-ups (PayPal order/capture ids, or "SIM (no PayPal)"); < 5 min | time ____ · SIM top-ups with PayPal ids ____ / 20 |
| 1.2 | — | Demo site env: `SPIGOT_API_BASE=http://localhost:3000`, `SPIGOT_GATE_KEY=<gk_…>`, `SPIGOT_GATE_DEMO=1`, `SPIGOT_VERIFY_TOKEN`, `DEMO_ADMIN_TOKEN`; `npm run dev -w @spigot/demo-site` | Log: "Bluebonnet Rentals (fictional demo) on :4100 … 2341 listings", `[spigot-gate] policy v_ loaded` | policy v ____ |
| 1.3 | B1 | Browser: `http://localhost:4100/` | Bluebonnet Rentals home with "fictional demo" label; pages load for a human | ☐ |
| 1.4 | B2 | `npm run sim:bots -- --backfill 7d`, then `npm run sim:bots` (leave running for B2) | Live tally per bot; GPTBot / ClaudeBot / python-requests "Sent to API" only after publish (before it, gated paths pass) | backfill posts ____ |
| 1.5 | B2 | W03 `/app/install` (or W02 `/app/connect` on a fresh sign-up) | Verified ✓; gate pill "Installed · last hit Ns ago"; "Fails open" line | ☐ |
| 1.6 | B2 | W04 `/app` | Bot report fills in, e.g. "GPTBot 6,120 visits"; **SIM chips visible**; "1 bot per N human visits" | GPTBot visits ____ |

## 2. Crawl

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 2.1 | B2/B3 | W03 "Start first crawl" (or `POST /api/sites/:id/crawl`) | 202; progress bar from SSE (pages found / fetched); run DONE; site → PROPOSING → READY | crawl run ____ · duration ____ |
| 2.2 | B3 | W05 `/app/record-types` | **"I found 3 kinds of records on your site"**; cards stream in (Listing · 2,341, Agent · 88, Open House · 40); source badges; "Claude wrote the extractor once…" | proposal ids ____ · Claude live ☐ / replayed ☐ |
| 2.3 | — | W10 `/app/crawls` | Crawl run row; **AI calls: 0** for re-crawls | ☐ |

## 3. Approve

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 3.1 | B3 | W05 Listing card → Review → W06 `/app/datasets/:id` | 20 sample rows; PII badge on `agent_phone` | dataset id ____ |
| 3.2 | B3 | W06: hide `agent_phone`, price $1.50 / 1,000, tick rights, **Publish** | Re-extract progress → live card "Your gate now sends bots here" + endpoint; policy version bumped | schema version ____ · publish → live ____ s |
| 3.3 | B4 | `python scripts/scraper-demo.py http://localhost:4100` | **Three 402s**, each with "$1.50 per 1,000 listings", API link `…/v1/bluebonnet/datasets/listings/records`, MCP link; exit 0. (Before 3.2 it prints 200s and exits 1) | ☐ |
| 3.4 | B2 | W04 again | python-requests / GPTBot rows now "Sent to API" (402s) | ☐ |

## 4. Changes ("changed today")

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 4.1 | B6 | `npm run demo:mutate -- --prices 30 --leased 5 --new 3 --seed 42 --focus "bedrooms>=3,price_usd<2000,city=Austin" --target http://localhost:4100` | Prints changed slugs and touched paths; some inside the focus filter | seed ____ · slugs in focus ____ |
| 4.2 | B6 | W10 "Crawl now" (or `POST /api/sites/:id/crawl` with `trigger: DEMO_MUTATE`) | Only touched pages re-fetched (rest 304); records updated; changes visible in W07 | crawl run ____ · records updated ____ |
| 4.3 | B6 | `npm run sim:buyers` (then `-- --live` during B6) | SIM calls over the past week; W08 ~$500 gross with SIM chips | gross ____ |

## 5. Top up

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 5.1 | B5 | W11 `/buyers` as Acme: balance $0, "Top up with PayPal" | No-balance CTA | ☐ |
| 5.2 | B5 | $20 chip → PayPal button → sandbox approval as the Personal account (**hold 2 s**) → approve | Back on W11, **balance $20.00 without reload**; top-ups row MANUAL, COMPLETED | order ____ · capture ____ · approve→balance ____ s |
| 5.3 | B5 | Sandbox: merchant account activity | The $20 capture is there | ☐ |

## 6. Claude Desktop call

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 6.1 | B6 | Paste Acme's current key into the config ([claude-desktop.md](claude-desktop.md)); restart Claude Desktop | `spigot` tools listed (SP-022a human check) | ☐ |
| 6.2 | B6 | New chat, [prompt card](prompt-card.md) verbatim | `list_datasets` → `describe_dataset` → `quote` → `search_records`; typed table; reply names the charge "from your PayPal-funded balance"; no `agent_phone` | tool order ____ · records ____ · charged $____ · balance after $____ |
| 6.3 | B6 | Re-take rule | Re-take if it skipped `quote` | takes ____ |

## 7. W08 row

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 7.1 | B6 | W08 `/app/earnings` open during 6.2 | Acme row **flashes** within 2 s, channel **MCP**, no SIM chip; gross / commission 20% / net match 6.2 | flash after ____ s · api call id ____ |
| 7.2 | B6 | W08 SIM toggle | Background buyers' rows carry SIM chips; KPI hover "incl. $X simulated" | ☐ |

## 8. Payout

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 8.1 | B7 | W09 `/app/payouts` "Run payout now" (demo control) → confirm, or `npm run demo:payout -- --yes` | PayPal batch id shown; item **Sent**; row SIM chip (period includes SIM earnings) | batch ____ · item ____ · amount $____ |
| 8.2 | B7 | Wait for the status poll | W09 item → **Paid out** (or "Waiting for you to claim" → claim in the publisher account) | Sent → Paid out ____ min |
| 8.3 | B7 | Sandbox: log in as `DEMO_PUBLISHER_PAYOUT_EMAIL` | Payout received; ids match 8.1 | ☐ |

## 9. Close the run

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 9.1 | B8 | Architecture slide / README honest limits | Names gate, Render Workflows, Claude, MCP, ledger, PayPal Orders/Vault/Payouts, AG Grid, APIMatic | ☐ |
| 9.2 | — | `POST /admin/ledger/check` (admin session) | `sumMicros: 0`, `mismatches: []` | accounts checked ____ |
| 9.3 | — | W14 `/app/admin/audit`, search each PayPal id above | Every id present (and exists in the sandbox) | ☐ |
| 9.4 | — | Stop `sim:bots` / `sim:buyers --live` | — | ☐ |
| 9.5 | — | `npm run demo:reset -- --yes` | Dataset → PROPOSED, Acme balance $0, Acme key **rotated** (update the Claude config before run 2), demo site reset over HTTP + MANUAL crawl; `scraper-demo.py` prints 200s again until re-publish | ☐ |
| 9.6 | — | `POST /admin/ledger/check` | Still 0 after the reset | ☐ |
| 9.7 | — | Run 2: repeat from 1.6 (skip `seed:demo`; 2.1 is the reset's crawl) | Same results; new PayPal ids | ☐ |

## Failures and notes

| Step | What happened | Fix ticket / PR comment | Avoid on camera? |
|---|---|---|---|
| | | | |
| | | | |

Total wall time, run 1 ____ · run 2 ____
