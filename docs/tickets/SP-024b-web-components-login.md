# SP-024b: Web shared components (Money, SimChip, StatusPill, …), shells, publisher + buyer login pages

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1
- **Depends on:** SP-024a, SP-007a, SP-001d
- **Spec refs:** screens.md (shared states, money copy rule); features/13 §6 Theme; features/14 §Auth

## Goal
The shared components every screen uses, both shells, and working login pages for publishers and buyers.

## Files / modules
`apps/web/src/components/` (`Money` with tabular numbers and micros tooltip, `SimChip`, `StatusPill`, `PayPalId` copy cell, `Kpi`, `Skeleton`, `ErrorBanner`, `EmptyState`), `src/layout/PublisherShell.tsx` (left nav from SP-024a's config: Overview, Record types, Earnings, Payouts, Crawls, Settings), `src/layout/BuyerShell.tsx`, `src/pages/Login.tsx`, `src/pages/buyer/Login.tsx`.

## Scope
- Loading = skeletons (never spinners on money numbers); Error = inline banner with retry; Empty = sentence + one action.
- `Money` and `StatusPill` take their wording from `@spigot/shared/copy` (money copy rule: `charged`, `credited`, `refunded to PayPal`, `sent`, `paid out`, `waiting for you to claim`; "$1.50 / 1,000 records").
- Login pages call SP-007a's `/api/auth/login` and `/api/buyer/login`; redirect to `/app` / `/buyers`.

## Acceptance criteria
- [ ] Publisher and buyer login work against SP-007a (integration in fixture-free mode against a test API).
- [ ] `StatusPill` renders every payout and top-up status with the exact copy-rule words (snapshot).
- [ ] Light and dark themes at 1024 px and 1280 px.

## Test plan
Component tests (vitest + Testing Library) for `Money`, `SimChip`, `StatusPill`, login forms.
