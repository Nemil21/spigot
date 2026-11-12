# SP-032: W11 Buyer portal: balance, Top up with PayPal (JS SDK v6), keys, Claude Desktop config

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 2
- **Depends on:** SP-024b, SP-018a, SP-007b
- **Spec refs:** screens.md §W11; features/08 §Manual top-up 1–5; features/11 §Logic 8; features/12 video 1:30–1:50

## Goal
The buyer funds their agent with PayPal on camera and connects Claude Desktop.

## Files / modules
`apps/web/src/pages/buyer/Portal.tsx`, `components/PayPalTopUp.tsx` (JS SDK v6 `paypal-payments`, client id only), `ApiKeysTable.tsx`, `ClaudeConfig.tsx`, `TopupsTable.tsx`; buyer signup page.

## Scope
- Balance hero ("$19.94 balance", micros tooltip; animates up on completion).
- **Top up with PayPal**: amount chips $5 / $20 / $50; "Save for auto top-up" checkbox; JS SDK v6 button `createOrder: () => orderId` from `POST /api/buyer/topups`; `onApprove` → capture endpoint; PayPal approval visible (don't hide it).
- API keys table: create (one-time reveal + copy), revoke.
- "Connect Claude Desktop" snippet with the key filled in (`npx -y mcp-remote https://…/mcp --header "Authorization: Bearer sk_spg_…"`).
- Top-ups table: amount, method, trigger (MANUAL / AUTO / MCP / SIM), PayPal order + capture id, status.
- States: no balance CTA, approving, completed, declined ("PayPal couldn't complete this payment"), auto-top-up-cap slot (P1).
- Auto top-up card is P1 (SP-047b); leave a slot.
- Error and declined copy from `@spigot/shared/copy` (W15).
- Add `security/tenancy/buyer-keys.cases.ts` if this ticket adds any buyer route.

## Acceptance criteria
- [ ] Sandbox: Personal account approves $20; balance shows $20.00 without reload.
- [ ] PayPal client secret never reaches the browser (bundle grep in CI).
- [ ] Key is shown once; revoke makes the next MCP call fail.

## Test plan
Component tests (fixtures); manual sandbox top-up recorded early (video shot).
