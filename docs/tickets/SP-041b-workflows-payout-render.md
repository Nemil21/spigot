# SP-041b: Render Workflows `payoutRun` task, workflow service, Render verification (post-freeze)

- **Priority:** P0
- **Wave:** 7
- **Estimate:** 1
- **Depends on:** SP-041a, SP-020
- **Spec refs:** features/03 §Render Workflows layout, §Acceptance criteria (< 4 min on Render); features/09 §Logic (`payoutRun` as a task)

## Goal
Finish the Workflows story on Render: the payout run as a task, the workflow service in the blueprint, and proof on the deployed demo site.

## Files / modules
`apps/workflows/src/index.ts` (`payoutRun`), `render.yaml` (workflow service), `docs/deploy.md` (Workflows section).

## Scope
- Register `payoutRun` (1 retry; idempotent by batch id; Render-level retries off for money, SP-020 is the only retry owner).
- Workflow service in `render.yaml` with the same env group.
- Post-freeze verification on Render: `WORKFLOWS_MODE=workflows` crawl of the deployed demo site, timing recorded.

## Acceptance criteria
- [ ] On Render, a Workflows crawl produces the same page and record counts as `inproc`.
- [ ] **Spec 03's timing criterion on Render:** connect + verify + discovery crawl of the demo site in < 4 min (with the gate installed and the short gap from SP-009a2), or the measured time and the reason recorded in the README.
- [ ] Killing a `fetchBatch` run mid-way and letting Workflows retry gives no duplicate snapshots or versions.
- [ ] A `payoutRun` through Workflows on FakePayPal creates one batch.

## Test plan
Manual on Render after deploy (post-freeze); FakePayPal test for the task wrapper.

## Notes & risks
Post-freeze and human-assisted (Render account). Not needed for the video.
