# Security checklist (SP-042)

Each item from [features/14 §Security checklist](spec/features/14-auth-security-ops.md#security-checklist)
and [§Acceptance criteria](spec/features/14-auth-security-ops.md#acceptance-criteria), ticked with the
code that enforces it and the test that proves it. CI runs every test listed: `*.test.ts` in the
`check` job (`npm test`, after `npm run build`), `*.db.test.ts` in the `db` job (Postgres), and
gitleaks plus `npm audit` in the `security` job ([ci.yml](../.github/workflows/ci.yml)).

## Security checklist

- [x] **Secrets only in env (Render env vars, local `.env`); `.env.example` committed; secret scan
      before every push.**
  - `.env` and `.env.*` are git-ignored, `.env.example` is committed with every key and no values:
    [`.gitignore`](../.gitignore), [`envExample.test.ts`](../apps/api/src/envExample.test.ts).
  - Config comes from env only: [`config.ts`](../apps/api/src/config.ts),
    [`config.test.ts`](../apps/api/src/config.test.ts).
  - Secret scan: `npm run security:secrets` ([`scripts/secret-scan.sh`](../scripts/secret-scan.sh),
    gitleaks over the full history) runs in the CI `security` job on every PR and push to main.
    Run it locally before pushing; run it once more by hand before the repo goes public
    (features/14 §Test plan).
- [x] **PayPal client secret never sent to the browser; JS SDK v6 uses the client id only.**
  - The portal gets the client id from `GET /api/buyer/paypal-config`:
    [`buyer-portal.db.test.ts`](../apps/api/src/routes/buyer-portal.db.test.ts).
  - The built bundle has no server-only env names, no `client_secret`, and not the real secret
    value: [`apps/web/src/bundle-secrets.test.ts`](../apps/web/src/bundle-secrets.test.ts) (SP-032).
  - The built bundle has no whole Spigot key (`sk_spg_…`, `gk_…`, `ck_…`; the display prefix
    `sk_spg_<prefix>…` is allowed): [`security/web-bundle.test.ts`](../apps/api/src/security/web-bundle.test.ts).
- [x] **Zod validation on every input; amounts are integers; top-up 500–50,000 cents; prices
      100–100,000 micros.**
  - Every route parses its body / query with Zod through `parse()` in
    [`http/errors.ts`](../apps/api/src/http/errors.ts) (a failure is `400 VALIDATION_ERROR`).
  - Top-up amounts: `createTopupBody` in [`topups/createTopup.ts`](../apps/api/src/topups/createTopup.ts),
    `topupRequestBody` in [`routes/v1-topups.ts`](../apps/api/src/routes/v1-topups.ts);
    tests: "validates the amount ($5–$500) and the method" in
    [`topups.db.test.ts`](../apps/api/src/topups/topups.db.test.ts), and
    [`topupHelpers.db.test.ts`](../apps/api/src/topups/topupHelpers.db.test.ts).
  - Prices: `PRICE_MIN_MICROS` / `PRICE_MAX_MICROS` in
    [`datasets/patch.ts`](../apps/api/src/datasets/patch.ts); out-of-range prices are a 400 in
    [`datasets.db.test.ts`](../apps/api/src/datasets/datasets.db.test.ts).
  - Money is integer micros/cents end to end: [`ledger.db.test.ts`](../apps/api/src/ledger/ledger.db.test.ts).
- [x] **SQL filters built from the schema allowlist with parameters only.**
  - [`records/filters.ts`](../apps/api/src/records/filters.ts) builds SQL only from the active
    schema's visible, filterable fields, with values as parameters:
    [`records/filters.test.ts`](../apps/api/src/records/filters.test.ts) (`servedFields`,
    `parseQueryFilters`, `filterSql`, `fieldExpr`).
  - A hidden field can't be filtered on, even when its schema entry says filterable (400 on REST,
    a tool error on MCP): [`security/hidden-fields.db.test.ts`](../apps/api/src/security/hidden-fields.db.test.ts).
- [x] **Rate limits: REST 60/min/key, MCP 30/min/key, publisher API 120/min/user, gate hits
      1 post/5 s/site, ping 1/10 s/site.**
  - Buckets: [`http/rateLimit.ts`](../apps/api/src/http/rateLimit.ts);
    [`http/plumbing.test.ts`](../apps/api/src/http/plumbing.test.ts) (bucket behaviour, gate hits
    1 per 5 s, per-key override, 121st publisher request → 429).
  - REST 60/min/key: "the 61st call in a minute → 429" in [`routes/v1.db.test.ts`](../apps/api/src/routes/v1.db.test.ts).
  - MCP 30/min/key: "rate limit: 30 requests a minute per key" in [`mcp/mcp.db.test.ts`](../apps/api/src/mcp/mcp.db.test.ts).
  - Gate hits: "a post within 5 s of the previous one → 429" in [`gate/gate.db.test.ts`](../apps/api/src/gate/gate.db.test.ts).
  - Ping 1/10 s/site: the `ping` bucket exists; its route `POST /api/sites/:id/ping` is SP-055
    (P1), which adds the test with the route. **Not testable until SP-055 merges.**
- [x] **Crawler sends no cookies, only sitemap URLs on the verified origin, max 2 concurrent; SSRF
      guard (resolve and block private IP ranges, except the local demo in dev).**
  - One fetch path, [`crawl/safeFetch.ts`](../apps/api/src/crawl/safeFetch.ts):
    [`safeFetch.test.ts`](../apps/api/src/crawl/safeFetch.test.ts) (no cookies sent, `Set-Cookie`
    dropped; metadata / loopback / private / rebinding / redirect hops blocked; `allowLocal` never
    admits metadata or link-local).
  - Sitemap URLs off the origin are ignored: [`crawl/sitemap.test.ts`](../apps/api/src/crawl/sitemap.test.ts).
  - Max 2 concurrent per host: "never runs more than 2 at once" in
    [`crawl/queue.test.ts`](../apps/api/src/crawl/queue.test.ts).
  - Through the real routes, observed with hit-counting listeners:
    [`security/ssrf.db.test.ts`](../apps/api/src/security/ssrf.db.test.ts): connect with
    loopback / private / CGNAT / metadata / IPv4-mapped / integer-encoded origins → 400 and no
    request; a crawl of a site row on loopback makes no request; with `ALLOW_LOCAL_ORIGINS` (dev
    demo), sitemap URLs on other private hosts and a `sitemap_url` on another host are never
    fetched, and metadata / link-local origins are still refused.
- [x] **CSRF: SameSite cookies + origin check on mutating routes.**
  - [`plugins/30-csrf.ts`](../apps/api/src/plugins/30-csrf.ts); "mutating /api routes need a
    same-origin Origin" in [`http/plumbing.test.ts`](../apps/api/src/http/plumbing.test.ts);
    cookie attributes in [`auth/auth.db.test.ts`](../apps/api/src/auth/auth.db.test.ts).
- [x] **Logs redact API keys, emails and PayPal tokens.**
  - [`http/redact.ts`](../apps/api/src/http/redact.ts); "strips keys, emails and PayPal tokens"
    and "redacts secret-named keys and nested values" in
    [`http/plumbing.test.ts`](../apps/api/src/http/plumbing.test.ts);
    [`auth/auth.db.test.ts`](../apps/api/src/auth/auth.db.test.ts) and
    [`paypal/client.test.ts`](../apps/api/src/paypal/client.test.ts).
- [x] **`npm audit` clean of highs.**
  - `npm run security:audit` (`npm audit --audit-level=high`) in the CI `security` job. At SP-042's
    merge: 0 high / 0 critical (7 moderate, all transitive).

## Acceptance criteria (features/14)

- [x] **Cross-tenant tests pass.**
  [`security/tenancy-matrix.db.test.ts`](../apps/api/src/security/tenancy-matrix.db.test.ts) runs
  every case in [`security/tenancy/*.cases.ts`](../apps/api/src/security/tenancy/) (glob-loaded)
  with two publishers and two buyers: A's session on B's ids → 404, the same as a missing id; admin
  routes → 403 for a non-admin; B's ids smuggled into query / body are ignored; no reply carries B's
  ids, emails or names; `/mcp` with B's session id → 404; and B's rows are unchanged at the end.
  [`security/tenancy-coverage.test.ts`](../apps/api/src/security/tenancy-coverage.test.ts) checks
  Fastify's route table: every route with a `:param` or under `/api/publishers/me`, `/api/buyer`,
  `/api/sites`, `/api/datasets` has a case; a new route without a case file fails it (meta-tests).
- [x] **Revoked API key → 401 on REST and MCP.**
  [`security/revoked-keys.db.test.ts`](../apps/api/src/security/revoked-keys.db.test.ts): revoked
  from the portal, then every key-gated `/v1` route (from the route table) → `401 KEY_REVOKED`;
  MCP refuses a new session and stops the key's already-open session on its next request; nothing
  is charged.
- [ ] **Bad webhook signature → 401, nothing processed.** The case is written in
  [`security/revoked-keys.db.test.ts`](../apps/api/src/security/revoked-keys.db.test.ts) and skips
  until SP-059 registers `POST /webhooks/paypal`; it runs then with no edit. **Open until SP-059.**
- [x] **Injection fixture doesn't change the proposed schema** (SP-012a:
  [`injection-listing.html`](../apps/api/src/schema-agent/__fixtures__/injection-listing.html) in
  [`schemaAgent.test.ts`](../apps/api/src/schema-agent/schemaAgent.test.ts) and
  [`propose.db.test.ts`](../apps/api/src/schema-agent/propose.db.test.ts)) **; hidden fields can't
  be reached by any endpoint.** [`security/hidden-fields.db.test.ts`](../apps/api/src/security/hidden-fields.db.test.ts):
  `agent_phone` hidden by the owner (v1 visible, active v2 hidden); every `/v1` GET in the route
  table (records, record, changes with and without `include=record`, quote, describe, catalog) and
  every MCP tool the server lists never return the field name or a value; filtering on it → 400 /
  tool error. A new MCP tool fails the sweep until it is added to it.

## Manual steps (not automatable here)

1. Before the repo goes public: run `npm run security:secrets` (gitleaks over the full history)
   locally and confirm it is clean.
2. In Render: confirm `ALLOW_LOCAL_ORIGINS` is unset (it is forced off in production anyway), and
   that `PAYPAL_CLIENT_SECRET`, `SESSION_SECRET` and `ANTHROPIC_API_KEY` are set only as env vars.
