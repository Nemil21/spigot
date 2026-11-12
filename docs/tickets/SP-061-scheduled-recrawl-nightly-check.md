# SP-061: Scheduled re-crawl (15 min) + nightly ledger check

- **Priority:** P1 (features 03 / 07 P1)
- **Wave:** 5
- **Estimate:** 1
- **Depends on:** SP-009b, SP-043
- **Spec refs:** features/03 §Logic 8 (schedule); features/07 §Ledger check (nightly cron); README §Tech stack (Render cron)

## Goal
Records stay fresh without pings, and the books are checked every night.

## Files / modules
`apps/api/src/jobs/schedule.ts` (`runEvery`), optional Render cron entries in `render.yaml`.

## Scope
Every 15 min per READY site: re-read sitemap, crawl changed URLs only (`trigger=SCHEDULE`; skipped if a run is live). Nightly: sitemap re-check + `ledgerCheck()`; mismatch → audit alert + health degraded.

## Acceptance criteria
- [ ] A mutate is picked up within 15 min with no manual crawl.
- [ ] An injected ledger mismatch flips `/admin/health` to degraded.

## Test plan
Integration with fake timers.
