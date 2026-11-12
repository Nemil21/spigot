# SP-035: `seed:demo`: publisher, site, Acme + 20 SIM buyers, SIM sandbox top-ups

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1.5
- **Depends on:** SP-018, SP-008a, SP-007b
- **Spec refs:** features/15-demo-seeding.md §Seed script, §Labelling rules; features/12 §Pieces 2

## Goal
One command produces the demo's cast with honest SIM labels, leaving the crawl and AI proposal to run live.

## Files / modules
`apps/api/src/cli/seed-demo.ts` (`npm run seed:demo [-- --with-proposals]`).

## Scope
- Publisher "Bluebonnet Rentals (demo)", `is_demo=true`, `payout_email = DEMO_PUBLISHER_PAYOUT_EMAIL` (**separate US sandbox business account**, not the merchant).
- Site connected and verified with the preset token; gate and crawl keys printed for the demo site's env.
- Discovery crawl **not** seeded (runs live). `--with-proposals` loads the recorded proposal (SP-012a recorded mode), audited as "replayed proposal".
- Buyer "Acme Agents (demo)": real foreground buyer, no balance, API key printed.
- 20 SIM buyers (`is_simulated=true`) each with a key and one $20–$50 **real sandbox card top-up** via `serverCardTopup` (CAPTURE, `trigger=SIM`), concurrency 3; rate-limited → ledger-only SIM top-up with `paypal_order_id = null`, shown "SIM (no PayPal)".
- Idempotent: re-running doesn't duplicate rows or top-ups (lookups by email).

## Acceptance criteria
- [ ] Fresh DB → seed completes in < 5 min (excluding the live crawl).
- [ ] 20 SIM top-ups have PayPal order + capture ids (or the labelled fallback).
- [ ] Second run creates nothing new; ledger check passes.

## Race / idempotency tests (FakePayPal)
Seed run twice in parallel → one set of buyers and top-ups (unique emails + topups dedupe).

## Test plan
Run against FakePayPal in CI (smoke), sandbox by hand.

## Notes & risks
Use the five working test cards round-robin; never 5105…5100 (Holdfast S7).
