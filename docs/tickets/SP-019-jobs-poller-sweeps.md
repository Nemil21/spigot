# SP-019: Jobs: top-up poller, ABANDONED sweep (safe), response-body purge, change retention

- **Priority:** P0
- **Wave:** 4
- **Estimate:** 1
- **Depends on:** SP-018a
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
- **The ABANDONED sweep never strands money:** it skips rows that have `paypal_capture_id` or `pending_reason`, and before abandoning it does one `pp.getOrder`; `APPROVED`/`COMPLETED` → capture/credit instead of abandoning. (`creditTopup` also accepts `ABANDONED → COMPLETED` for anything later, SP-018a.)
- Purge keeps `api_calls.served_record_keys` for 7 days (claims window, SP-048a) and nulls `response_body` after 24 h; a replay after that gets `IDEMPOTENCY_KEY_EXPIRED` (SP-016).
- Jobs are `*.job.ts` files (autoloaded, SP-001a).

## Acceptance criteria
- [ ] Buyer approves then closes the tab before our capture → poller credits within 60 s (FakePayPal approve helper).
- [ ] Poller and capture endpoint racing → one credit.
- [ ] 31-min-old unapproved top-up → ABANDONED.
- [ ] Two API processes → each job runs once per tick.
- [ ] Abandon, then capture (approval at minute 31) → credited once.
- [ ] A row with `pending_reason` set is never abandoned.

## Test plan
Integration with fake timers + FakePayPal.
