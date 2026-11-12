# SP-019: Jobs: top-up poller, ABANDONED sweep, response-body purge, change retention

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1
- **Depends on:** SP-018
- **Spec refs:** features/08 §Manual top-up 6, §Edge cases; api.md §Webhooks (pollers back this up); data-model.md §Top-up state machine, §api_calls.response_body; features/05 §Logic 7

## Goal
The background loops that make money paths self-healing without webhooks.

## Files / modules
`apps/api/src/jobs/topupPoller.ts`, `sweeps.ts`, registration in `apps/api/src/jobs/index.ts` using SP-002's `runEvery` (advisory-locked, one runner across processes).

## Scope
- Every 30 s: AWAITING_APPROVAL top-ups < 30 min old → `pp.getOrder`; `APPROVED` → capture (`capture:<id>`) → `creditTopup`; `COMPLETED` → `creditTopup`.
- Every 5 min: AWAITING_APPROVAL ≥ 30 min → `ABANDONED`.
- Hourly: null `api_calls.response_body` older than 24 h; delete `record_versions` older than 30 days.
- Jobs off in tests unless enabled.

## Acceptance criteria
- [ ] Buyer approves then closes the tab before our capture → poller credits within 60 s (FakePayPal approve helper).
- [ ] Poller and capture endpoint racing → one credit.
- [ ] 31-min-old unapproved top-up → ABANDONED.
- [ ] Two API processes → each job runs once per tick.

## Test plan
Integration with fake timers + FakePayPal.
