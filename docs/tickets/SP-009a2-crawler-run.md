# SP-009a2: Crawler run: `fetchPage` (ETag, snapshots), per-host queue, run lifecycle, hooks, discovery hand-off

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1.5
- **Depends on:** SP-009a1
- **Spec refs:** features/03-site-onboarding-crawl.md §Logic 3–5, 7, §Render Workflows layout, §Edge cases; data-model.md §pages, §snapshots, §crawl_runs, rule 9; features/14 §Security checklist (SSRF)

## Goal
Run a crawl politely and idempotently. The crawler owns snapshots and nothing else writes them.

## Files / modules
`apps/api/src/crawl/crawlSite.ts`, `fetchPage.ts`, `queue.ts` (in-process `p-queue`, concurrency 2 per host, min gap `CRAWL_MIN_GAP_MS`), `hooks.ts` (`onPageChanged(pageId, runId)`, `onRunFinished(runId)`, `onDiscoveryDone(siteId, runId)` registries). The task names are already stubbed in the tasks barrel (SP-001a); this ticket replaces the target files.

## Scope
- `crawlSite(siteId, trigger)`: insert `crawl_runs` QUEUED (partial unique → one live run; return the live run on conflict) → RUNNING; `readSitemap` + `upsertPages` (SP-009a1); pick pages that are new, `sitemap_lastmod > fetched_at`, or all on `MANUAL`; enqueue `fetchPage`.
- `fetchPage(pageId, runId)` via `safeFetch` with `X-Spigot-Key: ck_…`, `User-Agent: SpigotCrawler/1.0 (+…/crawler)`, `If-None-Match`:
  - 304 → `pages_not_modified++`.
  - 200 → gzip into `snapshots`, keep the last 2 per page, update `content_hash`, `etag`, `fetched_at`, `last_status`; unchanged hash → done; changed → `onPageChanged(pageId, runId)` (SP-014a wires extraction).
  - 404/410 twice → `removed_at` and `onPageChanged`.
  - 429/503 → honour `Retry-After` (cap 10 min); 3 consecutive → run PAUSED, site PAUSED.
  - Network/5xx → retry 1 s, 4 s, 16 s, then `pages_failed++`.
- **Politeness and speed:** concurrency is always ≤ 2 per host. `CRAWL_MIN_GAP_MS` defaults to 250; for a **verified origin that runs our gate** (gate seen in the last 10 min) the default is 25, which is what makes spec 03's "< 4 min" reachable.
- **Run end and discovery hand-off** (one place, in this order):
  1. Run → SUCCEEDED, PARTIAL or FAILED with counters.
  2. If this is the site's discovery run and it SUCCEEDED, **or** it is PARTIAL with ≥ 90% of pages fetched: `transition(site, VERIFIED → PROPOSING)` **inside the run-end transaction**.
  3. After commit: `onRunFinished(runId)`, then `onDiscoveryDone(siteId, runId)`.
  SP-009b no longer moves the site; SP-012a only moves PROPOSING → READY.
- `WORKFLOWS_MODE=inproc` is the only mode here; `workflow_run_id = inproc:<id>`. SP-041a adds Workflows over the same functions.
- Progress `notify('crawl_progress', {runId, counters})` every 25 pages.
- `crawl_runs.ai_calls` is untouched here (SP-012a increments it for the discovery run).

## Acceptance criteria
- [ ] Full crawl of the local demo site (~2,480 pages) completes; page count = sitemap count.
- [ ] **Timing (local, gate installed, `CRAWL_MIN_GAP_MS=25`): the full discovery crawl finishes in < 4 min.** The Render timing is SP-041b's criterion.
- [ ] Never more than 2 concurrent requests to the origin (demo-site concurrency gauge from SP-004a).
- [ ] A second crawl with no changes fetches 0 bodies (all 304 or lastmod-skipped).
- [ ] Two `crawlSite` calls at once → one run; the second returns its id.
- [ ] A PARTIAL discovery run with 95% of pages fetched still moves the site to PROPOSING and fires `onDiscoveryDone`; one with 50% doesn't.
- [ ] Killing the process mid-run and re-running produces the same snapshot hashes and no duplicate snapshots beyond 2 per page.

## Test plan
- CI (`*.db.test.ts`): crawl the demo site seeded at `DEMO_SEED_SCALE=0.05` (~125 pages) in-process; stub origin for 429/503/404.
- Local, once: the full-size timing run, numbers pasted in the PR.

## Notes & risks
Hook registries avoid a hard dependency on SP-012a/SP-013; whichever merges second registers its handler.
