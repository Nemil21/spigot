# SP-033: W13 public catalog page `/c/:site` + terms

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-017a
- **Spec refs:** screens.md §W13; features/16 §Catalog page; api.md §The 402 contract (`catalogUrl`, `terms`)

## Goal
Every 402 points here, and it tells a scraper author exactly how to get the data legitimately.

## Files / modules
`apps/api/src/routes/catalog.ts` (server-rendered HTML, no SPA), `apps/api/src/views/catalog.html.ts`, `terms.html.ts`.

## Scope
- `/c/:site`: site name, "Data sold by the site owner through Spigot", dataset cards (type, record count, fields, price per 1,000, freshness, stale badge), quick-start tabs (curl, MCP config, SDK once SP-056), "Get an API key and top up with PayPal" → W11, link to `/v1/openapi.yaml`, terms link. Paused site state.
- `Accept: application/json` → the catalog JSON (`catalog()` from SP-017a).
- `/c/:site/terms`: contract terms for factual data, no resale, attribution optional.
- < 50 KB, no login, responsive to 375 px.
- Stale / paused / unpublished copy from `@spigot/shared/copy`.

## Acceptance criteria
- [ ] Every URL in the gate's and API's 402 bodies resolves (test follows them).
- [ ] curl with JSON accept returns the catalog JSON.
- [ ] Page weight < 50 KB.

## Test plan
Integration: render + link check from a real 402 body.
