# API Spec

Two surfaces on one Fastify service:
- **Publisher + buyer-portal API:** `https://<spigot-app>/api/…` (session cookie).
- **Buyer data API:** `https://<spigot-app>/v1/…` (API key). This is the product. Described in `openapi.yaml` (generated from Zod), which feeds APIMatic (P1).

JSON in and out. Prices and balances in the data API are in **micros** (`…Micros`, integer) with a display string; PayPal amounts are in **cents** (`…Cents`).

**Auth:**
- **Publishers:** session cookie (email + password in P0; Log in with PayPal in P1).
- **Buyers (portal):** session cookie.
- **Buyers (data API, MCP):** `Authorization: Bearer sk_spg_…` (API key, hashed at rest, scopes `read`, `topup`).
- **Gate:** `Authorization: Bearer gk_…` (per-site gate key).
- **Crawler → publisher origin:** `X-Spigot-Key: ck_…` (per-site crawl key; the gate compares its SHA-256 locally).
- **Webhooks:** PayPal signature via `verify-webhook-signature`.

**Errors:** `{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "...", "details": {} } }`

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_ERROR`, `UNSUPPORTED_FILTER` |
| 401 | `UNAUTHENTICATED`, `KEY_REVOKED` |
| 402 | `PAYMENT_REQUIRED` (no balance / unauthenticated bot), `INSUFFICIENT_BALANCE`, `PRICE_ABOVE_MAX` |
| 403 | `FORBIDDEN`, `SITE_NOT_VERIFIED` |
| 404 | `NOT_FOUND` |
| 409 | `STATE_CONFLICT`, `IDEMPOTENCY_MISMATCH`, `CRAWL_IN_PROGRESS` |
| 410 | `DATASET_UNPUBLISHED`, `CURSOR_EXPIRED` |
| 422 | `TOPUP_FAILED`, `AUTO_TOPUP_CAP_REACHED`, `REFUND_EXCEEDS_UNUSED` |
| 429 | `RATE_LIMITED` |
| 502 | `PAYPAL_ERROR`, `ORIGIN_ERROR` |

Mutating calls and paid reads take an `Idempotency-Key` header.

## PayPal calls used (all sandbox, direct REST)

Client copied from `spikes/paypal-spikes.mjs`: token cache, `PayPal-Request-Id` on every call, `Prefer: return=representation`.

| Name | Call | Notes | Proven |
|---|---|---|---|
| `pp.token` | `POST /v1/oauth2/token` | Cache until `expires_in - 60s` | S1–S4 |
| `pp.createTopupOrder` | `POST /v2/checkout/orders` `{intent:"CAPTURE", purchase_units:[{amount, custom_id: topupId, description:"Spigot balance top-up"}], payment_source}` | `PayPal-Request-Id: topupId`. Sources: `paypal.experience_context{return_url, cancel_url, user_action:"PAY_NOW"}` (wallet, approval) · `card` + `attributes.vault.store_in_vault: ON_SUCCESS` (first card top-up, captured immediately) · `card.vault_id` + `stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT}` (auto top-up, no buyer present) · `paypal.vault_id` (wallet vault, if S8b passes) | Orders + card: S1/S2 (AUTHORIZE). CAPTURE intent: **S7**. Vault MIT with CAPTURE: **S8** |
| `pp.captureOrder` | `POST /v2/checkout/orders/{id}/capture` | After wallet approval. `PayPal-Request-Id: capture:<topupId>` | **S7** |
| `pp.getOrder` | `GET /v2/checkout/orders/{id}` | Return-URL and poller fallback | S1 |
| `pp.refundCapture` | `POST /v2/payments/captures/{captureId}/refund` `{amount, note_to_payer}` | Partial refund of unused balance. `PayPal-Request-Id: balanceRefundId` | **S9** |
| `pp.payout` | `POST /v1/payments/payouts` `{sender_batch_header:{sender_batch_id: batchId, email_subject:"Your Spigot earnings"}, items:[{recipient_type:"EMAIL", receiver, amount:{value, currency:"USD"}, sender_item_id: itemId, note:"Spigot: 8,112 records sold, Nov 4–11"}]}` | One batch, one item per publisher | S4 (single item). Multi-item + statuses: **S10** |
| `pp.getPayoutBatch` | `GET /v1/payments/payouts/{payout_batch_id}` | Poll every 60 s for 30 min after submit | **S10** |
| `pp.verifyWebhook` | `POST /v1/notifications/verify-webhook-signature` | | **S11** |
| Test only | Header `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` | Demo a failed auto top-up | S3 |

## Gate endpoints (called by `spigot-gate`, never on the request path)

### `GET /api/gate/policy` (gate key)
```json
{ "siteId": "…", "policyVersion": 3, "apiBase": "https://spigot.onrender.com/v1/bluebonnet",
  "catalogUrl": "https://spigot.onrender.com/c/bluebonnet",
  "crawlKeySha256": "9f1c…",
  "gatedPaths": ["^/listings/", "^/agents/", "^/open-houses/"],
  "decisions": { "SEARCH": "PASS", "AI_TRAINING": "QUOTE", "AI_AGENT": "QUOTE", "SCRAPER_TOOL": "QUOTE", "UNKNOWN": "PASS" },
  "prices": [ { "dataset": "listings", "perRecordMicros": 1500, "display": "$1.50 per 1,000 records" } ] }
