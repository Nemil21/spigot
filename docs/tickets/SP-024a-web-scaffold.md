# SP-024a: Web scaffold: Vite + React + Tailwind, AG Grid / Charts, tokens, pre-registered routes, static serving, API client, SSE hook

- **Priority:** P0
- **Wave:** 1
- **Estimate:** 1.5
- **Depends on:** none
- **Spec refs:** screens.md (shared states, money copy rule); features/13 §Layout and AG Grid use §6 Theme; README §Designs, §Tech stack

## Goal
Every screen ticket starts from one app, one theme and a router where its page already exists as a stub, so screen tickets never edit a shared file.

## Files / modules
`apps/web/` — Vite + React + TS + Tailwind, `src/main.tsx`, `src/router.tsx`, `src/pages/**` stubs, `src/api/client.ts`, `src/api/sse.ts`, `src/theme/tokens.css`, `src/grid/` (AG Grid Enterprise + AG Charts setup); `apps/api/src/routes/web.ts` (static serving).

## Scope
- **Router pre-registers every screen** as a lazy import of a stub page at a fixed path, matching each screen ticket's Files list: `pages/Landing.tsx` (W01), `pages/onboarding/SignUp.tsx`, `ConnectSite.tsx`, `InstallVerify.tsx` (W02/W03), `pages/Overview.tsx` (W04), `pages/RecordTypes.tsx` (W05), `pages/DatasetEditor.tsx` (W06), `pages/RecordsBrowser.tsx` (W07), `pages/Earnings.tsx` (W08), `pages/Payouts.tsx` (W09), `pages/Crawls.tsx` (W10), `pages/buyer/Portal.tsx` (W11), `pages/buyer/Usage.tsx` (W12), `pages/admin/Audit.tsx` (W14), `pages/Settings.tsx` (W16), `pages/Login.tsx`, `pages/buyer/Login.tsx`. Each stub renders "Coming soon"; **screen tickets replace only their own file**. Nav items in the shells (SP-024b) are fixed here as a config array.
- **All web dependencies installed up front** (one lockfile change): react, react-dom, react-router, vite, tailwind, ag-grid-enterprise, ag-grid-react, ag-charts-enterprise, `@paypal/paypal-js`, Testing Library.
- Theme: semantic tokens, light + dark, **a different palette from Holdfast**; AG Grid Quartz theme customised with them; licence from `VITE_AG_GRID_LICENSE_KEY`.
- `api/client.ts` (fetch wrapper, error envelope, same-origin), `api/sse.ts` (`useEventStream(url)` with auto-reconnect, refetch on reconnect; treats a `resync` event as "refetch everything").
- **Fixture mode** (`VITE_FIXTURES=1`): the client resolves `GET` calls from `src/fixtures/<route>.json` when present. **Each screen ticket owns the fixtures for its own endpoints** (adds files, edits nothing shared).
- Static serving from Fastify (`@fastify/static`) with the SPA history fallback **only for `/app/*`, `/buyers/*` and `/`**. `/c/*` (SP-033), `/v1/*`, `/mcp`, `/api/*`, `/admin/*`, `/webhooks/*`, `/topups/return` are never served `index.html`.

## Acceptance criteria
- [ ] `npm run build -w @spigot/web` passes; Fastify serves `/app` and deep links like `/app/earnings`.
- [ ] `GET /c/x` and `GET /v1/catalog` never return `index.html` (test), even before SP-033 exists (they 404 as JSON).
- [ ] Every screen path in the list resolves to its stub.
- [ ] An AG Grid Enterprise grid and an AG Charts chart render with no licence watermark when the key is set.
- [ ] `@spigot/shared` imports with no Node polyfills.

## Test plan
Build in CI; route-fallback test as `*.db.test.ts`-free unit test against the Fastify instance.

## Notes & risks
- **Wave 1 start:** own workspace; starts against the agreed layout and rebases on SP-001a before merging.
- No vite dev server is left running by any ticket (laptop rule): UI tickets test with Testing Library in fixture mode and `vite build`.
