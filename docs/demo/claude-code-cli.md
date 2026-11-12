# Claude Code CLI as the demo buyer agent

The demo buyer, "Acme Agents (demo)", is **Claude Code CLI** talking to Spigot's MCP server (`/mcp`, features/11) over Streamable HTTP with Acme's API key as a Bearer header. No desktop app and no `mcp-remote` bridge: Claude Code speaks HTTP MCP itself. ([claude-desktop.md](claude-desktop.md) and W11's "Connect Claude Desktop" snippet still work for anyone who prefers the desktop app, but the demo path is the CLI.)

`npm run demo:dry-run` (SP-039b) does all of this automatically for rehearsals; the steps below are for the person recording the B6 shot.

## Rules for the key

- Acme's key (`sk_…`) is printed by `npm run seed:demo` and again by every `npm run demo:reset`, which **rotates it** (the old key answers 401). W11 also creates keys.
- Never paste the key into a shell where it is echoed or saved to history, a screenshot, the video or a doc. Read it into a variable without echo, as below.

## 1. Add the server (once per key)

Use an empty folder for the demo so no project `CLAUDE.md`, settings or hooks shape the take:

```bash
mkdir -p ~/spigot-demo && cd ~/spigot-demo
read -rs SPIGOT_KEY            # paste Acme's sk_… key, press Enter (nothing is shown)
claude mcp add --transport http spigot http://localhost:3000/mcp \
  --header "Authorization: Bearer $SPIGOT_KEY"
unset SPIGOT_KEY
claude mcp list                # spigot: http://localhost:3000/mcp (HTTP) - ✓ Connected
```

On Render (SP-046) the URL is `https://<api-host>/mcp`. `claude mcp add` stores the server for this folder only (local scope), in `~/.claude.json`; nothing goes into the repo.

**After `demo:reset`:** `claude mcp remove spigot`, then add it again with the new key.

## 2. SP-022a check: the tools are listed

In `~/spigot-demo`, start `claude` and type `/mcp`, then select `spigot`: it must show **7 tools**: `list_datasets`, `describe_dataset`, `quote`, `search_records`, `get_changes`, `get_balance`, `top_up`. (`demo:dry-run` checks the same list over MCP on every run.)

## 3. The B6 shot

Interactive (better on camera: tool calls show as they happen):

```bash
cd ~/spigot-demo
claude --allowedTools "mcp__spigot__list_datasets,mcp__spigot__describe_dataset,mcp__spigot__quote,mcp__spigot__search_records,mcp__spigot__get_changes,mcp__spigot__get_balance"
```

then paste the [prompt card](prompt-card.md) verbatim. `--allowedTools` pre-approves the free tools and the paid fetch, so no permission prompt interrupts the take; `top_up` is left out on purpose (it would ask first).

Headless (the same take as one command, for rehearsals or a terminal-only cut):

```bash
claude -p "Using Spigot, find 3-bedroom rentals under \$2,000 in Austin on Bluebonnet Rentals that changed today. Quote first, then fetch." \
  --allowedTools "mcp__spigot__list_datasets,mcp__spigot__describe_dataset,mcp__spigot__quote,mcp__spigot__search_records,mcp__spigot__get_changes,mcp__spigot__get_balance"
```

**Re-take if** it fetches before `quote`, or `agent_phone` appears anywhere (prompt card rules). Claude Code may first call its own `ToolSearch` to load the Spigot tools; that's expected.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `claude mcp list` shows ✗ Failed to connect | API not running, or wrong URL / port. `curl http://localhost:3000/api/healthz` |
| Tools listed but every call says 401 | The key was rotated by `demo:reset`: remove and re-add the server |
| `search_records` returns 402 `INSUFFICIENT_BALANCE` | Top up $20 in W11 first (checklist §5) |
| `site` is `localhost` instead of `bluebonnet` | The site slug comes from the demo site's host. Locally it's `localhost`; Claude finds it through `list_datasets` either way |
| Permission prompt mid-take | Start `claude` with the `--allowedTools` list above |
