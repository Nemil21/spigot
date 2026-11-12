# SP-022a: MCP server `/mcp`: auth, rate limit, list / describe / quote / search_records / get_changes

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-017a, SP-007b
- **Spec refs:** features/11-mcp-server-sdk.md §Logic 1–8; api.md §MCP server; README §Kill criterion step 3

## Goal
Claude Desktop discovers, quotes, pays for and receives typed records over MCP: kill-criterion step 3.

## Files / modules
`apps/api/src/mcp/server.ts` (`@modelcontextprotocol/sdk`, Streamable HTTP on `/mcp`), `tools.ts`, `results.ts` (text summary + `structuredContent`, payment errors as tool results).

## Scope
- Auth: Bearer API key via SP-007b's hook; revoked → 401 at once. Rate limit 30 calls/min/key.
- Tools calling SP-017a services with `channel=MCP`, `actor_type=MCP_CLIENT`: `list_datasets {query?}`, `describe_dataset {site, dataset}`, `quote {site, dataset, filters, limit}`, `search_records {site, dataset, filters, limit, maxPriceMicros?, idempotencyKey?}`, `get_changes {site, dataset, since?, limit, includeRecord?}`.
- Idempotency: `idempotencyKey` or, if absent, `mcp:<session id>:<jsonrpc id>` so a client retry of the same message isn't charged twice.
- 402 / `PRICE_ABOVE_MAX` / `UNSUPPORTED_FILTER` → `isError: true` tool results with W15 copy ("This call costs $0.0555; balance $0.012. Ask me to top up, or open <url>.").
- Results: one-line summary ("37 listings, charged $0.0555, balance $19.94") + `structuredContent` with typed records + `charged` + `next`.
- Tool descriptions state cost plainly (api.md wording) and suggest `quote` first.

## Acceptance criteria
- [ ] MCP SDK client test: every tool, free and paid paths; the paid call debits exactly `records × unit`.
- [ ] Replaying the same JSON-RPC request → no second charge.
- [ ] Empty balance → tool result with the top-up link, not a transport error.
- [ ] Invented field → tool error listing valid fields.
- [ ] Claude Desktop (via `mcp-remote`) lists the tools against a local server (manual, screenshot in PR).

## Test plan
Integration with the MCP client SDK over HTTP against the test server (CI `db` job).
