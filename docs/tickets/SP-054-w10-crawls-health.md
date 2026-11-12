# SP-054: W10 Crawls & health

- **Priority:** P1 (spec P1 #6)
- **Wave:** 5
- **Estimate:** 1.5
- **Depends on:** SP-024, SP-009b
- **Spec refs:** screens.md §W10; features/03 §Screens; features/04 §6 (AI calls column)

## Goal
Show the crawler is polite and that routine crawls use **0 AI calls**.

## Files / modules
`apps/web/src/pages/Crawls.tsx`.

## Scope
- Runs table: trigger, pages fetched / not modified / failed, records added / updated / removed, **AI calls: 0**, duration, status; running progress via crawl SSE; paused state ("Your site returned 429…"); drift alerts (when SP-052a is in); "Crawl now".

## Acceptance criteria
- [ ] Post-approval runs show AI calls 0; discovery run shows the proposal call count.

## Test plan
Component tests with fixtures.
