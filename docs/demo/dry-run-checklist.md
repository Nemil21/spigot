# Demo dry-run checklist

Executed in **SP-039b** (local stack; the buyer agent is **Claude Code CLI**, [claude-code-cli.md](claude-code-cli.md); a person at the PayPal approval) and again by SP-046 on Render. Two full runs in a row with `demo:reset` between them. Fill in the blanks: ids, timings, failures (link the fix ticket or PR comment). Beats B1–B8 are the rows of [video-script.md](video-script.md); every beat appears below.

Run: ☐ 1 ☐ 2 · Date ________ · Operator ________ · Stack: ☐ local ☐ Render · Git SHA ________ · `PAYPAL_ENV` ________

**Automated:** `npm run demo:dry-run -- --runs 2` runs every row it can (marked ⚙ below) and prints a filled-in report; with `--topup wallet` it stops at 5.2 for the person's PayPal approval. Only the rows marked 👤 need eyes or a login; [../MANUAL-STEPS.md](../MANUAL-STEPS.md) lists them. Results of the SP-039b runs are in [§SP-039b results](#sp-039b-results) at the end.

Command owners, in case one still prints "not yet" (`scripts/not-yet.mjs`): `seed:demo` SP-035, `sim:bots` SP-037, `sim:buyers` SP-036, `demo:reset` / `demo:payout` SP-038, `demo:mutate` SP-004b, `demo:decline` SP-047b.

## 0. Prerequisites (once per machine)

