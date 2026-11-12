# SP-037: `sim:bots` (real HTTP with bot UAs, SIM-flagged, batched backfill)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-006b, SP-008b
- **Spec refs:** features/15 §Live simulators; features/02 §Hit counting

## Goal
Real requests through the real gate so W04 fills up, labelled SIM.

## Files / modules
`scripts/sim-bots.ts` (`npm run sim:bots -- --target <demo-site-url> [--minutes 10]`).

## Scope
- GPTBot, ClaudeBot, CCBot, python-requests, Scrapy, Googlebot at 2–5 req/s plus ~60 req/s human UAs (configurable down for Render), random gated and ungated paths from the sitemap; header `X-Spigot-Sim: 1` (counted SIM only when the gate has `SPIGOT_GATE_DEMO=1`).
- Optional `--backfill 7d`: builds all SIM `bot_hits` buckets for the past week and posts them through the gate-hits endpoint in **as few posts as fit SP-008b's 1 MB / 20k-bucket limit**, spaced ≥ 5 s apart to respect its 1-post-per-5-s limit (labelled SIM).
- Prints a live tally (decision by bot).

## Acceptance criteria
- [ ] GPTBot/python-requests get 402, Googlebot and humans 200, and W04 shows them as SIM within 15 s.
- [ ] Without `SPIGOT_GATE_DEMO=1`, counts are not SIM (and the script warns).
- [ ] A 7-day backfill completes in under 1 minute with no 429.

## Test plan
Smoke against the local demo site + API.
