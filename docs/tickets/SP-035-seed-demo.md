# SP-035: `seed:demo`: publisher, site, Acme + 20 SIM buyers, SIM sandbox top-ups (deterministic ids)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-018b, SP-008a, SP-007b, SP-012a
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
- 20 SIM buyers (`is_simulated=true`) each with a key and one $20–$50 **real sandbox card top-up** via `serverCardTopup` (SP-018b; CAPTURE, `trigger=SIM`) with a **deterministic top-up id `uuidv5(buyerEmail + ':seed')`**, inserted `ON CONFLICT DO NOTHING` before PayPal is called (only the inserting run calls PayPal), concurrency 3. SIM top-ups are dated to the start of the simulated week at insert (`simulatedAt`, SP-005/SP-036); rate-limited → ledger-only SIM top-up with `paypal_order_id = null`, shown "SIM (no PayPal)".
- Idempotent: re-running doesn't duplicate rows or top-ups (lookups by email; top-ups by their deterministic id, never by a fresh one).
- Publisher row has `is_demo = true`.

## Acceptance criteria
- [ ] Fresh DB → seed completes in < 5 min (excluding the live crawl).
- [ ] 20 SIM top-ups have PayPal order + capture ids (or the labelled fallback).
- [ ] Second run creates nothing new; ledger check passes.

## Race / idempotency tests (FakePayPal)
- Seed run twice in parallel → one set of buyers, **one PayPal order per SIM buyer** (deterministic ids), one TOPUP txn each.
- A seed killed after inserting a top-up row and before PayPal answered → the re-run reconciles that row (SP-018b) and never creates a second order.

## Test plan
Run against FakePayPal in CI (smoke), sandbox by hand.

## Notes & risks
Use the five working test cards round-robin; never 5105…5100 (Holdfast S7).
