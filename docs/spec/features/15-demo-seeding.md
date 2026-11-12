# 15: Demo Seeding & Simulated Traffic (Labelled Honestly)

**Priority:** P0 · **Owner:** B · **Effort:** 2 h

## Purpose
A marketplace looks dead with one buyer and no bots. The demo uses simulated bot traffic and simulated buyers for volume, and a few real actions in the foreground. Everything simulated is labelled, so judges trust the rest.

## Seed script (`npm run seed:demo`)
1. Demo site data (01) with the fixed seed: 2,341 / 88 / 40.
2. Publisher "Bluebonnet Rentals (demo)", payout email = the **US** sandbox business account for the publisher (a second sandbox business account, separate from our merchant account).
3. Site connected and verified (token preset), gate keys in the demo site's env.
4. Discovery crawl run **live** (not seeded) so the crawl and AI proposal are real. For fast retakes, `--with-proposals` loads the recorded proposal from the last real run (labelled "replayed proposal" in the audit, not used in the video).
5. Buyers: "Acme Agents (demo)" = the **real** foreground buyer (no balance; it tops up on camera). 20 SIM buyers (`is_simulated=true`).
6. **SIM buyer balances are funded by real sandbox top-ups**: each SIM buyer makes one $20–$50 card top-up via Orders v2 CAPTURE with the sandbox test card (same code path, `trigger=SIM`), concurrency 3. If rate-limited, fall back to ledger-only SIM top-ups with `paypal_order_id = null`, shown as "SIM (no PayPal)" in the UI and README.
7. SIM calls: `scripts/sim-buyers.ts` runs real `/v1` calls with SIM buyers' keys over a simulated past week (backdated `created_at` allowed only for SIM rows), mixing records and changes, so W08 shows ~$500 gross for the week and the payout has something to pay.

## Live simulators (during recording)
- `npm run sim:bots`: sends real HTTP requests to the demo site with bot UAs (GPTBot, ClaudeBot, CCBot, python-requests, Scrapy, Googlebot) at 2–5 req/s, plus ~60 req/s "human" UAs, from the script's own host. The gate classifies them for real; the script sets header `X-Spigot-Sim: 1`, and the gate marks those counts `is_simulated` (only when the gate is in demo mode, env `SPIGOT_GATE_DEMO=1`).
- `npm run sim:buyers -- --live`: one SIM call every 3–6 s so W08 looks alive.

## Labelling rules
- SIM rows show a grey "SIM" chip in every grid (W04, W08, W09 statements, W14).
- KPI tiles show "incl. $X simulated" on hover.
- The video narration names what's real: the crawl, the AI proposal, the demo buyer's PayPal top-up, the Claude Desktop call, the payout batch. And what's simulated: background bot traffic and background buyers.
- README has a "What's real vs simulated" table.

## Demo hooks
- `npm run demo:reset` (12), `npm run demo:mutate` (01), `npm run demo:payout` (= "Run payout now" with the $1 demo threshold), `npm run demo:decline` (next auto top-up gets `PayPal-Mock-Response INSTRUMENT_DECLINED`, P1).

## Acceptance criteria
- [ ] One command produces a lively dashboard in < 5 min (excluding the live crawl).
- [ ] Reset leaves PayPal history untouched and the ledger check passing.
- [ ] Every simulated item is visibly labelled.

## Test plan
Run seed + reset twice; run the ledger check; scan grids for unlabelled SIM rows.
