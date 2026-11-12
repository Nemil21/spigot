# 03: Site Onboarding & Crawl (Render Workflows)

**Priority:** P0 (connect, verify, sitemap crawl, plain fetch, Workflows with in-process fallback) · P1 (Playwright render, scheduled re-crawl, ping) · **Owner:** A · **Effort:** 3 h

## Purpose
Connect a publisher's site and read it directly from the origin. No visitor capture: the crawler owns snapshots and nothing else writes them.

## User stories
- As a site owner, I paste my URL, prove I own it, and see my pages being read.
- As a site owner, I'm confident Spigot won't hammer my server (2 requests at a time, respects `Retry-After`).
- As the system, I re-crawl only what changed (sitemap `lastmod`, ETag).

## Screens
W02 Sign up + connect · W03 Install + verify + first crawl · W10 Crawls (P1)

## Logic
1. **Connect** (`POST /api/sites`): normalize origin; fetch `/robots.txt` and `/sitemap.xml` (or sitemap index) with a 5 s timeout; create site `PENDING_VERIFY`; generate `verify_token`, gate key, crawl key (store only SHA-256 hashes; show keys once).
2. **Verify** (`POST /api/sites/:id/verify`): GET `/.well-known/spigot.txt`, compare content. Demo: the demo site's env already holds the token.
3. **Discovery crawl** (`crawlSite(siteId, trigger)` on Render Workflows):
   1. Insert `crawl_runs` (partial unique index → one live run per site).
   2. Parse sitemap(s) → upsert `pages` (url, lastmod). URLs not in the sitemap are never fetched. URLs dropped from the sitemap get `removed_at`.
   3. Select pages to fetch: new, or `sitemap_lastmod > fetched_at`, or `trigger=MANUAL` (all).
   4. Fan out `fetchPage(pageId)` tasks, **concurrency 2 per host**, 250 ms min gap.
4. **`fetchPage`**:
   - GET with headers `X-Spigot-Key: <crawl key>`, `User-Agent: SpigotCrawler/1.0 (+https://spigot…/crawler)`, `If-None-Match: <etag>`.
   - 304 → `pages_not_modified++`, done.
   - 200 → gzip HTML into `snapshots`, update `content_hash`, `etag`, `fetched_at`; keep 2 snapshots per page.
   - If content hash unchanged → skip extraction.
   - Else, if the page's template has a LIVE dataset → call `extractPage(pageId)` (05).
   - 404/410 twice → `removed_at` (emits `remove` changes for its records).
   - 429/503 → honor `Retry-After` (cap 10 min); 3 consecutive → run PAUSED, site PAUSED (dashboard "crawl paused").
5. After all pages: `publishWatermark(datasetId)` for each touched dataset (rule 7 in data-model), mark run SUCCEEDED / PARTIAL, SSE `crawl.progress` / `done`.
6. First successful discovery crawl → template clustering + schema agent (04).
7. **Fallback:** env `WORKFLOWS_MODE=inproc` runs the same task functions on an in-process queue (`p-queue`, same concurrency). Same code, so the demo never depends on Workflows being up. The run records `workflow_run_id = inproc:<id>`.
8. **Schedule (P1):** Render cron every 15 min: re-read sitemaps, crawl changed URLs only. **Ping (P1):** `POST /api/sites/:id/ping` queues just the given URLs.
9. **Render (P1):** if a template's sample pages have little text and lots of `<script>`, fetch through Playwright (headless Chromium) for that template only. The demo site is server-rendered, so P0 doesn't need it.

## Render Workflows layout
| Task | Input | Fan-out | Retries |
|---|---|---|---|
| `crawlSite` | siteId, trigger | → N × `fetchPage` | 1 |
| `fetchPage` | pageId, runId | → 0–1 × `extractPage` | 3 (1 s, 4 s, 16 s) on network/5xx |
| `extractTemplate` | datasetId (on approve) | → batches of 200 snapshots | 2 |
| `extractPage` | pageId, datasetId | — | 2 |
| `publishWatermark` | datasetId, runId | — | 3 |
| `payoutRun` | trigger (09) | — | 1 (idempotent by batch id) |

Each task is idempotent: re-running `fetchPage` writes the same snapshot hash; `extractPage` upserts by `record_key` with hash compare (no duplicate versions).

## Edge cases
| Case | Handling |
|---|---|
| No sitemap | P0: error "Add a sitemap.xml". P2: link-following discovery |
| Sitemap with 50k+ URLs | Cap 10k per site for the hackathon; show "first 10,000 pages" |
| URL outside origin in sitemap | Ignored |
| Login-only or paywalled pages | Never fetched: crawler sends no cookies; owner attests fields are theirs (04) |
| Origin slow (> 10 s) | Timeout, retry later, counted as failed |
| Worker dies mid-run | Workflows retries the task; idempotent writes |
| Two "Crawl now" clicks | Second returns the live run id (409 with id) |

## Acceptance criteria
- [ ] Connect + verify + discovery crawl of the demo site (~2,500 pages) finishes in < 4 min on Render.
- [ ] Never more than 2 concurrent requests to the origin (asserted from demo-site access logs).
- [ ] A second crawl with no changes fetches 0 bodies (all 304 or lastmod-skipped).
- [ ] With `WORKFLOWS_MODE=inproc`, the same crawl produces identical page and record counts.
- [ ] The crawler's requests appear as `SPIGOT_CRAWLER` in the gate's counts, never as 402s.

## Test plan
Integration against the demo site locally (both modes). Chaos: kill the worker during `fetchPage` fan-out and resume. Manual: watch W03 progress during the first crawl.
