# SP-034: W16 Settings (account, payout email, gate policy, key rotation)

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-024b, SP-008b
- **Spec refs:** screens.md §W16; features/02 §Edge cases (owner turns a category to PASS, key leaked); features/09 §Edge cases (payout email change)

## Goal
Minimal owner controls: payout email, which bot categories get a 402, and key rotation.

## Files / modules
`apps/web/src/pages/Settings.tsx`; API `PATCH /api/publishers/me`, `PATCH /api/sites/:id/policy`, `POST /api/sites/:id/keys/rotate` in `apps/api/src/routes/settings.ts`.

## Scope
- Account tab (name); Payout tab (PayPal email; "applies to the next batch"; P1 "Connect with PayPal" slot for SP-058).
- Gate policy tab: per-category Pass / Send to API toggles, gated path regexes (validated) → `bumpPolicyVersion`.
- Keys tab: rotate gate key or crawl key (new key shown once, old hash replaced, policy bump so the gate picks up the new crawl hash within 60 s).
- Saved toast; validation errors.

## Acceptance criteria
- [ ] Switching AI_AGENT to PASS → gate passes `ChatGPT-User` within 60 s.
- [ ] Rotating the crawl key → the next crawl sends the new key and is counted `SPIGOT_CRAWLER` after the gate's next policy refresh (≤ 60 s); the old key is no longer recognised.
- [ ] Payout email change doesn't alter a built batch's `receiver_email`.

## Test plan
Integration for the three endpoints; component tests.
