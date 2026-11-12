# MCP tools (glob-loaded)

Every `*.ts` file here default-exports a `ToolModule` (`../tools.ts`) that registers its tools on
each session's `McpServer`. **Add a file; never edit `mcp/server.ts`, `mcp/tools.ts` or
`routes/mcp.ts`.** SP-022a: `catalog.ts`, `records.ts`; SP-022b: `balance.ts`; SP-048c: `claims.ts`.

- Get the caller with `callerOf(extra)` (buyer, API key, scopes, session id, JSON-RPC id). Auth and
  the 30/min limit already ran on the HTTP request.
- Call the same service as `/v1` with `channel: 'MCP'`; for paid calls pass
  `idempotencyKeyFor(caller, args.idempotencyKey)`.
- Wrap the body in `guard(...)` and answer with `ok(summary, structured)`; payment and request
  problems are `isError` tool results (`paymentResult`, `fromApiError`), never thrown protocol errors.
- Shared input schemas live in `../inputs.ts`: only tool modules go in this folder.
