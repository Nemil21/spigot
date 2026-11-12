# SP-044b: README fresh-clone verification by another worker (FakePayPal)

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 0.5
- **Depends on:** SP-044, SP-035
- **Spec refs:** features/16 §README (P0) sections, §Test plan

## Goal
Prove the README's setup section works for someone who has never seen the repo, before the freeze.

## Scope
- A worker that didn't write SP-044 clones the repo fresh and follows the README only: `.env.example` → `.env` (with `PAYPAL_MODE=stub`), `scripts/dev-db.sh`, `npm install`, `npm run migrate`, `npm run seed:demo` against FakePayPal, start the API and demo site, open `/app` and `/c/bluebonnet`.
- Every step that needed knowledge not in the README → fix the README in this PR.

## Acceptance criteria
- [ ] Fresh clone → seeded local stack using only the README, with FakePayPal, recorded step by step in the PR description.
- [ ] Any README fix is in this PR.

## Test plan
Manual run by a second worker.
