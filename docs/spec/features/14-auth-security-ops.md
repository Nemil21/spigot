# 14: Auth, Security, Tenancy & Ops

**Priority:** P0 (sessions, API keys, tenancy filter, secrets, audit rows, injection guards) · P1 (Log in with PayPal for publishers, admin screen) · **Owner:** B · **Effort:** 1.5 h

## Purpose
Keep money correct, keep publishers isolated, keep hidden fields hidden, and keep untrusted web content from steering the AI. Small surface, strict rules.

## Auth
| Who | Method | Session |
|---|---|---|
| Publishers | Email + password (argon2) in P0; Log in with PayPal (OIDC) in P1, which also fills a verified payout email | HttpOnly, Secure, SameSite=Lax cookie; 12 h |
| Buyers (portal) | Email + password | Cookie; 30 days |
| Buyers (API, MCP) | Bearer API key `sk_spg_…` (SHA-256 hashed, prefix shown), scopes `read`, `topup` | Per request |
| Gate | Per-site gate key `gk_…` (hashed) | Per request |
| Crawler → origin | Per-site crawl key `ck_…`; the gate compares SHA-256 in constant time | Per request |
| Admin | Allowlisted emails, role ADMIN | Cookie |
| PayPal webhooks | `verify-webhook-signature` | None |

## Tenancy rules
- Every publisher query filters by `publisher_id` from the session (helper `forPublisher(id)`), never from the body.
- Buyers see only their own balance, calls, claims, top-ups.
- Data API returns only LIVE datasets and only `visible` fields (serializer allowlist, data-model rule 13).
- Tests: every publisher endpoint called with another publisher's ids returns 404.

## AI safety
- **Schema agent:** crawled HTML is untrusted. System prompt says so; only one output tool; output Zod-validated; extractor DSL has no code execution (whitelisted transforms, RE2-safe regex); PII/rights guard runs after the model regardless of what it said. Fixture test with an injection page.
- **Claims agent:** claim text is untrusted; output is a recommendation only; a human (publisher) or deterministic rule decides money.
- **No LLM calls PayPal.** Money moves only through backend services with caps (per-call max, monthly auto top-up cap, refundable amount).

## Security checklist
- [ ] Secrets only in env (Render env vars, local `.env`); `.env.example` committed; secret scan before every push.
- [ ] PayPal client secret never sent to the browser; JS SDK v6 uses the client id only.
- [ ] Zod validation on every input; amounts are integers; top-up 500–50,000 cents; prices 100–100,000 micros.
- [ ] SQL filters built from the schema allowlist with parameters only.
- [ ] Rate limits: REST 60/min/key, MCP 30/min/key, publisher API 120/min/user, gate hits 1 post/5 s/site, ping 1/10 s/site.
- [ ] Crawler sends no cookies, only sitemap URLs on the verified origin, max 2 concurrent; SSRF guard (resolve and block private IP ranges, except the local demo in dev).
- [ ] CSRF: SameSite cookies + origin check on mutating routes.
- [ ] Logs redact API keys, emails and PayPal tokens.
- [ ] `npm audit` clean of highs.

## Audit and ops (P0 rows, P1 screen)
- `audit_events` row for: site connected/verified, crawl run done, schema proposed/approved, dataset published/unpublished, top-up created/completed/failed, call charged (sampled for SIM), claim decided, refund, payout sent/settled/returned. PayPal ids on every money row.
- W14 (P1): search by publisher, buyer or PayPal id; health tiles; ledger check; run payout now.
- `GET /admin/health` checks PayPal token, DB, Workflows, last gate hit per site, open top-ups, pending payouts.

## Acceptance criteria
- [ ] Cross-tenant tests pass.
- [ ] Revoked API key → 401 on REST and MCP.
- [ ] Bad webhook signature → 401, nothing processed.
- [ ] Injection fixture doesn't change the proposed schema; hidden fields can't be reached by any endpoint.

## Test plan
Integration tests above; manual secret scan (`gitleaks`) before making the repo public.