```
The gate fetches this at boot and every 60 s in the background (2 s timeout). On failure it keeps the last good copy; with no copy at all it passes everything.

### `POST /api/gate/hits` (gate key)
```json
{ "sentAt": "…", "buckets": [ { "bucket": "2026-11-11T17:42:00Z", "category": "AI_TRAINING", "botName": "GPTBot",
  "decision": "QUOTE_402", "hits": 41, "bytes": 0, "isSimulated": false } ] }
```
→ `204`. Fire-and-forget from the gate (2 s timeout, dropped on failure). Upserts `bot_hits`.
Every bucket carries `isSimulated` (required, no default): `true` only for SIM traffic (`SPIGOT_GATE_DEMO=1` and `X-Spigot-Sim: 1`), so simulated bots never count as real ones; it maps to `bot_hits.is_simulated`, which is part of the upsert key. Both payloads are validated by the zod schemas in `@spigot/shared/gate`.

## The 402 contract

Two places return 402 with the **same body shape**: the gate (for declared bots hitting HTML) and the data API (for unpaid or underfunded calls).

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
Link: <https://spigot.onrender.com/v1/bluebonnet/datasets/listings>; rel="alternate"; type="application/json"
Link: <https://spigot.onrender.com/c/bluebonnet>; rel="payment"
Cache-Control: no-store
Spigot-Price: listings; per-record-micros=1500
```
```json
{ "error": { "code": "PAYMENT_REQUIRED", "message": "This site sells its data as an API. Clean, typed, live records: $1.50 per 1,000." },
  "site": "Bluebonnet Rentals",
  "datasets": [ { "slug": "listings", "type": "Listing", "records": 2341, "perRecordMicros": 1500,
                  "endpoint": "https://spigot.onrender.com/v1/bluebonnet/datasets/listings/records" } ],
  "pay": { "method": "prepaid_balance", "provider": "PayPal", "topUpUrl": "https://spigot.onrender.com/buyers/topup",
           "mcp": "https://spigot.onrender.com/mcp" },
  "terms": "https://spigot.onrender.com/c/bluebonnet/terms" }
```
For the data API, `INSUFFICIENT_BALANCE` adds `"quote": { "records": 37, "priceMicros": 55500 }, "balanceMicros": 12000`.
If the request's `Accept` prefers `text/html`, the gate returns a small static HTML page with the same facts (D04).

## Publisher endpoints (`/api`, session)

### `POST /api/auth/signup` `{ "name", "email", "password", "payoutEmail" }` → `201 { "publisherId" }` · `POST /api/auth/login` · `POST /api/auth/logout`

### `POST /api/sites`
```json
{ "origin": "https://bluebonnet-rentals.onrender.com" }
```
→ `201`
```json
{ "siteId": "…", "slug": "bluebonnet", "status": "PENDING_VERIFY",
  "verify": { "path": "/.well-known/spigot.txt", "content": "spigot-verify=7d1e…" },
  "gateKey": "gk_…", "crawlKey": "ck_…",
  "install": "npm i @spigot/gate  →  app.use(spigotGate({ gateKey: process.env.SPIGOT_GATE_KEY, apiBase: 'https://spigot.onrender.com' }))" }
```
Keys are shown once (W03).

### `POST /api/sites/:id/verify` → `{ "status": "VERIFIED" }` or `409 { code: "STATE_CONFLICT", message: "Token not found at /.well-known/spigot.txt" }`. On success, starts the discovery crawl.

