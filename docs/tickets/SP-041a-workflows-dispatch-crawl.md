# SP-041a: Render Workflows dispatch + crawl / extract tasks (structural 2-per-host fan-out)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1.5
- **Depends on:** SP-009b, SP-014a, SP-040
- **Spec refs:** features/03 §Render Workflows layout, §Logic 7; features/09 §Logic (`payoutRun` as a Workflows task); README §Sponsors (Render Workflows)
- **Holdfast reference (read-only):** HF-030b Render Workflows settlement adapter

## Goal
Run the crawl and extraction task functions on Render Workflows for the Render sponsor story, with in-process as the default and fallback, and with the 2-per-host politeness rule built into the shape of the fan-out.

## Files / modules
`apps/workflows/src/index.ts` (task registrations imported from `@spigot/api/tasks`), `apps/api/src/workflows/dispatch.ts`, `apps/api/src/crawl/fetchBatch.ts`.

## Scope
- `dispatch(task, args)`: `WORKFLOWS_MODE=inproc` → the existing queue; `workflows` → start a Render Workflows run and store `workflow_run_id`.
- **Structural concurrency:** in Workflows mode `crawlSite` fans out **exactly 2 `fetchBatch` tasks per host**; each runs its share of pages **sequentially** through the same `fetchPage` body with `CRAWL_MIN_GAP_MS`. No semaphore table; the invariant holds by construction.
- Tasks: `crawlSite`, `fetchBatch`/`fetchPage`, `extractTemplate`, `extractPage`, `publishWatermark`. Retries per spec 03's table (`fetchPage` 3 on network/5xx); idempotent bodies unchanged.
- Local Workflows dev run if the Render SDK supports one; otherwise unit tests on `dispatch` and the fan-out shape.

## Acceptance criteria
- [ ] Fan-out test: a site with 100 pages produces exactly 2 `fetchBatch` tasks, and the demo-site concurrency gauge never exceeds 2.
- [ ] `WORKFLOWS_MODE` back to `inproc` works without redeploying the workflow service.
- [ ] (If a local dev run exists) the same page and record counts as `inproc` on the scaled demo site.

## Test plan
Unit: dispatch selection and fan-out shape. Render verification is SP-041b.

## Notes & risks
In-process stays the demo default unless SP-041b is green; README says which ran.