| # | Command / screen | Expected | Done / notes |
|---|---|---|---|
| 0.1 | `.env` has `PAYPAL_CLIENT_ID/SECRET` (sandbox), `DEMO_PUBLISHER_PAYOUT_EMAIL` (**separate** US sandbox business account), `DEMO_MODE=true`, `DEMO_ADMIN_TOKEN`, `DEMO_SITE_URL=http://localhost:4100`, `ALLOW_LOCAL_ORIGINS=true`, `VITE_PAYPAL_CLIENT_ID`, `VITE_AG_GRID_LICENSE_KEY` | Keys present (don't print them) | ☐ |
| 0.2 | Sandbox Personal (buyer) account login at hand for the PayPal approval | Can log in at sandbox.paypal.com | ☐ |
| 0.3 | `npm run dev:db && npm run migrate` | Migrations applied, no errors | ☐ |
| 0.4 | `npm run build -w @spigot/gate` then `npm run dev` (API on :3000) | `GET /api/healthz` 200 `{"ok":true}` (⚙ checked) | ☐ |
| 0.5 | `pip install requests` (for `scraper-demo.py`) | `python -c "import requests"` OK | ☐ |
| 0.6 | Claude Code CLI installed and signed in (`claude --version`); Spigot added with `claude mcp add` ([claude-code-cli.md](claude-code-cli.md)) | `claude mcp list` → `spigot` ✓ Connected | ☐ |

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

## 6. Claude Code call (buyer agent over MCP)

| # | Beat | Command / screen | Expected | Ids / timing |
|---|---|---|---|---|
| 6.1 | B6 | `claude mcp remove spigot` / `claude mcp add …` with Acme's current key ([claude-code-cli.md](claude-code-cli.md)); `/mcp` in `claude` | 7 `spigot` tools listed (SP-022a human check; ⚙ the SDK agent lists them too) | ☐ |
| 6.2 | B6 | ⚙ `claude -p` (or 👤 interactive `claude` on camera) with the [prompt card](prompt-card.md) verbatim | `list_datasets` → `describe_dataset` → `quote` → `search_records`; typed table; reply names the charge "from your PayPal-funded balance"; no `agent_phone` | tool order ____ · records ____ · charged $____ · balance after $____ |
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
| 9.5 | — | `npm run demo:reset -- --yes` | Dataset → PROPOSED, Acme balance $0, Acme key **rotated** (re-add it with `claude mcp add` before run 2), demo site reset over HTTP + MANUAL crawl; `scraper-demo.py` prints 200s again until re-publish | ☐ |
| 9.6 | — | `POST /admin/ledger/check` | Still 0 after the reset | ☐ |
| 9.7 | — | Run 2: repeat from 1.6 (skip `seed:demo`; 2.1 is the reset's crawl) | Same results; new PayPal ids | ☐ |

## Failures and notes

From the SP-039b runs (local stack, FakePayPal, Claude Code CLI). Rows for the sandbox run go below them.

| Step | What happened | Fix ticket / PR comment | Avoid on camera? |
|---|---|---|---|
| 0.4 | Checklist said `GET /healthz`; the API serves `GET /api/healthz` (the demo site has `/healthz`) | Fixed in this checklist (SP-039b) | — |
| 0.1 | The shared `.env` had no `SESSION_SECRET`: `seed:demo` refused to boot | Human: [MANUAL-STEPS.md](../MANUAL-STEPS.md) §1.1 | — |
| 1.1 / 5.2 | On `PAYPAL_MODE=stub`, any top-up after `seed:demo` failed `topups_paypal_order_id_key`: every process's FakePayPal counted ids from 1 (payout batch ids too, after an API restart) | Fixed in SP-039b (`FakePayPal({ seqStart })`, random offset for the shared stub fake) | — |
| 5.2 | On stub, a W11 wallet top-up can't be approved (nothing calls `FakePayPal.approve()`), so the stub dry run funds Acme with a SIM card top-up (`--topup sim`) | By design; the sandbox run uses `--topup wallet` and a person | The video top-up is the sandbox wallet approval only |
| 2.2 / 3.2 | Site slug is the demo site's host: endpoint `/v1/localhost/datasets/listings/records`, not `/v1/bluebonnet/…` (prompt card and scraper text assume `bluebonnet`) | Comment for SP-035 / SP-008a: a slug override for the demo site | Yes: don't zoom on the URL locally; on Render check the slug before recording |
| 2.2 (run 2) | After `demo:reset`, W05 shows **Listing · 2,344**, not 2,341: the 3 listings `demo:mutate --new` added stay as records after the demo site's reset removes them (reset crawl reports `records -0`) | Comment for SP-038 (reset crawl should mark removed pages' records REMOVED) | Yes: narrate the number on screen, or record W05 on the first take |
| 3.3 | After Publish, the gate keeps passing bots until its next policy refresh: the first 402 came **2–35 s** after "live" | — (gate refresh interval, SP-006b) | Yes: wait ~40 s after Publish before running `scraper-demo.py` |
| 4.3 / 8.1 | On a re-take after `demo:reset`, **"Run payout now" had nothing to pay** (`NO_ITEMS`): the first run's payout paid out the SIM week, the 20 SIM buyers are drained, and `demo:reset` doesn't re-fund them, so `sim:buyers` adds $0 | Comment for SP-038 / SP-036. `demo:dry-run` works around it (re-funds each SIM buyer $30, dated at the week start, then raises `--target-usd`) | Yes: record the W09 payout beat on the first take, or run the dry run's re-fund first |
| 6.2 | Claude Code reads "changed today" as `search_records` (54 / 52 matches) rather than `get_changes`; it always quoted first and set `maxPriceMicros` to the quote | Fine per the prompt card | Narrate the run's numbers ($0.081 / $0.078), not the spec's $0.0555 |
| 6.2 | Claude Code calls its own `ToolSearch` before the Spigot tools (deferred MCP tool loading) | Expected; the judge ignores it | — |
| — | README, Devpost draft, W11 snippet and Acme's key name still say "Claude Desktop" | Follow-ups in [MANUAL-STEPS.md](../MANUAL-STEPS.md) §5 (SP-044, SP-045, SP-032) | Don't show W11's "Connect Claude Desktop" card |

Total wall time (automated, stub): run 1 7.4 min (incl. the ~1 min `demo:reset`) · run 2 4.9 min

## SP-039b results

`npm run demo:dry-run -- --runs 2 --agent claude --topup sim` on a fresh database right after `seed:demo` (Git SHA `0a1d088` + this doc), Nov 12 2026, operator: AO worker spigot-87. Stack: **local**, `PAYPAL_MODE=stub` (FakePayPal, so the PayPal ids below are fake), `SCHEMA_AGENT_MODE=recorded` (2.2 replays the recorded Claude proposal), buyer agent **Claude Code CLI 2.1.308** (`claude -p`). Exit 0, **0 failed steps**, ledger check 0 after run 1, after the reset and after run 2.

Still open for the acceptance run: the same command on the PayPal **sandbox** with `--topup wallet` (a person approves $20 in W11 each run), the sandbox-side checks 5.3 / 8.3, and the 👤 screen checks. See [MANUAL-STEPS.md](../MANUAL-STEPS.md) §2–3.

#### Run 1 (2026-11-12T11:52:42.292Z, agent claude, top-up sim)

| Row | Step | Result | Ids / timing |
|---|---|---|---|
| 0.4 | API + demo site up, publisher and buyer sign in | OK | site localhost 8e146408-4c9d-5e2f-9eab-8b1669f07b02 · 0.2 s |
| 2.1 | Crawl (or wait for demo:reset’s crawl) | OK | run dcdeaa3c-67ee-489b-b2e8-a8fa0b1677e0 (MANUAL) 2482/2482 fetched, 0 not modified · 66.5 s |
| 2.2 | Proposals ready (3 record types) | OK | Listing · 2341 (JSON-LD), Agent · 88 (CSS), Open House · 40 (CSS) · 2.1 s |
| 3.2 | Publish Listing: agent_phone hidden, $1.50 / 1,000 | OK | dataset 1cc3406d-9d7d-48ce-80e3-734b8fb1f878 · schema v1 da1f7997-9078-40a5-8fb7-3a5bc25d0820 · records +2341 ~0 · publish → live 4 s · http://localhost:3187/v1/localhost/datasets/listings/records · 4.1 s |
| 3.3 | Scraper gets 402s (python-requests UA) | OK | 3 × 402 with "$1.50 per 1,000" · 42.2 s |
| 4.1 | demo:mutate --focus "bedrooms>=3,price_usd<2000,city=Austin" | OK | seed 41 · 72 pages with a new lastmod · 0.6 s |
| 4.2 | DEMO_MUTATE crawl: only touched pages re-fetched | OK | run 0d9a4ccd-ce82-4219-84e3-e2f8c0fc2460 · 74/74 pages · records +3 ~35 -0 · AI calls 0 · 2.1 s |
| 4.3 | sim:buyers (simulated week) | OK | Week 2026-11-05 → 2026-11-12: 6772 SIM calls, $501.14 charged; SIM week gross $0.00 → $501.14 (target $500.00) · 81.3 s |
| 5.2 | Acme top-up $20 (sim) | OK | SIM card top-up COMPLETED order ORD01D2ITCM / capture CAP01D2ITCN · balance $0.00 → $20.00 · 1.2 s |
| 6.1 | Mint a buyer key for the agent | OK | key d7ed7cd7-9bba-4833-abe7-72b39970ed26 (read) · 0.0 s |
| 6.2 | Buyer agent (claude) runs the prompt card over /mcp | OK | claude -p: tools list_datasets → describe_dataset → quote → search_records · turns 6 · reply: "I got a quote first, then fetched: **54 matching listings for $0.081**, which is exactly what the quote said. Your Spigot balance is now $19.92. **Search:** cit…" · charged $0.0810 · balance after $19.92 · 32.7 s |
| 7.1 | W08 sees the charge (call.charged event) | OK | event during the agent run · gross $501.22 · commission $100.24 · net $400.98 · 0.1 s |
| 8.1 | Run payout now (demo control) | OK | batch B00000CYG5W17 (MANUAL_DEMO) · PENDING · net $400.97 · items 84165c43-b074-4b66-9334-d9d04f1ccc11 PENDING → payouts@bluebonnet-rentals.example.com · 0.1 s |
| 8.2 | Payout item Sent → Paid out | OK | SUCCESS · SUCCESS after 145 s · 145.0 s |
| 9.2 | POST /admin/ledger/check = 0 | OK | sumMicros 0, mismatches 0, 25 accounts · 0.0 s |
| 9.5 | demo:reset --yes | OK | Demo site http://localhost:4187: reset at 2026-11-12T11:59:02Z, 69 page(s) reverted, 3 listing(s) removed /   MANUAL crawl of http://localhost:4187 … /   crawl 1c23bd53-47f0-4469-a0ed-ab07092d5210: SUCCEEDED · 64.8 s |
| 9.6 | Ledger check after reset = 0 | OK | sumMicros 0, mismatches 0, 25 accounts · 0.0 s |

Total wall time 7.4 min · 0 failed step(s)

#### Run 2 (2026-11-12T12:00:05.357Z, agent claude, top-up sim)

| Row | Step | Result | Ids / timing |
|---|---|---|---|
| 0.4 | API + demo site up, publisher and buyer sign in | OK | site localhost 8e146408-4c9d-5e2f-9eab-8b1669f07b02 · 0.1 s |
| 2.1 | Crawl (or wait for demo:reset’s crawl) | OK | run 1c23bd53-47f0-4469-a0ed-ab07092d5210 (MANUAL) 71/2482 fetched, 2411 not modified · 0.0 s |
| 2.2 | Proposals ready (3 record types) | OK | Listing · 2344 (JSON-LD), Agent · 88 (CSS), Open House · 40 (CSS) · 0.0 s |
| 3.2 | Publish Listing: agent_phone hidden, $1.50 / 1,000 | OK | dataset 1cc3406d-9d7d-48ce-80e3-734b8fb1f878 · schema v2 382ef6a1-bda1-4ddd-ab3b-73f57f629ea3 · records +0 ~35 · publish → live 6 s · http://localhost:3187/v1/localhost/datasets/listings/records · 6.1 s |
| 3.3 | Scraper gets 402s (python-requests UA) | OK | 3 × 402 with "$1.50 per 1,000" · 26.1 s |
| 4.1 | demo:mutate --focus "bedrooms>=3,price_usd<2000,city=Austin" | OK | seed 42 · 74 pages with a new lastmod · 0.5 s |
| 4.2 | DEMO_MUTATE crawl: only touched pages re-fetched | OK | run cfe5d891-4ca4-4843-a05a-a96fbf8575ed · 76/76 pages · records +3 ~35 -0 · AI calls 0 · 2.1 s |
| 4.3 | sim:buyers (simulated week) | OK | Week 2026-11-05 → 2026-11-12: 3945 SIM calls, $302.40 charged; SIM week gross $501.14 → $803.54 (target $802.00) (after re-funding 20 SIM buyers $30 each) · 50.3 s |
| 5.2 | Acme top-up $20 (sim) | OK | SIM card top-up COMPLETED order ORD0L0VZ5TQ / capture CAP0L0VZ5TR · balance $0.00 → $20.00 · 1.2 s |
| 6.1 | Mint a buyer key for the agent | OK | key 5ca6f5af-bc2b-45fa-8aa5-a308f564f536 (read) · 0.0 s |
| 6.2 | Buyer agent (claude) runs the prompt card over /mcp | OK | claude -p: tools list_datasets → describe_dataset → quote → search_records · turns 6 · reply: "I ran the free quote first: 52 matching records for $0.078 out of a $20.00 balance. I then fetched them for that price (capped at $0.08). Your balance is now $1…" · charged $0.0780 · balance after $19.92 · 38.1 s |
| 7.1 | W08 sees the charge (call.charged event) | OK | event during the agent run · gross $803.62 · commission $160.72 · net $642.89 · 0.2 s |
| 8.1 | Run payout now (demo control) | OK | batch B00000CYG5W19 (MANUAL_DEMO) · PENDING · net $241.98 · items e30ce0a9-8710-4625-9176-6467d9a54f02 PENDING → payouts@bluebonnet-rentals.example.com · 0.1 s |
| 8.2 | Payout item Sent → Paid out | OK | SUCCESS · SUCCESS after 172 s · 171.8 s |
| 9.2 | POST /admin/ledger/check = 0 | OK | sumMicros 0, mismatches 0, 25 accounts · 0.0 s |

Total wall time 4.9 min · 0 failed step(s)

All runs: 12.3 min, 0 failed step(s).
