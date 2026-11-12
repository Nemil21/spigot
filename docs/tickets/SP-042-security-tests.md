# SP-042: Security tests: route-table tenancy matrix, hidden-field sweep, revoked keys, SSRF, checklist

- **Priority:** P0
- **Wave:** 6
- **Estimate:** 1.5
- **Depends on:** SP-017b, SP-022a, SP-014a
- **Spec refs:** features/14-auth-security-ops.md §Tenancy rules, §Security checklist, §Acceptance criteria; data-model.md rule 13

## Goal
Prove isolation and the "hidden fields never leave" rule across every endpoint, and close the checklist.

## Files / modules
`apps/api/src/security/*.test.ts`, `docs/security-checklist.md`.

## Scope
- **Cross-tenant matrix generated from Fastify's route table:** after `app.ready()`, enumerate every route that has a `:id`-style param or lives under `/api/publishers/me`, `/api/buyer` or `/api/sites`/`/api/datasets`. Each must have a case (publisher A's session against publisher B's ids → 404; buyer A against buyer B → 404). **A route with no case fails the test**, so routes that merge after this ticket can't slip through.
- Cases live in `apps/api/src/security/tenancy/*.cases.ts` (glob-loaded; one file per route ticket, no shared file). This ticket writes the cases for every route that exists at its merge; later route tickets add their own file (INDEX rule).
- Hidden-field sweep: hide `agent_phone`, then call every `/v1` and MCP read (records, record, changes with and without `include=record`, quote, describe) → never present; filter on it → 400.
- Revoked key → 401 on REST and MCP; bad webhook signature path stubbed for SP-059.
- SSRF: sitemap/page URLs to private ranges never fetched.
- Bundle check: no PayPal secret or `sk_spg_` in `apps/web/dist`.
- Checklist file with each item from features/14 ticked with evidence; `npm audit` clean of highs (CI security job).

## Acceptance criteria
- [ ] All matrix tests pass in CI.
- [ ] Checklist complete with links to tests.
- [ ] Adding a new tenant-scoped route without a case file makes the matrix test fail (meta-test).

## Test plan
`apps/api/src/security/*.db.test.ts` (the `db` project; no `ci.yml` edit).
