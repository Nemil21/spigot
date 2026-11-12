# 11: MCP Server, OpenAPI & SDK

**Priority:** P0 (MCP server with 6 tools; `openapi.yaml`) · P1 (`report_bad_record`, APIMatic-generated SDK) · **Owner:** B · **Effort:** 2.5 h (+1 h SDK)

## Purpose
Agents are the buyers. Any MCP client (Claude Desktop first) can discover datasets, quote, pay and receive typed records with one config line. Developers who'd rather write code get a typed SDK generated from our OpenAPI spec.

## User stories
- As a Claude Desktop user, I ask "find 3-bed rentals under $2k near Austin that changed today" and get typed results paid from my balance.
- As a developer, I connect in under 2 minutes with my API key.
- As a developer, I `npm i` a typed client instead of hand-writing fetch calls (P1).
- As a site owner, I see which calls came via MCP (channel column).

## Screens
W11 ("Connect Claude Desktop" snippet, keys) · W13 (quick-start) · W08 (channel column)

## Logic
1. `/mcp` on the API service, Streamable HTTP via `@modelcontextprotocol/sdk`. Auth middleware maps the Bearer API key → buyer, scopes. Revoked key → 401 immediately.
2. Tools (schemas in [api.md](../api.md#mcp-server-mcp-streamable-http)): `list_datasets`, `describe_dataset`, `quote`, `search_records`, `get_changes`, `get_balance`, `top_up` (P0: approval link or vault MIT if P1 done), `report_bad_record` (P1).
3. Every tool calls the same service function as `/v1` (`paidRead`, `quote`, `topups.create`), so idempotency, caps, 402 logic and audit are identical. `channel=MCP`, `actor_type=MCP_CLIENT`.
4. **Idempotency:** `search_records`/`get_changes` accept `idempotencyKey`; if absent, the server uses the MCP request id (`jsonrpc id` + session id) so a client retry of the same JSON-RPC message isn't charged twice.
5. **Payment errors are tool results, not protocol errors:** a 402 becomes `isError: true` with text like "This call costs $0.0555; balance $0.012. Ask me to top up, or open <approveUrl>." Agents handle that better than a transport error.
6. **Tool descriptions** state cost plainly (see api.md) and suggest `quote` first for big queries. `describe_dataset` lists filterable fields and ops so the model builds valid filters.
7. **Result shape:** a short text summary ("37 listings, charged $0.0555, balance $19.94") plus `structuredContent` with the typed records (MCP structured tool output), so Claude can both narrate and reason over fields.
8. **Claude Desktop config** (shown in W11 with the key filled in):
   ```json
   { "mcpServers": { "spigot": { "command": "npx", "args": ["-y", "mcp-remote", "https://spigot.onrender.com/mcp",
       "--header", "Authorization: Bearer sk_spg_…"] } } }
   ```
9. **OpenAPI:** `openapi.yaml` generated from the Zod schemas of `/v1` (`zod-to-openapi`), served at `/v1/openapi.yaml`, linked from W13.
10. **APIMatic SDK (P1):** import `openapi.yaml` into APIMatic, generate TypeScript and Python SDKs into `packages/sdk` (committed), plus a 5-line example in the README:
    ```ts
    const spigot = new SpigotClient({ apiKey: process.env.SPIGOT_KEY });
    const { records, charged } = await spigot.records.search('bluebonnet', 'listings', { 'bedrooms[gte]': 3, 'price_usd[lt]': 2000 });
    ```
    Also mention the APIMatic PayPal Context Plugin used while writing `src/paypal/*` (P0, costs nothing).

## Edge cases
| Case | Handling |
|---|---|
| Agent loops calling `search_records` | 30 calls/min per key; per-call max price; balance runs out → 402 (no auto top-up beyond cap) |
| Agent invents a field name | `UNSUPPORTED_FILTER` tool error listing valid fields |
| Huge result requested | Clamped to `max_records_per_call`; the summary says so and gives the `next` cursor |
| Prompt injection inside record text | We return data only; the agent's host is responsible; we never execute instructions from records. README note |
| Key leaked | Revoke in W11 → 401 at once |

## Acceptance criteria
- [ ] Claude Desktop lists the tools and completes the demo question end to end; the call shows on W08 within 2 s with channel MCP.
- [ ] Retrying the same JSON-RPC request doesn't create a second charge.
- [ ] An empty balance yields a tool result with the top-up link, not a crash.
- [ ] `openapi.yaml` validates; (P1) the generated SDK runs the README example against the deployed API.

## Test plan
Integration: MCP client SDK test calling every tool (paid and free paths, 402 path). Manual: Claude Desktop recording (record this shot early). P1: SDK smoke test in CI.
