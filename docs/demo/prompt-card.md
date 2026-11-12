# Prompt card (Claude Code CLI beat, 1:50–2:25)

Paste exactly, in a new `claude` session in `~/spigot-demo` ([claude-code-cli.md](claude-code-cli.md)), or pass it to `claude -p`:

> Using Spigot, find 3-bedroom rentals under $2,000 in Austin on Bluebonnet Rentals that changed today. Quote first, then fetch.

## Expected tool sequence

1. `list_datasets` (free): finds `bluebonnet` / `listings`.
2. `describe_dataset` (free): filterable fields, e.g. `bedrooms`, `price_usd`, `city`.
3. `quote` (free): record count and price for the filter.
4. `search_records` (charged): typed records; text summary like "N listings, charged $X, balance $Y".
5. (`top_up` only if the P1 auto top-up beat is shown.)

Claude may read "changed today" as `get_changes` or as a `search_records` filter on `updated_at`; both are fine as long as it quotes first. **Re-take if it skips `quote`** (features/12 §Edge cases).

## The numbers are placeholders

The spec's "**37 records / $0.0555**" (and "balance $19.94") are **placeholders**. Use the real numbers from the run:

| | Value from this run |
|---|---|
| `quote` records | ______ |
| `quote` price | $______ |
| `search_records` charged | $______ |
| Balance after | $______ |

Price = records × per-record price ($1.50 per 1,000 = $0.0015 per record → 37 records = $0.0555). The demo set: every 32nd listing is a 3-bed under $2k in Austin (74 at scale 1), and `npm run demo:mutate -- --focus "bedrooms>=3,price_usd<2000,city=Austin" …` (SP-004b) makes some of them change today so there are matches. Narration and captions must quote the run's numbers, not the spec's.

## What a good reply looks like

- A table of listings (address, beds, rent, available date, what changed).
- A line like "Charged $0.0xx from your PayPal-funded Spigot balance."
- No `agent_phone` column (hidden in W06; if it shows up, the dataset wasn't published with it hidden).

## Before the take

- `get_balance` shows $20.00 (after the W11 top-up).
- `claude` started with the `--allowedTools` list from [claude-code-cli.md](claude-code-cli.md), so no permission prompt interrupts the shot.
- `claude mcp list` shows `spigot` ✓ Connected with **today's** key (`demo:reset` rotates it).
- Rehearse it with `npm run demo:dry-run` (SP-039b): same prompt through `claude -p`, judged by the rules above.
- W08 open in another window for the cut to the earnings row flash.