### `POST /api/sites/:id/crawl` (Idempotency-Key) → `202 { "crawlRunId", "workflowRunId" }`. `409 CRAWL_IN_PROGRESS` returns the live run id.
### `GET /api/sites/:id/crawl-runs?limit=20` · `GET /api/crawl-runs/:id/events` (SSE: `progress`, `done`)
### `GET /api/sites/:id/gate-status` → `{ "installed": true, "lastSeenAt": "…", "policyVersion": 3 }`

### `GET /api/sites/:id/bots?from&to&includeSim=true`
```json
{ "range": { "from": "…", "to": "…", "bucketSize": "hour" }, "includeSim": true,
  "totals": { "botHits": 18420, "humanHits": 571000, "ratio": "1 bot per 31 human visits", "quoted402": 9210,
              "bytesSavedEstimate": 2.1e9, "wouldHaveEarnedMicros": 13815000,
              "estimate": true, "estimateBasis": { "perGatedPageMicros": 1500, "priceSource": "LIVE" } },
  "byBot": [ { "botName": "GPTBot", "category": "AI_TRAINING", "hits": 6120, "decision": "QUOTE_402",
               "lastSeen": "…", "bytes": 6.1e8, "wouldHavePaid": 9180000, "isSimulated": true,
               "hits24h": [0, 3, 12, "…24 hourly counts, oldest first"] } ],
  "series": [ { "bucket": "…", "category": "AI_TRAINING", "hits": 41 } ],
  "earnedThisWeek": { "micros": 412000000, "simMicros": 380000000, "simShare": 0.9223 } }
```
`wouldHaveEarnedMicros` = gated page hits × records per page × price (labelled "estimate"). Gated page hits are the `QUOTE_402` hits (`bot_hits` keeps no path); records per page is 1 for a detail template and `record_count / page_count` for a list template; the price is the page-count-weighted average over LIVE / LIVE_STALE datasets, else over proposals, else the default $1.50 / 1,000 (`estimateBasis`). `botHits` counts every category but `HUMAN`; `byBot` (no HUMAN rows) sums to it. Each `byBot` row's `hits24h` is its hits per hour over the 24 h ending at `to`, oldest first (W04 sparkline; SP-027b); for a range shorter than 24 h it still covers the full 24 h, so it may include hits before `from`. `bytesSavedEstimate` sums `bytes` of QUOTE_402 rows.
Range: half-open `[from, to)`, default the 7 days ending now, at most 92 days; `series` buckets are minutes up to 3 h, hours up to 7 days, days beyond (UTC). `includeSim=false` drops SIM rows everywhere, including `earnedThisWeek` (the publisher's net share of calls charged on this site in the last 7 days, demo-hidden calls excluded). Another publisher's site → `404`. (SP-027a)

### `GET /api/publishers/me/activity?limit=50`
```json
{ "events": [ { "id": "1234", "at": "…", "action": "CALL_CHARGED", "entity": "api_call", "entityId": "…",
                "isSimulated": false, "line": "Acme Agents: $0.0555 charged for 37 Listing records" } ] }
```
The W04 activity feed: the session publisher's newest `audit_events` (limit 1–200, default 50, newest first) with action `SCHEMA_PROPOSED`, `DATASET_PUBLISHED`, `CALL_CHARGED`, `TOPUP_COMPLETED`, `PAYOUT_SENT`, `PAYOUT_SETTLED` or `CRAWL_RUN_DONE`. `TOPUP_COMPLETED` rows carry no publisher, so the feed shows those of **their buyers** (a buyer with at least one call on this publisher's datasets), with the buyer name and amount only. `isSimulated` is true for a SIM actor, a SIM top-up, call or buyer. `line` comes from `activityLine` in `@spigot/shared` (money copy rule). Calls hidden by `demo:reset` are left out. (SP-027a)

### `GET /api/sites/:id/proposals`
```json
{ "proposals": [
  { "datasetId": "…", "schemaVersionId": "…", "typeName": "Listing", "records": 2341, "templatePattern": "/listings/:slug",
    "source": "JSON-LD (Apartment, Offer) + 2 CSS fields",
    "fields": [ { "name": "price_usd", "type": "integer", "visible": true, "pii": false, "nullRate": 0.0, "example": 1850 },
                { "name": "agent_phone", "type": "string", "visible": false, "pii": true, "nullRate": 0.02, "example": "(512) 555-0142" } ],
    "sampleRows": [ { "price_usd": 1850, "bedrooms": 3, "city": "Austin", "…": "…" } ],
    "suggestedPerRecordMicros": 1500, "aiRationale": "Listing pages carry schema.org Apartment JSON-LD…" } ] }
```

