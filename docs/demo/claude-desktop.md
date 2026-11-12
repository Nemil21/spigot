# Claude Desktop setup for the demo

The demo buyer, "Acme Agents (demo)", connects Claude Desktop to Spigot's MCP server (`/mcp`, features/11) with its API key. W11 shows the same snippet with the key filled in (SP-032). The key below is a **placeholder**: never commit, paste into a ticket, or leave a real key on screen.

## 1. Get a key

- Local: `npm run seed:demo` prints Acme's key (SP-035), or create one in W11 (`/buyers`, "API keys", shown once).
- `npm run demo:reset` **rotates Acme's key** (SP-038), so after every reset paste the new key here and restart Claude Desktop.

## 2. Edit the config

File: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json` (Claude Desktop: Settings → Developer → Edit Config). Merge `spigot` into any existing `mcpServers`.

Local stack (API on `PORT`, default 3000):

```json
{
  "mcpServers": {
    "spigot": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3000/mcp",
        "--header",
        "Authorization: Bearer sk_spg_REPLACE_WITH_ACME_KEY"
      ]
    }
  }
}
```

Render (recording, SP-046): replace the URL with `https://<api-service>.onrender.com/mcp`.

If the server fails to start because the space in the header argument is split (a known `mcp-remote` issue on some Windows setups), pass the header through an env var instead:

```json
{
  "mcpServers": {
    "spigot": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization:${SPIGOT_AUTH}"],
      "env": { "SPIGOT_AUTH": "Bearer sk_spg_REPLACE_WITH_ACME_KEY" }
    }
  }
}
```

Needs Node 18+ on the PATH Claude Desktop sees (`npx` downloads `mcp-remote` on first start).

## 3. Restart and check

1. Quit Claude Desktop fully (Cmd-Q, not just the window) and reopen it.
2. The tools menu lists `spigot` with `list_datasets`, `describe_dataset`, `quote`, `search_records`, `get_changes`, `get_balance`, `top_up` (`report_bad_record` only if P1 SP-048c is merged). This is the SP-022a human check.
3. Ask "Using Spigot, what's my balance?" → `get_balance`, free. Approve the tool call when Claude asks.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `spigot` missing or red in the tools menu | Logs: macOS `~/Library/Logs/Claude/mcp-server-spigot.log`, Windows `%APPDATA%\Claude\logs\`. Usually invalid JSON or `npx` not on PATH |
| Tool result `401` / `UNAUTHORIZED` | Key revoked or rotated by `demo:reset`; paste the current key and restart |
| Tool result "This call costs $…; balance $0.00" | Expected before the top-up beat: top up $20 in W11, then ask again |
| `RATE_LIMITED` | 30 calls/min per key (features/11); wait a minute |
| Stale tool list after a server change | Restart Claude Desktop |

## After the recording

Revoke the key used on camera in W11 (or run `demo:reset`, which rotates it), and remove the real key from the config file.
