# SP-039: Buyer agent demo kit: `scraper-demo.py`, Claude Desktop config, prompt card, dry-run checklist

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1
- **Depends on:** SP-022a, SP-006b
- **Spec refs:** features/12-buyer-agent-demo.md §Pieces to build, §Video script, §Rules for the recording

## Goal
Everything the recording needs beyond the app: the 402 terminal shot, the Claude Desktop setup, the prompt card and a written dry-run checklist. **Running** the end-to-end dry run belongs to SP-046, which depends on every screen and script the run touches.

## Files / modules
`scripts/scraper-demo.py` (~20 lines, `requests`), `docs/demo/claude-desktop.md` (config with placeholder key), `docs/demo/prompt-card.md`, `docs/demo/video-script.md` (from features/12, with real/simulated callouts), `docs/demo/dry-run-checklist.md` (steps, expected result per step, and where to record ids and timings; executed in SP-046).

## Scope
- `scraper-demo.py`: GET 3 listing URLs with the default UA → prints status 402, the price and the API link in a readable format. No browser-UA variant (honest limits).
- Prompt card: "Using Spigot, find 3-bedroom rentals under $2,000 in Austin on Bluebonnet Rentals that changed today. Quote first, then fetch." Expected tools: `list_datasets` → `describe_dataset` → `quote` → `search_records`.
- Dry-run checklist covering seed → crawl → approve → top-up → Claude Desktop call → W08 row → payout, with the command or screen for each step.
- Claude Desktop check on what this ticket's dependencies provide: Claude Desktop connects to a local `/mcp` and runs `list_datasets`, `describe_dataset` and `quote` against a fixture LIVE dataset (paid calls need a balance; SP-022a's tests cover them).

## Acceptance criteria
- [ ] `python scripts/scraper-demo.py <demo-site>` prints three 402s with price and link.
- [ ] Claude Desktop with the documented config lists the Spigot tools and answers a `quote` locally (screenshot in the PR).
- [ ] The dry-run checklist covers every step of the video script in features/12.

## Test plan
Run `scraper-demo.py` against the local demo site with the gate on; Claude Desktop connection check. The full dry run is SP-046.
