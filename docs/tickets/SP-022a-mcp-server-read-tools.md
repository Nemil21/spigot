# SP-022a: MCP server `/mcp` (stateful sessions): auth, rate limit, list / describe / quote / search_records / get_changes

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
- **Stateful sessions:** run the Streamable HTTP transport in session mode (`Mcp-Session-Id`). The automatic idempotency key is `mcp:<session id>:<jsonrpc id>` **only when a session id is present**; a request without one falls back to SP-016's `autoKey` (request hash + minute bucket), so a reconnecting `mcp-remote` whose JSON-RPC ids restart at 1 never collides with an older call.
- Tool error text comes from `@spigot/shared/copy` (W15).
- Tools are files in `apps/api/src/mcp/tools/*.ts` (glob-loaded registry, same hot-spot rule as routes): `catalog.ts`, `records.ts` here; SP-022b adds `balance.ts`, SP-048c adds `claims.ts`.

## Acceptance criteria
- [ ] MCP SDK client test: every tool, free and paid paths; the paid call debits exactly `records × unit`.
- [ ] Replaying the same JSON-RPC request → no second charge.
- [ ] Empty balance → tool result with the top-up link, not a transport error.
- [ ] Invented field → tool error listing valid fields.
- [ ] Two sessions reusing the same JSON-RPC id for different calls → two independent charges (no 409, no stale replay).
- [ ] *(Human-verified, doesn't block the merge)* Claude Desktop via `mcp-remote` lists the tools against a local server; screenshot in the PR when a person is available, otherwise done in SP-039b.

## Test plan
Integration with the MCP client SDK over HTTP against the test server (`*.db.test.ts`); add `security/tenancy/mcp.cases.ts`.
