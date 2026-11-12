# SP-060: Weekly payout cron + failed-item retry

- **Priority:** P1 (feature 09 P1)
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-021
- **Spec refs:** features/09 §Logic 9, Priority line (weekly cron, retry of failed items); data-model.md §payout_batches unique(period_end)

## Goal
Publishers get paid every Monday without anyone pressing a button.

## Files / modules
`apps/api/src/jobs/weeklyPayout.ts` (or a Render cron in `render.yaml` calling `npm run payout:weekly`).

## Scope
Monday 09:00 PT → `payoutRun('SCHEDULE')` with `period_end` unique; FAILED/RETURNED amounts are back in payable and picked up automatically; UNCLAIMED items block the publisher until resolved (rule 10).

## Acceptance criteria
- [ ] Two cron firings for the same period → one batch.
- [ ] A previously FAILED item's amount is included in the next batch.

## Test plan
Integration with fake clock + FakePayPal.
