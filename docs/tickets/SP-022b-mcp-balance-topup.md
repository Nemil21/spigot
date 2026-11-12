# SP-022b: MCP `get_balance` + `top_up` (approval link)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1
- **Depends on:** SP-022a, SP-018b
- **Spec refs:** features/11 §Logic 2; features/08 §MCP `top_up`; api.md §`GET /v1/balance`, §`POST /v1/topups`, §MCP tools

## Goal
The agent can see its balance and ask its human to top up through PayPal; P1 (SP-047b) upgrades `top_up` to a vaulted charge within the cap.

## Files / modules
`apps/api/src/mcp/tools.ts` (two tools), route `POST /v1/topups` (scope `topup`) in `apps/api/src/routes/v1.ts`.

## Scope
- `get_balance {}` → balance + auto top-up status (enabled, threshold, amount, remaining this month).
- `top_up {amountCents}` (scope `topup`, 500–50,000): P0 behaviour → `createTopupForAgent` (SP-018b) → `{status: 'AWAITING_APPROVAL', approveUrl}`; text: "Open this PayPal link to add $20 to your Spigot balance". `trigger=MCP`.
- `POST /v1/topups` same behaviour for REST.
- Tool description: "Charges the saved PayPal payment method of the account owner, up to their monthly cap." (true once SP-047b lands; until then the description says it returns an approval link).

## Acceptance criteria
- [ ] `top_up` without `topup` scope → tool error.
- [ ] `top_up` returns a sandbox `approveUrl`; approving it and hitting `/topups/return` credits the balance once.
- [ ] Agent looping on `top_up` is stopped by the 30/min limit.

## Race / idempotency tests (FakePayPal)
Same `top_up` JSON-RPC message retried → one top-up row, one order.

## Test plan
MCP client integration (FakePayPal).
