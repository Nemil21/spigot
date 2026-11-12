# SP-039a: Demo kit: `scraper-demo.py`, Claude Desktop config doc, prompt card, dry-run checklist

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 0.5
- **Depends on:** SP-006b
- **Spec refs:** features/12-buyer-agent-demo.md §Pieces to build, §Video script, §Rules for the recording

## Goal
The pieces of the recording that aren't the app, ready early: the scraper's 402 terminal shot, the Claude Desktop setup doc, the prompt card and the dry-run checklist.

## Files / modules
`scripts/scraper-demo.py` (~20 lines, `requests`), `docs/demo/claude-desktop.md` (config with a placeholder key), `docs/demo/prompt-card.md`, `docs/demo/video-script.md` (from features/12, with real/simulated callouts), `docs/demo/dry-run-checklist.md`.

## Scope
- `scraper-demo.py`: GET 3 listing URLs with the default UA → prints status 402, the price and the API link, readable. No browser-UA variant (honest limits).
- Prompt card: "Using Spigot, find 3-bedroom rentals under $2,000 in Austin on Bluebonnet Rentals that changed today. Quote first, then fetch." Expected tools: `list_datasets` → `describe_dataset` → `quote` → `search_records`. **Note on the card that the spec's "37 records / $0.0555" are placeholders: use the real numbers from the run** (SP-004b's `--focus` makes sure there are matches).
- Dry-run checklist: seed → crawl → approve → `demo:mutate --focus …` → top-up → Claude Desktop call → W08 row → payout, with the command or screen and the expected result for each step, and blanks for ids and timings. **Executed in SP-039b.**

## Acceptance criteria
- [ ] `python scripts/scraper-demo.py <demo-site>` prints three 402s with price and link against the local demo site with the gate on.
- [ ] The checklist covers every beat of the features/12 video script.

## Test plan
Run the script locally.
