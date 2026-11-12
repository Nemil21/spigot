# SP-008a: Sites: connect, verify, gate + crawl keys

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1
- **Depends on:** SP-007a, SP-009a1
- **Spec refs:** features/03-site-onboarding-crawl.md §Logic 1–2; api.md §`POST /api/sites`, §`POST /api/sites/:id/verify`; data-model.md §sites, §Site state machine

## Goal
A publisher registers an origin, proves ownership, and gets the keys their gate and our crawler use.

## Files / modules
`apps/api/src/sites/sites.ts`, `verify.ts`, `keys.ts`, routes `POST /api/sites`, `POST /api/sites/:id/verify`, `GET /api/sites`, `GET /api/sites/:id`.

## Scope
- `POST /api/sites {origin}`: normalize origin; fetch `/robots.txt` and `/sitemap.xml` (5 s timeout) through SP-009a1's `safeFetch` (no second SSRF implementation) → `409`/`VALIDATION_ERROR` "Add a sitemap.xml or enter one" if missing; derive `slug`; generate `verify_token`, gate key `gk_…`, crawl key `ck_…` (store SHA-256 only); default policy jsonb from data-model; status `PENDING_VERIFY`; return keys once plus the install snippet.
- `POST /api/sites/:id/verify`: GET `/.well-known/spigot.txt`, compare; `transition(PENDING_VERIFY → VERIFIED)`; otherwise 409 `STATE_CONFLICT` "Token not found…". Emits a `site.verified` hook that SP-009b subscribes to (starts the discovery crawl).
- Accept an optional `sitemapUrl` override.
- Audit `SITE_CONNECTED`, `SITE_VERIFIED`.
- Tenancy: all reads through `forPublisher`.

## Acceptance criteria
- [ ] Connecting the local demo site returns keys once; DB holds only hashes.
- [ ] Verify succeeds when the demo site's `SPIGOT_VERIFY_TOKEN` matches; fails with 409 otherwise; a second verify is a no-op.
- [ ] Unreachable origin → "We couldn't reach that site" error code; no row created.
- [ ] Another publisher's site id → 404.

## Test plan
Integration against the demo site started in-test (SP-004a) and a stub origin without a sitemap.

## Notes & risks
In dev, the SSRF guard must allow `localhost` for the demo site only (flag `ALLOW_LOCAL_ORIGINS=true`, never on Render).
Add `security/tenancy/sites.cases.ts` for the routes here (SP-042 glob-loads it).
