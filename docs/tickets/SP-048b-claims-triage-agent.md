# SP-048b: Claims triage agent (Claude recommendation) + publisher decide endpoint

- **Priority:** P1 (spec P1 #2)
- **Wave:** 7
- **Estimate:** 1.5
- **Depends on:** SP-048a
- **Spec refs:** features/10 §Claims 3; README §Where AI shows up (claims triage); features/14 §AI safety; api.md §`GET /api/claims`, §`POST /api/claims/:id/decide`

## Goal
Unclear claims arrive at the publisher with Claude's read of them; a human decides the money.

## Files / modules
`apps/api/src/claims/triage.ts` (one Claude call, tool `recommend {decision, confidence, reason}`), routes `GET /api/claims?status=OPEN`, `POST /api/claims/:id/decide`.

## Scope
- Inputs: claim text (untrusted, delimited), served record, current record, version history, snapshot excerpt for cited fields. One tool; Zod-validated; stored in `ai_recommendation`; recorded mode for CI.
- Decide `CREDIT` → SP-048a credit; `REJECT` → REJECTED. Publisher tenancy.

## Acceptance criteria
- [ ] Ambiguous claim shows a recommendation; deciding posts CREDIT or closes it.
- [ ] Claim text with injected instructions can't produce anything but `recommend`, and never moves money.

## Test plan
Recorded-mode unit tests; injection fixture.
