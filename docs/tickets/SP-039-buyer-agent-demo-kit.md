# SP-039: Buyer agent demo kit: `scraper-demo.py`, Claude Desktop config, prompt card, dry run

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1
- **Depends on:** SP-022a, SP-006b
- **Spec refs:** features/12-buyer-agent-demo.md §Pieces to build, §Video script, §Rules for the recording

## Goal
Everything the recording needs beyond the app: the 402 terminal shot, the Claude Desktop setup and a script that has been run end to end.

## Files / modules
`scripts/scraper-demo.py` (~20 lines, `requests`), `docs/demo/claude-desktop.md` (config with placeholder key), `docs/demo/prompt-card.md`, `docs/demo/video-script.md` (from features/12, with real/simulated callouts), `docs/demo/dry-run-checklist.md`.

## Scope
- `scraper-demo.py`: GET 3 listing URLs with the default UA → prints status 402, the price and the API link in a readable format. No browser-UA variant (honest limits).
- Prompt card: "Using Spigot, find 3-bedroom rentals under $2,000 in Austin on Bluebonnet Rentals that changed today. Quote first, then fetch." Expected tools: `list_datasets` → `describe_dataset` → `quote` → `search_records`.
- Dry run on the local stack: seed → crawl → approve → top-up → Claude Desktop call → W08 row → payout; record timings and failures in the checklist.

## Acceptance criteria
- [ ] `python scripts/scraper-demo.py <demo-site>` prints three 402s with price and link.
- [ ] One full local dry run completed with Claude Desktop; screenshots or ids in the PR.

## Test plan
Manual dry run (needs a person at Claude Desktop and the PayPal approval).
