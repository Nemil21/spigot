# SP-004a: Demo site "Bluebonnet Rentals" (Express + EJS, seeded 2,341 / 88 / 40, JSON-LD, sitemap, ETag)

- **Priority:** P0
- **Wave:** 1
- **Estimate:** 1.5
- **Depends on:** none
- **Spec refs:** features/01-demo-site.md; screens.md §D01–D03

## Goal
A believable fictional listings site we own, with three record types (one with JSON-LD, two CSS-only), so the crawler and schema agent have real structure to find.

## Files / modules
`apps/demo-site/`: `src/server.ts` (Express + EJS), `src/data/seed.ts` (faker, fixed seed), `src/data/store.ts` (JSON file `data/bluebonnet.json`; **not** Spigot's DB), `views/*.ejs`, `package.json` (own workspace, start script).

## Scope
- Seed exactly **2,341 listings, 88 agents, 40 open houses**, fixed seed. Austin-area neighbourhood names; invented brokerages; phones in `555-01xx`; emails `@example.com`.
- Pages: D01 `/` and `/search` (beds, max rent, neighbourhood; not gated); D02 `/listings/:slug` with schema.org JSON-LD (`Apartment` + `Offer`: `price`, `priceCurrency`, `numberOfRooms`, `floorSize`, `address`) plus visible HTML for the same facts and **two HTML-only fields** (`available_from` in `dl.facts dd[data-k=available]`, `pets_allowed`), agent card with phone; D03 `/agents/:slug` (no JSON-LD; `.agent-name`, `.agent-phone`, `dl.facts`), `/open-houses/:id` (no JSON-LD; `<time datetime>`); `/about`, 10 `/blog/:slug` posts (unstructured).
- `/sitemap.xml` with `<lastmod>` per URL from `updated_at`; `/robots.txt`; `/.well-known/spigot.txt` from env `SPIGOT_VERIFY_TOKEN`.
- ETag (hash of rendered HTML) on every page and `304` on `If-None-Match`.
- Footer on every page: "Fictional demo site for Spigot. Not a real business."
- A mount point for the gate (`app.use(gate)` before routes) that is a no-op until SP-006b.
- Simple access log (method, path, UA, status, concurrent-request gauge) to stdout, used by SP-009a's "≤ 2 concurrent" check.

## Out of scope
Gate middleware (SP-006b), mutate script (SP-004b), `DEMO_LAYOUT=v2` (SP-052a).

## Acceptance criteria
- [ ] Counts are exactly 2,341 / 88 / 40 after seed; seed is deterministic (same slugs every run).
- [ ] Sitemap lists every listing, agent, open house and blog page with lastmod.
- [ ] A listing page's JSON-LD parses and validates as schema.org `Apartment`/`Offer`.
- [ ] `curl -H 'If-None-Match: <etag>'` → 304.
- [ ] No real business, brand, person or phone number (grep check on generated data for non-555 phones and non-example.com emails).

## Test plan
Unit: seed counts, determinism, phone/email ranges. Integration: supertest pages, sitemap, 304. Manual: browse D01–D03.

## Notes & risks
- Separate Render service in SP-040; it must not share Spigot's DB.
- Render free instances sleep: SP-040 uses a paid starter or a warm-up before recording.
