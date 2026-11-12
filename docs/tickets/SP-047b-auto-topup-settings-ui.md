# SP-047b: Auto top-up settings API, W11 card, MCP `top_up` from vault, `demo:decline`

- **Priority:** P1 (spec P1 #1)
- **Wave:** 7
- **Estimate:** 1.5
- **Depends on:** SP-047a, SP-032, SP-022b
- **Spec refs:** api.md §`PUT /api/buyer/auto-topup`; screens.md §W11 auto top-up card, §W15; features/08 §MCP `top_up`; features/15 §Demo hooks (`demo:decline`)

## Goal
The human sets "$20 when below $2, max $100/month"; the agent's `top_up` uses the vault within the cap.

## Files / modules
Route `PUT /api/buyer/auto-topup`; `apps/web/src/pages/buyer/AutoTopupCard.tsx`; MCP `top_up` upgrade; `apps/api/src/cli/demo-decline.ts`.

## Scope
- PUT validates (requires a vaulted method; amount 500–50,000; cap ≥ amount).
- W11 card: threshold, amount, monthly cap, saved method ("PayPal · sb-buyer@…" or "Visa ••1111"), remaining this month; cap-reached and declined banners (W15 copy).
- MCP `top_up` / `POST /v1/topups`: vault → `reserveVaultTopup()` from SP-047a (same VAULT_MIT cap and one-in-flight rule; `trigger=MCP`) → COMPLETED; cap reached → tool error with W15 copy; no vault → approval link (SP-022b).
- `npm run demo:decline`: flags the buyer so the next AUTO top-up sends `PayPal-Mock-Response INSTRUMENT_DECLINED` (only `DEMO_MODE` + `ALLOW_MOCK_DECLINE` + sandbox).

## Acceptance criteria
- [ ] Enabling without a vault → 422 with explanation.
- [ ] Claude Desktop `top_up` with a vault returns COMPLETED and the balance rises.
- [ ] `demo:decline` then a short call → W11 shows the declined banner.
- [ ] An agent looping on `top_up` stops at the monthly cap (not only at the 30/min rate limit).

## Test plan
Integration (FakePayPal), component tests, sandbox once.