### `PATCH /api/datasets/:id`
```json
{ "fields": [ { "name": "agent_phone", "visible": false } ], "perRecordMicros": 1500, "perChangeMicros": 500, "slug": "listings" }
```
→ creates a new `schema_versions` row (`proposed_by: OWNER`) if fields changed; returns it. Price edits apply to the dataset directly.

### `POST /api/datasets/:id/approve` `{ "schemaVersionId", "rightsAttested": true }`
→ `{ "status": "LIVE", "endpoint": "https://…/v1/bluebonnet/datasets/listings/records" }`
Logic: conditional update; set `active_schema_id`; create filter indexes; run the extractor over all snapshots of the template (Workflows `extractTemplate`); bump `sites.policy_version` so the gate starts quoting this template's paths.
Errors: `VALIDATION_ERROR` (rights not attested; no visible fields).

### `POST /api/datasets/:id/unpublish` → `{ "status": "UNPUBLISHED" }`
### `POST /api/datasets/:id/reinfer` (P1) → `202` (drift; see 04)

### `GET /api/publishers/me/earnings?from&to&groupBy=buyer|dataset|day&includeSim=true`
```json
{ "kpis": { "grossMicros": 515940000, "commissionMicros": 103188000, "netMicros": 412752000, "payableMicros": 412752000,
            "recordsSold": 343960, "changesSold": 12040, "buyers": 23 },
  "rows": [ { "key": "Acme Agents", "isSimulated": false, "calls": 41, "records": 2210, "grossMicros": 3315000 } ] }
```
### `GET /api/publishers/me/ledger?cursor` (AG Grid server-side rows: txn kind, memo, amount, PayPal id, time)
### `GET /api/publishers/me/payouts` → batches with items, statuses, PayPal batch/item ids.
### `GET /api/publishers/me/events` (SSE: `hits`, `call.charged`, `payout.updated`, `proposal.ready`, `crawl.progress`)
### `GET /api/claims?status=OPEN` · `POST /api/claims/:id/decide` `{ "decision": "CREDIT" | "REJECT" }` (P1)

## Buyer portal endpoints (`/api/buyer`, session)

- `POST /api/buyer/signup` `{ "name", "email", "password" }` → `{ buyerId }`
- `POST /api/buyer/keys` `{ "name", "scopes": ["read","topup"] }` → `{ "key": "sk_spg_…" }` (shown once) · `DELETE /api/buyer/keys/:id`
- `POST /api/buyer/topups` (Idempotency-Key)
  ```json
  { "amountCents": 2000, "method": "PAYPAL_WALLET" | "CARD", "saveForAutoTopup": true }
  ```
  - `PAYPAL_WALLET` → `201 { "topupId", "status": "AWAITING_APPROVAL", "orderId": "…" }`. The page renders the JS SDK v6 PayPal button with this `orderId`; on approve, the browser calls `POST /api/buyer/topups/:id/capture`.
  - `CARD` (sandbox test card fields via JS SDK card fields, P1; P0 uses the server-side test card for SIM only) → `201 { "status": "COMPLETED", "balanceMicros": … }`
