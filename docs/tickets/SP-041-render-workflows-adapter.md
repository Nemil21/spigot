# SP-041: Render Workflows adapter (`WORKFLOWS_MODE=workflows`) for crawl, extract and payout tasks

- **Priority:** P0
- **Wave:** 5
- **Estimate:** 2
- **Depends on:** SP-009b, SP-014, SP-020, SP-040
- **Spec refs:** features/03 §Render Workflows layout, §Logic 7; features/09 §Logic (`payoutRun` as a Workflows task); README §Sponsors (Render Workflows)
- **Holdfast reference (read-only):** HF-030b Render Workflows settlement adapter

## Goal
Run the same task functions on Render Workflows (crawl fan-out, extraction, payout run) for the Render sponsor story, with in-process as the default and fallback.

## Files / modules
`apps/workflows/src/index.ts` (task registrations: `crawlSite`, `fetchPage`, `extractTemplate`, `extractPage`, `publishWatermark`, `payoutRun` imported from `@spigot/api/tasks`), `apps/api/src/workflows/dispatch.ts` (start run via Render API, store `workflow_run_id`), `render.yaml` workflow service.

## Scope
- `dispatch(task, args)`: `inproc` → existing queue; `workflows` → Render Workflows run; same idempotent task bodies.
- Retries per the layout table (`fetchPage` 3 on network/5xx; `payoutRun` 1, idempotent by batch id); task-level retries in our code stay the only money retry owner.
- Concurrency 2 per host preserved (Workflows fan-out limited by our semaphore table or batching).
- `GET /admin/health` reports Workflows reachability (SP-043).

## Acceptance criteria
- [ ] With `WORKFLOWS_MODE=workflows`, a crawl of the deployed demo site produces the same page and record counts as `inproc`.
- [ ] Killing a `fetchPage` run mid-way and letting Workflows retry gives no duplicate snapshots or versions.
- [ ] Flag back to `inproc` works without redeploying workflows.

## Test plan
Unit: dispatch selection. Manual on Render after deploy (post-freeze); README states which mode ran the demo.

## Notes & risks
High risk for the time budget; in-process stays the demo default if this isn't green.
