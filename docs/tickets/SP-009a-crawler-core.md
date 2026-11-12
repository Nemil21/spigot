# SP-009a: Crawler core: sitemap, pages, `fetchPage` (ETag, snapshots), in-process queue, SSRF guard

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 2
- **Depends on:** SP-001a, SP-002
- **Spec refs:** features/03-site-onboarding-crawl.md §Logic 3–5, 7, §Render Workflows layout, §Edge cases; data-model.md §pages, §snapshots, §crawl_runs, rule 9; features/14 §Security checklist (SSRF)

## Goal
Read a publisher's origin politely and idempotently. The crawler owns snapshots and nothing else writes them.

## Files / modules
`apps/api/src/crawl/` — `crawlSite.ts`, `fetchPage.ts`, `sitemap.ts`, `normalizeUrl.ts`, `safeFetch.ts` (undici, SSRF guard), `queue.ts` (in-process `p-queue`, concurrency 2 per host, 250 ms min gap), `hooks.ts` (`onPageChanged(pageId)`, `onRunFinished(runId)`, `onDiscoveryDone(siteId)` registries), exported from `@spigot/api/tasks`.

## Scope
- `crawlSite(siteId, trigger)`: insert `crawl_runs` QUEUED (partial unique → one live run; return the live run on conflict) → RUNNING; parse sitemap / sitemap index (cap 10k URLs; ignore off-origin URLs) → upsert `pages`; mark dropped URLs `removed_at`; pick pages that are new, `sitemap_lastmod > fetched_at`, or all on `MANUAL`; enqueue `fetchPage`.
- `fetchPage(pageId, runId)`: GET with `X-Spigot-Key: ck_…`, `User-Agent: SpigotCrawler/1.0 (+…/crawler)`, `If-None-Match`; no cookies; 10 s timeout.
  - 304 → `pages_not_modified++`.
  - 200 → gzip into `snapshots`, keep the last 2 per page, update `content_hash`, `etag`, `fetched_at`, `last_status`; unchanged hash → done; changed → call `onPageChanged(pageId)` (SP-013/SP-014 wire extraction).
  - 404/410 twice → `removed_at` and `onPageChanged`.
  - 429/503 → honour `Retry-After` (cap 10 min); 3 consecutive → run PAUSED, site PAUSED.
  - Network/5xx → retry 1 s, 4 s, 16 s, then `pages_failed++`.
- Run end: SUCCEEDED / PARTIAL / FAILED with counters; `onRunFinished(runId)`; first successful run of a VERIFIED site → `onDiscoveryDone(siteId)`.
- `safeFetch`: resolve DNS and block private / loopback / link-local ranges unless `ALLOW_LOCAL_ORIGINS=true` (dev only).
- `WORKFLOWS_MODE=inproc` is the only mode here; `workflow_run_id = inproc:<id>`. SP-041 adds the Workflows adapter over the same functions.
- Progress `notify('crawl_progress', …)` every 25 pages.
- `crawl_runs.ai_calls` stays 0 here.

## Acceptance criteria
- [ ] Full crawl of the local demo site (~2,480 pages) completes; page count = sitemap count.
- [ ] Never more than 2 concurrent requests to the origin (demo-site concurrency gauge from SP-004a).
- [ ] A second crawl with no changes fetches 0 bodies (all 304 or lastmod-skipped).
- [ ] Two `crawlSite` calls at once → one run; the second returns its id.
- [ ] A sitemap URL pointing to `http://169.254.169.254/` is never fetched.
- [ ] Killing the process mid-run and re-running produces the same snapshot hashes and no duplicate snapshots beyond 2 per page.

## Test plan
Integration against the demo site in-process (CI `db` job); stub origin for 429/503/404 paths; SSRF unit tests.

## Notes & risks
Hook registries avoid a hard dependency on SP-012a/SP-013; whichever merges second registers its handler.
