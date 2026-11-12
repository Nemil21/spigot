# SP-007a: Auth core: publisher + buyer sessions, error envelope, CSRF, rate limits, audit + tenancy helpers, log redaction

- **Priority:** P0
- **Wave:** 2
- **Estimate:** 1.5
- **Depends on:** SP-001a, SP-002
- **Spec refs:** features/14-auth-security-ops.md §Auth, §Tenancy rules, §Security checklist, §Audit and ops; api.md §Auth, §Errors, §Publisher endpoints (auth), §Buyer portal endpoints (signup)

## Goal
The plumbing every route uses: who is calling, what they may see, how errors look, and an audit row for every important action.

## Files / modules
`apps/api/src/auth/` (`password.ts` argon2, `sessions.ts`, `publisherAuth.ts`, `buyerAuth.ts`, `admin.ts` with `ADMIN_EMAILS`), `apps/api/src/http/` (`errors.ts`, `csrf.ts`, `rateLimit.ts`, `redact.ts`), `apps/api/src/audit/audit.ts`, `apps/api/src/tenancy.ts` (`forPublisher(id)`), routes `POST /api/auth/signup|login|logout`, `POST /api/buyer/signup|login|logout`.

## Scope
- Publisher signup `{name, email, password, payoutEmail}` → publisher row; login/logout. Cookie HttpOnly, Secure, SameSite=Lax, 12 h. Buyer portal: same, 30 days, separate cookie name.
- Admin: session email in `ADMIN_EMAILS` → `requireAdmin`.
- Error envelope `{error:{code,message,details}}` with the api.md code → HTTP mapping; Zod validation → `VALIDATION_ERROR`.
- CSRF: SameSite + Origin check on mutating cookie routes.
- Rate limiter (in-memory token bucket keyed by principal): publisher API 120/min/user; helpers reused by SP-017b (60/min/key), SP-022a (30/min/key), SP-008b (1 post/5 s/site), SP-055 (1/10 s/site). 429 with `Retry-After`.
- `audit(tx, {actorType, actorId, publisherId, entity, entityId, action, paypalId?, data})`.
- `forPublisher(sessionPublisherId)` query helper; ids always from the session, never the body.
- Log redaction: API keys (`sk_spg_`, `gk_`, `ck_`), emails, PayPal tokens/`EC-` ids.

## Acceptance criteria
- [ ] Signup → login → `/api/auth/me` works for both roles; wrong password → 401 `UNAUTHENTICATED`.
- [ ] Mutating route without a same-origin `Origin` → 403.
- [ ] 121st publisher request in a minute → 429 with `Retry-After`.
- [ ] Logged request lines never contain a full key or email (test with a fake key).
- [ ] `audit()` rows can't be updated or deleted (SP-002 trigger).

## Test plan
Integration (supertest + Postgres): auth flows, CSRF, rate limit, redaction.

## Notes & risks
Log in with PayPal is P1 (SP-058).
