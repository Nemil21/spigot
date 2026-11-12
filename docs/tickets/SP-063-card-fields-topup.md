# SP-063: Card-fields top-up (JS SDK v6 card fields, vaulted)

- **Priority:** P1 (api.md: `CARD` via card fields is P1; feature 08 fallback)
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-032
- **Spec refs:** api.md §`POST /api/buyer/topups` (`CARD`); features/08 §Manual top-up 7; Holdfast spikes/s7-results.md step 1 (card fields + vault PASS)

## Goal
Buyers without a PayPal account top up with a card through PayPal's card fields, saved for auto top-up; also the fallback if wallet approval fails.

## Files / modules
`apps/web/src/components/CardFieldsTopUp.tsx`; `POST /api/buyer/topups` `method: 'CARD'` path (order with no source → card-fields `submit()` → capture with vault ON_SUCCESS).

## Scope
JS SDK v6 card fields (client id only), sandbox test card 4111…; on success → capture → `creditTopup`, `vault_kind=CARD`; W11 shows "Visa ••1111".

## Acceptance criteria
- [ ] Sandbox card-fields top-up of $20 credits once and vaults the card.

## Race / idempotency tests (FakePayPal)
Double submit → one order, one credit (no-source order create replays cleanly, Holdfast S7).

## Test plan
Manual sandbox; integration on the fake.
