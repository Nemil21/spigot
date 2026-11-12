# SP-024: Web scaffold: React + Vite + Tailwind, AG Grid / AG Charts, tokens, shell, shared components

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a
- **Spec refs:** screens.md (shared states, money copy rule); features/13 §Layout and AG Grid use §6 Theme; README §Designs, §Tech stack

## Goal
Every screen ticket starts from one app shell, one theme and one set of money/SIM/status components.

## Files / modules
`apps/web/` — Vite + React + TS + Tailwind, `src/main.tsx`, `src/router.tsx` (publisher `/app/*`, buyer `/buyers/*`), `src/api/client.ts` (fetch wrapper, error envelope, CSRF origin), `src/api/sse.ts` (`useEventStream(url)` with auto-reconnect + `Last-Event-ID` + refetch), `src/theme/tokens.css` (semantic tokens, light + dark, **different palette from Holdfast**), `src/grid/` (AG Grid Enterprise + AG Charts setup, licence from `VITE_AG_GRID_LICENSE_KEY`, Quartz theme customised with our tokens), `src/components/` (`Money` with tabular numbers and micros tooltip, `SimChip`, `StatusPill`, `PayPalId` copy cell, `Kpi`, `Skeleton`, `ErrorBanner`, `EmptyState`), `src/layout/PublisherShell.tsx` (left nav: Overview, Record types, Earnings, Payouts, Crawls, Settings), `src/layout/BuyerShell.tsx`, login pages for publisher and buyer.
- Fastify serves the built SPA same-origin (`@fastify/static`, history fallback) from `apps/api`.

## Scope
- Loading = skeletons (never spinners on money numbers); Error = inline banner with retry; Empty = sentence + one action.
- Money copy helpers enforce screens.md wording (`charged`, `credited`, `refunded to PayPal`, `sent`, `paid out`, `waiting for you to claim`) and "$1.50 / 1,000 records".
- Fixture mode (`VITE_FIXTURES=1`) with JSON fixtures per api.md endpoint so screen tickets can start before their API merges.

## Acceptance criteria
- [ ] `npm run build -w @spigot/web` passes; Fastify serves `/app` and deep links.
- [ ] An AG Grid Enterprise grid and an AG Charts chart render with no licence watermark when the key is set.
- [ ] Publisher and buyer login pages work against SP-007a.
- [ ] Light and dark themes at 1024 px and 1280 px.

## Test plan
Component tests (vitest + Testing Library) for `Money`, `SimChip`, `StatusPill`; build in CI.
