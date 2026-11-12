# SP-042: Security tests: cross-tenant matrix, hidden-field sweep, revoked keys, SSRF, checklist

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1.5
- **Depends on:** SP-017b, SP-022a, SP-014
- **Spec refs:** features/14-auth-security-ops.md §Tenancy rules, §Security checklist, §Acceptance criteria; data-model.md rule 13

## Goal
Prove isolation and the "hidden fields never leave" rule across every endpoint, and close the checklist.

## Files / modules
`apps/api/src/security/*.test.ts`, `docs/security-checklist.md`.

## Scope
- Cross-tenant matrix: every publisher route called with another publisher's ids → 404; every buyer route with another buyer's ids → 404.
- Hidden-field sweep: hide `agent_phone`, then call every `/v1` and MCP read (records, record, changes with and without `include=record`, quote, describe) → never present; filter on it → 400.
- Revoked key → 401 on REST and MCP; bad webhook signature path stubbed for SP-059.
- SSRF: sitemap/page URLs to private ranges never fetched.
- Bundle check: no PayPal secret or `sk_spg_` in `apps/web/dist`.
- Checklist file with each item from features/14 ticked with evidence; `npm audit` clean of highs (CI security job).

## Acceptance criteria
- [ ] All matrix tests pass in CI.
- [ ] Checklist complete with links to tests.

## Test plan
CI `db` job line `apps/api/src/security` with `--maxWorkers=2`.
