# Spigot architecture

The system diagram and its rules, copied from the build spec ([`docs/spec/README.md`](spec/README.md) §System overview). The spec is the source of truth; if the two disagree, the spec wins and this file should be fixed.

## System overview

```
                     Publisher origin (Bluebonnet Rentals, Express)
                     ┌───────────────────────────────────────────────┐
  human / Googlebot ─┤ spigot-gate: classify(req) ── pass ──> site    │── sitemap.xml, POST /ping (P1)
  GPTBot / scraper  ─┤             (local, <1 ms, fail-open) ── 402 ──┼─> { price, api_url, terms }
                     └───────────────┬───────────────────────────────┘
                     batched hit counts (async, droppable)
                                     ▼
 ┌──────────────────────────────── Render web service: spigot-api (Node/TS, Fastify) ─────────────────────────────┐
 │  /gate/hits   /publisher/*   /v1/* (buyer REST)   /mcp (Streamable HTTP)   /webhooks/paypal   /topups/return   │
 │        │            │                │                   │                       │                             │
 │        ▼            ▼                ▼                   ▼                       ▼                             │
 │   bot_hits    sites, datasets    Query → Quote → Serve → Charge (ledger)   reconcile topups/payouts            │
 │                    │                                     │                                                      │
 │      Schema agent (Claude API): propose schema + extractor from 3–5 samples, self-check, owner approves        │
 └────────────────────┼─────────────────────────────────────┼──────────────────────────────────────────────────────┘
                      │ start run                            │
           Render Workflows                                 Postgres (paid): records, record_versions,
           crawlSite → fetchPage ×N → extractPage → publish  ledger_accounts, ledger_entries, payouts, audit
           payoutRun (weekly or "Run now") ──────────────────────┐
                                                                 ▼
                      PayPal REST: Orders v2 (top-up, CAPTURE) · Vault (auto top-up, MIT) · Refunds (P1)
                                   Payouts (batched) · Webhooks (verify + reconcile)
 Buyer: Claude Desktop ──MCP──> /mcp      Python scraper ──HTML──> gate 402 ──> catalog page ──> sign up + top up
```


## Rules

- **Humans never call us.** The gate decides locally (< 1 ms, no network call) and fails open.
- **The crawler owns snapshots, the extractor owns records, the ledger owns money.** One writer per piece of state.
- **AI writes the extractor once; code runs it.** No LLM call per page or per API request.
- **Only the backend calls PayPal.** No LLM ever holds PayPal credentials or calls a money endpoint directly.

## The paid loop, step by step

1. **Gate.** `spigot-gate` runs inside the publisher's origin (the demo site). It classifies each request by User-Agent: humans and search crawlers pass; declared AI bots and scraping libraries (`GPTBot`, `ClaudeBot`, `python-requests`, `Scrapy`, …) get HTTP 402 with a JSON body that names the price, the API endpoint, the MCP URL and the catalog page. Hit counts are batched to `/api/gate/hits` asynchronously and may be dropped; the site never waits on Spigot.
2. **Crawl.** Spigot's crawler reads the publisher's sitemap and fetches public pages with a secret `X-Spigot-Key` header (ETag-aware, at most 2 requests in flight per host). Snapshots are stored by the crawler only. In Workflows mode the fan-out runs as Render Workflows tasks (`crawlSite → fetchPage ×N → extractPage → publishWatermark`); otherwise the same task bodies run in-process.
3. **Schema agent.** Pages are clustered into templates. For each template, Claude reads JSON-LD and a cleaned DOM outline of 3–5 sample pages and proposes a record type, its fields and an **extractor**: a Zod-validated JSON spec of JSON-LD paths, CSS selectors and whitelisted transforms (never code). It runs the extractor on 20 samples and repairs it (≤ 2 rounds). PII fields are flagged.
4. **Owner approves.** The owner edits fields (e.g. hides `agent_phone`), sets a price per 1,000 records and publishes. From then on, plain code runs the extractor on every page: **zero AI calls per page**.
5. **Records and changes.** Each record has a stable `record_key`, a canonical-JSON SHA-256 hash and a version. Re-crawls emit RFC 6902 JSON Patch changes with a cursor.
6. **Buyer funds a balance.** A buyer tops up a prepaid balance with PayPal (Orders v2 `CAPTURE`, JS SDK v6 button). Money is held in a double-entry ledger in micros (1 USD = 1,000,000), so a $0.0015 record is exact.
7. **Paid call.** REST `/v1/*` or MCP `/mcp`: query → quote → serve → charge. The ledger debit happens **only after a 2xx response is built**, keyed by `Idempotency-Key`; the same key is never charged twice. 20% commission (`commission_bps=2000`) goes to Spigot; the rest accrues to the publisher's payable.
8. **Payout.** `payoutRun` (button, CLI or weekly) sends one PayPal Payouts batch with one item per publisher whose payable is over the threshold, then reconciles item statuses by poll and webhook.

## Code map

| Piece | Path | Ticket(s) |
|---|---|---|
| Demo site (Bluebonnet Rentals) | `apps/demo-site/` | SP-004a, SP-004b |
| Gate | `packages/gate/` | SP-006a, SP-006b |
| Shared contracts (money, error codes, events, copy) | `packages/shared/` | SP-001d |
| API (Fastify): routes, ledger, metering, PayPal client, MCP | `apps/api/src/` | SP-001a onward |
| Crawler | `apps/api/src/crawl/` | SP-009a1, SP-009a2, SP-009b |
| Template clustering, schema agent | `apps/api/src/schema-agent/`, `packages/shared/src/cluster.ts` | SP-010, SP-012a, SP-012b |
| Render Workflows entry | `apps/workflows/` | SP-041a, SP-041b |
| Web app (dashboard, buyer portal, catalog) | `apps/web/` | SP-024a onward |
| Migrations | `db/` | SP-002 |

Paths for tickets that haven't merged yet follow the spec layout and may move; [`docs/tickets/INDEX.md`](tickets/INDEX.md) has the current status.
