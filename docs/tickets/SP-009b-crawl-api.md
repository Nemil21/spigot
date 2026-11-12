# SP-009b: Crawl API: `POST /crawl`, resume PAUSED, runs list, progress SSE, verify → discovery crawl

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1
- **Depends on:** SP-009a2, SP-008a
- **Spec refs:** api.md §`POST /api/sites/:id/crawl`, §`GET /api/sites/:id/crawl-runs`, §`GET /api/crawl-runs/:id/events`; features/03 §Logic 3, 6; data-model.md §Site state machine

## Goal
Publishers start and watch crawls; verifying a site starts the discovery crawl automatically.

## Files / modules
`apps/api/src/routes/crawl.ts`; subscription to SP-008a's `site.verified` hook.

## Scope
- `POST /api/sites/:id/crawl` (Idempotency-Key, `trigger` `MANUAL` default, `DEMO_MUTATE` allowed for the demo) → 202 `{crawlRunId, workflowRunId}`; live run → 409 `CRAWL_IN_PROGRESS` with its id. Site must be VERIFIED / PROPOSING / READY.
- `GET /api/sites/:id/crawl-runs?limit=20`.
- `GET /api/crawl-runs/:id/events` SSE: `progress` (counters), `done` (final status); backed by `LISTEN crawl_progress`. NOTIFY keeps no history, so **every (re)connect first sends a snapshot of the run's current counters** (from `crawl_runs`), then live events.
- On `site.verified` → `crawlSite(siteId, 'CONNECT')`. The VERIFIED → PROPOSING move happens in SP-009a2's run end (not here); SP-012a moves PROPOSING → READY.
- **Resume:** "Crawl now" on a PAUSED site does `transition(PAUSED → READY)` and starts the run; `POST /api/sites/:id/resume` does the same without a crawl.
- Audit `CRAWL_RUN_DONE` with counters.

## Acceptance criteria
- [ ] Verify → discovery crawl starts within 1 s without another call.
- [ ] Second "Crawl now" → 409 with the live run id.
- [ ] SSE stream shows progress then `done`; a reconnect receives the current counters snapshot first.
- [ ] "Crawl now" on a PAUSED site resumes it and starts a run.
- [ ] Other publisher's site → 404.

## Test plan
Integration: verify → crawl → SSE events; conflict path.
