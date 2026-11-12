# SP-007b: Buyer API keys: create / revoke, Bearer auth, scopes

- **Priority:** P0
- **Wave:** 3
- **Estimate:** 1
- **Depends on:** SP-007a
- **Spec refs:** api.md §Buyer portal endpoints (keys), §Auth; data-model.md §api_keys; features/14 §Auth

## Goal
`sk_spg_…` keys that authenticate REST `/v1` and MCP calls, hashed at rest, revocable instantly.

## Files / modules
`apps/api/src/auth/apiKeys.ts` (`createKey`, `revokeKey`, `authenticateBearer` Fastify hook), routes `POST /api/buyer/keys`, `GET /api/buyer/keys`, `DELETE /api/buyer/keys/:id`.

## Scope
- Key = `sk_spg_` + 32 random bytes base62; store SHA-256 and the first 8 chars as `prefix`; return the key once.
- Scopes `read`, `topup`; `requireScope('topup')` helper.
- Bearer hook sets `req.buyer`, `req.apiKey`; updates `last_used_at` (throttled, at most once a minute).
- Revoked → 401 `KEY_REVOKED` immediately (no cache longer than the request).
- `rate_limit_per_min` column honoured by the limiter from SP-007a.

## Acceptance criteria
- [ ] Create returns the key once; `GET` lists prefix only.
- [ ] Bearer with a valid key → buyer resolved; unknown → 401 `UNAUTHENTICATED`; revoked → 401 `KEY_REVOKED` on the very next request.
- [ ] A buyer can't revoke another buyer's key (404).
- [ ] Key without `topup` scope → 403 on a `topup` route.

## Test plan
Integration: create/list/revoke; revoke race (revoke while 10 requests are in flight; requests after the revoke commit fail).

## Notes & risks
SP-022a reuses `authenticateBearer` for `/mcp`.
