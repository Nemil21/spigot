# 01: Demo Site ("Bluebonnet Rentals", fictional)

**Priority:** P0 · **Owner:** A · **Effort:** 2 h

## Purpose
We need a structured-data site we own, so we never crawl or name a real business. It must look like a real small listings site, carry three record types (one with JSON-LD, two without), change over time, and run `spigot-gate`.

## User stories
- As the presenter, I show a believable rentals site and then its records as an API.
- As the schema agent, I find "Listing (2,341), Agent (88), Open House (40)".
- As the demo, I change 30 prices and the changes feed shows exactly those.

## Screens
D01 Home / search · D02 Listing · D03 Agent and Open House · D04 Gate 402 page

## Logic
1. Separate Render web service `apps/demo-site` (Express + EJS, server-rendered, no client JS needed). Footer on every page: "Fictional demo site for Spigot. Not a real business."
2. Seeded data (`faker` with a fixed seed, so counts are stable): **2,341 listings**, **88 agents**, **40 open houses**. Austin-area neighbourhood names are fine (geography isn't a brand). Brokerage names are invented. Phone numbers use the `555-01xx` fictional range; emails use `@example.com`.
3. Pages:
   - `/listings/:slug` with schema.org JSON-LD (`Apartment` + `Offer` with `price`, `priceCurrency`, `numberOfRooms`, `floorSize`, `address`), plus visible HTML for the same facts and two fields **only** in HTML (`available_from`, `pets_allowed`) so the AI must mix JSON-LD and CSS.
   - `/agents/:slug`: no JSON-LD; stable class names (`.agent-name`, `.agent-phone`, `dl.facts`).
   - `/open-houses/:id`: no JSON-LD; date and time in a `<time datetime>` element.
   - `/`, `/search` (HTML only, not gated), `/about`, `/blog/:slug` (10 posts, unstructured: the agent should skip them).
   - `/sitemap.xml` with `<lastmod>` per URL from the data's `updated_at`; `/robots.txt`.
   - `/.well-known/spigot.txt` served from env `SPIGOT_VERIFY_TOKEN`.
4. ETag on every page (hash of rendered HTML) and `304` support.
5. `spigot-gate` installed as Express middleware before the routes (02).
6. Mutate script `npm run demo:mutate -- --prices 30 --leased 5 --new 3` (labelled "demo mutation" in the audit):
   - changes 30 listing rents by ±3–8%,
   - marks 5 as leased (status change),
   - adds 3 new listings,
   - bumps `updated_at` and sitemap `lastmod`;
   - optionally calls `POST /api/sites/:id/ping` (P1) with the changed URLs.
7. Redesign switch `DEMO_LAYOUT=v2` (P1, for the drift demo): renames the listing page's CSS classes and moves `available_from`.

## Data
Local SQLite or JSON file in the demo-site service (it is a separate "publisher", it must not share Spigot's DB).

## Edge cases
| Case | Handling |
|---|---|
| Judges visit the demo site in a browser | Humans pass the gate; the site works normally |
| Render free instance sleeps | Use a paid starter instance for the demo period (Dec 21) or warm it before recording |
| Real brand look-alikes | Invented names only; reviewed before recording |

## Acceptance criteria
- [ ] Counts exactly 2,341 / 88 / 40 after seed; sitemap lists every page with lastmod.
- [ ] Listing pages validate as schema.org JSON-LD.
- [ ] `demo:mutate` changes exactly the requested counts and is reproducible with a seed.
- [ ] No real business, brand, person or phone number appears.

## Test plan
Unit: seed counts; mutate diff counts. Manual: browse D01–D03; curl sitemap; curl with `If-None-Match` returns 304.