- `POST /api/buyer/topups/:id/capture` → `pp.captureOrder` → `creditTopup` → `{ "status": "COMPLETED", "balanceMicros": 20000000, "captureId": "…" }`
- `GET /topups/return?token=` (redirect fallback for agents' approval links) → capture → 302 to `/buyers/topup/:id?ok=1`
- `PUT /api/buyer/auto-topup` `{ "enabled": true, "amountCents": 2000, "thresholdMicros": 2000000, "monthlyCapCents": 10000 }` (requires a vaulted method)
- `GET /api/buyer/usage?from&to` · `GET /api/buyer/topups`
- `POST /api/buyer/refunds` (P1) `{ "amountCents": 740 }` → refunds against the newest COMPLETED top-ups first (`pp.refundCapture`), never more than `min(balance, sum(unrefunded captures))`.

## Buyer data API (`/v1`, API key)

All paid endpoints: `Idempotency-Key` header (recommended), optional `max_price_micros` query param (default `buyers.per_call_max_micros`).
Response headers on every paid 2xx: `Spigot-Charged-Micros`, `Spigot-Balance-Micros`, `Spigot-Records`, `Spigot-Call-Id`, `Spigot-Replay` (on replays).

### `GET /v1/catalog` (free, no key needed)
→ `{ "sites": [ { "slug": "bluebonnet", "name": "Bluebonnet Rentals", "datasets": [ { "slug": "listings", "type": "Listing", "records": 2341, "perRecordMicros": 1500, "perChangeMicros": 500, "freshness": { "lastCrawlAt": "…" } } ] } ] }`

### `GET /v1/:site/datasets/:dataset` (free) — schema
```json
{ "type": "Listing", "version": 2, "records": 2341,
  "fields": [ { "name": "price_usd", "type": "integer", "description": "Monthly rent in USD", "filterable": ["eq","lt","lte","gt","gte"] },
              { "name": "bedrooms", "type": "integer", "filterable": ["eq","gte","lte"] },
              { "name": "city", "type": "string", "filterable": ["eq"] },
              { "name": "updated_at", "type": "datetime", "filterable": ["gte"] } ],
  "pricing": { "perRecordMicros": 1500, "perChangeMicros": 500, "display": "$1.50 per 1,000 records" },
  "license": "https://…/c/bluebonnet/terms" }
```

### `GET /v1/:site/datasets/:dataset/quote?<filters>&limit=` (free)
→ `{ "records": 37, "unitPriceMicros": 1500, "priceMicros": 55500, "display": "$0.0555", "balanceMicros": 19998500, "wouldAutoTopUp": false }`
Runs the count query only (capped at `limit`).

### `GET /v1/:site/datasets/:dataset/records?<filters>&sort=-updated_at&limit=50&cursor=` (paid)
Filters: `field[op]=value`, e.g. `bedrooms[gte]=3&price_usd[lt]=2000&city=Austin&updated_at[gte]=2026-11-11T00:00:00Z`. Only fields the schema marks `filterable`, with the listed ops. Unknown → `400 UNSUPPORTED_FILTER`.
```json
{ "records": [ { "key": "listings/2br-east-cesar-chavez-4471", "data": { "title": "…", "price_usd": 1850, "bedrooms": 3, "city": "Austin", "url": "https://bluebonnet-rentals…/listings/…" },
                 "version": 4, "freshness": { "crawledAt": "…", "sourceLastmod": "…", "staleSince": null } } ],
  "next": "eyJ…", "charged": { "records": 37, "priceMicros": 55500 }, "balanceMicros": 19943000 }
```
Logic (see 06, 07):
1. Auth, rate limit, validate filters.
2. Idempotency lookup → replay if found.
3. Run the query (limit ≤ `max_records_per_call`).
4. `price = n × unit`. If `price > max_price_micros` → `402 PRICE_ABOVE_MAX` (no charge; quote in body).
5. If `price > balance` → try auto top-up (08, P1); else `402 INSUFFICIENT_BALANCE`.
6. Build response; post CHARGE; store `api_calls` row; commit; send.
Zero records → `200`, `price 0`, `NOT_CHARGED`.

### `GET /v1/:site/datasets/:dataset/records/:key` (paid, 1 record)

### `GET /v1/:site/datasets/:dataset/changes?since=<cursor>&limit=200&include=record` (paid per change)
```json
{ "changes": [ { "cursor": "c_8812", "key": "listings/…", "op": "update", "version": 5,
                 "patch": [ { "op": "replace", "path": "/price_usd", "value": 1795 } ], "changedAt": "…",
                 "record": { "…": "…" } } ],
  "next": "c_8840", "hasMore": false, "charged": { "changes": 28, "priceMicros": 14000 } }
```
- `since` omitted → starts at the watermark (returns nothing, free, gives a cursor to start from). `since=0` → full history (paid).
- Only `seq <= published_seq`. Hidden fields are removed from patches (patch ops on hidden paths are dropped).
- `include=record` charges per change, not extra.

### `GET /v1/balance` → `{ "balanceMicros", "autoTopup": { "enabled", "thresholdMicros", "amountCents", "remainingThisMonthCents" } }`
### `POST /v1/topups` (scope `topup`; used by MCP `top_up`) `{ "amountCents": 2000 }`
- If a vaulted method exists and the amount fits the monthly cap → merchant-initiated order → `{ "status": "COMPLETED", "balanceMicros" }`.
- Otherwise → `{ "status": "AWAITING_APPROVAL", "approveUrl": "https://www.sandbox.paypal.com/checkoutnow?token=…" }` for the human to open.
### `POST /v1/claims` (P1) `{ "callId", "recordKey", "reason": "STALE", "note": "Listing says leased on site" }` → `{ "claimId", "status": "AUTO_CREDITED" | "OPEN", "creditMicros" }`

## MCP server (`/mcp`, Streamable HTTP)

Auth: the buyer's API key as Bearer. Rate limit 30 calls/min/key. Each tool calls the same service functions as `/v1`, so the same quotes, caps, idempotency and audit apply (`actor_type=MCP_CLIENT`, `channel=MCP`).

| Tool | Input | Output | Paid? |
|---|---|---|---|
| `list_datasets` | `{ query? }` | Sites, datasets, record counts, prices | Free |
| `describe_dataset` | `{ site, dataset }` | Schema with filterable fields and ops, pricing, freshness | Free |
| `quote` | `{ site, dataset, filters, limit }` | `{ records, priceMicros, display, balanceMicros }` | Free |
| `search_records` | `{ site, dataset, filters, limit, maxPriceMicros?, idempotencyKey? }` | Typed records + `charged` | Per record |
| `get_changes` | `{ site, dataset, since?, limit, includeRecord? }` | Changes + `next` cursor + `charged` | Per change |
| `get_balance` | `{}` | Balance and auto top-up status | Free |
| `top_up` | `{ amountCents }` | `COMPLETED` (vault, within cap) or `approveUrl` | Moves PayPal money |
| `report_bad_record` (P1) | `{ callId, recordKey, reason, note }` | Claim status + credit | Free |

Tool descriptions say plainly: "Charges your Spigot balance $0.0015 per record returned. Call `quote` first if unsure. Nothing is charged if no records match." and for `top_up`: "Charges the saved PayPal payment method of the account owner, up to their monthly cap."

`filters` is a list: `[{ "field": "bedrooms", "op": "gte", "value": 3 }]`. Server validates against the schema; the agent can't inject SQL (parameterized, field names from the allowlist).

## Webhooks

### `POST /webhooks/paypal`
Verify with `pp.verifyWebhook` (S11), dedupe on event id, return 200 fast, process async.

| Event | Action |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | If the buyer closed the tab before our capture call: capture now (idempotent `capture:<topupId>`) |
| `PAYMENT.CAPTURE.COMPLETED` | `creditTopup(custom_id)` (no-op if already credited) |
| `PAYMENT.CAPTURE.DENIED` / `DECLINED` | Top-up FAILED; if AUTO, disable auto top-up and notify the buyer |
| `PAYMENT.CAPTURE.REFUNDED` | Confirm `balance_refunds` COMPLETED |
| `PAYMENT.PAYOUTSBATCH.SUCCESS` / `DENIED` | Batch status |
| `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` | Item SUCCESS → PAYOUT_SETTLED |
| `PAYMENT.PAYOUTS-ITEM.UNCLAIMED` | Item UNCLAIMED; alert the publisher |
| `PAYMENT.PAYOUTS-ITEM.FAILED` / `BLOCKED` / `DENIED` / `RETURNED` / `REFUNDED` | Item FAILED/RETURNED → PAYOUT_RETURNED (payable restored) |
| `CUSTOMER.DISPUTE.CREATED` | Audit + freeze the buyer's keys (P2) |

Pollers back this up (no webhook needed for the demo): open top-ups via `pp.getOrder` every 30 s for 30 min; payout batches via `pp.getPayoutBatch` every 60 s for 30 min.

### `POST /api/sites/:id/ping` (P1, crawl key) — CMS "something changed"
`{ "urls": ["https://…/listings/…"] }` → `202`. Queues a targeted crawl of those URLs (max 500 per ping, 1 ping per 10 s per site).

## Ops (admin only)
- `GET /admin/audit?publisherId&entity&paypalId&from&to`
- `POST /admin/payouts/run` `{ "trigger": "MANUAL_DEMO", "thresholdCentsOverride": 100 }` (also the dashboard's "Run payout now" for the demo publisher)
- `POST /admin/ledger/check` → `{ "sumMicros": 0, "accountsChecked": 41, "mismatches": [] }` (recomputes balances from entries)
- `GET /admin/health` → PayPal token ok, DB ok, Workflows ok, last gate hit per site, open top-ups, pending payout items
