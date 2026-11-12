# Data Model

Postgres. All IDs are UUIDs unless noted. Every table has `created_at timestamptz default now()` and `updated_at`.

**Schema source of truth:** `db/migrations/001_init.sql` (SP-002, frozen at merge). Later changes are new files named `NNN_sp0XX_<topic>.sql` (e.g. `002_sp049_refund_status.sql`); `npm run migrate` applies them in order, is idempotent, and refuses two files with the same `NNN`.
- `updated_at` is kept current by a touch trigger on every mutable table **except `records`** (see below). The append-only tables (`ledger_entries`, `audit_events`) have only `created_at`.
- Status columns are `text` + `CHECK (status IN (...))`; the allowed edges live in `apps/api/src/db/transition.ts` (`transition(tx, table, id, from, to, extra?)`, rule 1).

**Money units.**
- The ledger and all per-call prices are in **integer micros** (`bigint`, 1 USD = 1,000,000 micros). $1.50 per 1,000 records = 1,500 micros per record.
- Anything sent to or received from PayPal (top-ups, refunds, payouts) is in **integer cents** with a `currency` column (USD only).
- Conversion lives in one helper (`packages/shared/money.ts`): `centsToMicros(c) = c × 10,000`; `microsToCentsFloor(m) = floor(m / 10,000)`. Payout amounts round **down**; the remainder stays in the publisher's payable for the next batch.

## Tables

### publishers
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text not null | |
| email | text unique not null | Login |
| password_hash | text | Demo login (P0). Log in with PayPal is P1 |
| paypal_payer_id | text unique | From Log in with PayPal (P1) |
| payout_email | text not null | PayPal account that receives Payouts |
| commission_bps | int not null default 2000 | Our cut (20%) |
| payout_threshold_cents | int not null default 1000 | $10 minimum before a payout item is created |
| is_simulated | bool default false | |
| is_demo | bool not null default false | Only an `is_demo` publisher may take the dataset `DEMO_RESET` transition (SP-038) |

### sites
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| publisher_id | uuid FK | Index |
| origin | text unique not null | `https://bluebonnet-rentals.onrender.com` |
| slug | text unique | `bluebonnet` (used in API paths) |
| sitemap_url | text | Default `origin + /sitemap.xml` |
| verify_token | text not null | Must appear at `/.well-known/spigot.txt` |
| crawl_key_hash | text not null | SHA-256 of the `X-Spigot-Key` secret our crawler sends; the gate compares locally |
| gate_key_hash | text not null | SHA-256 of the key the gate uses to post hit counts and pull policy |
| status | text | See state machine |
| policy | jsonb not null | Per-category decision: `{ "SEARCH":"PASS","AI_TRAINING":"QUOTE","AI_AGENT":"QUOTE","SCRAPER_TOOL":"QUOTE","UNKNOWN":"PASS" }` plus `gated_paths` (regexes) |
| policy_version | int not null default 1 | Gate refreshes when this changes |
| last_gate_seen_at | timestamptz | Last hit-count post; "gate installed" check |
| rights_attested_at | timestamptz | Owner ticked "I own or may license the selected fields" |

### pages
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| site_id | uuid FK | unique(site_id, url) |
| url | text not null | Absolute, normalized (no fragment, sorted query) |
| template_id | uuid FK null | Set by clustering |
| sitemap_lastmod | timestamptz | From sitemap |
| etag | text | For conditional GET |
| last_status | int | HTTP status of last fetch |
| content_hash | text | SHA-256 of the last HTML body |
| fetched_at | timestamptz | |
| removed_at | timestamptz | Dropped from sitemap or 404/410 twice |

### snapshots
Owned by the crawler only. Keep the last 2 per page (demo scale; older rows deleted by the crawl task).
| id bigserial PK, page_id FK, fetched_at, http_status, html_gz bytea, content_hash, bytes int |

### templates
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| site_id | uuid FK | |
| url_pattern | text not null | Regex, e.g. `^/listings/[a-z0-9-]+$` |
| jsonld_types | text[] | `{"Apartment","Offer"}` if present |
| page_count | int | |
| sample_page_ids | uuid[] | 3–5 pages the AI saw |

### datasets (record types)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| site_id | uuid FK | |
| template_id | uuid FK | One dataset per template |
| slug | text | `listings`; unique(site_id, slug) |
| type_name | text not null | `Listing` |
| status | text | See state machine |
| active_schema_id | uuid FK null | The approved `schema_versions` row being served |
| price_per_record_micros | bigint not null default 1500 | $1.50 / 1,000 |
| price_per_change_micros | bigint not null default 500 | $0.50 / 1,000 |
| max_records_per_call | int not null default 100 | Hard cap 1,000 |
| record_count | int | Live (non-removed) records |
| published_seq | bigint not null default 0 | **Watermark** for the changes feed (see rule 7) |
| stale_since | timestamptz | Set when drift is detected and the extractor isn't re-approved yet |

### schema_versions
Every AI proposal and every owner edit is a new immutable row.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| dataset_id | uuid FK | |
| version | int | unique(dataset_id, version) |
| status | text | `PROPOSED`, `APPROVED`, `SUPERSEDED`, `REJECTED` |
| fields | jsonb not null | `[{ name, type, description, visible, pii, rights_flag, required }]` |
| extractor | jsonb not null | The extractor spec (see 04). Validated by Zod on write |
| record_key | jsonb not null | How to build the stable key: `{ "from":"url" }` or `{ "jsonld":"$['@id']" }` |
| sample_stats | jsonb | Per-field null rate and type-conformance on the 20-page check |
| ai_model | text | Model id used |
| ai_rationale | text | Short explanation shown to the owner |
| proposed_by | text | `AI`, `OWNER` |
| approved_by | uuid FK null | publisher id |
| approved_at | timestamptz | |

### records
Owned by the extractor only.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| dataset_id | uuid FK | |
| record_key | text not null | unique(dataset_id, record_key) |
| page_id | uuid FK | Source page |
| data | jsonb not null | Visible + hidden fields (hidden fields are stripped at serve time, never sold) |
| hash | text not null | SHA-256 of canonical JSON of `data` |
| version | int not null default 1 | |
| source_lastmod | timestamptz | |
| crawled_at | timestamptz | |
| removed_at | timestamptz | Soft delete; emits a `remove` change |
| updated_at | timestamptz not null | Time of the last **content** change, set explicitly by SP-013's upsert (insert, update, remove, revive). No touch trigger: a freshness-only `crawled_at` refresh must not move it |

Indexes: `(dataset_id, updated_at desc, id)`, `(dataset_id, removed_at)`, GIN on `data jsonb_path_ops`, plus expression indexes on the two or three filter fields the approved schema marks `filterable` (created at approve time; for the demo: `(data->>'price_usd')::int`, `(data->>'bedrooms')::int`, `data->>'city'`).

### record_versions (the changes feed)
| Column | Type | Notes |
|---|---|---|
| seq | bigserial PK | Global, monotonic. The cursor |
| dataset_id | uuid FK | Index (dataset_id, seq) |
| record_id | uuid FK | |
| version | int | |
| op | text | `add`, `update`, `remove` |
| patch | jsonb | RFC 6902 patch from the previous version (`add`: one `add` of the whole object; `remove`: `[{op:"remove",path:""}]`) |
| hash | text | Hash after this change |
| crawl_run_id | uuid FK | |
| changed_at | timestamptz | |

### crawl_runs
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| site_id | uuid FK | Partial unique index on (site_id) where status in ('QUEUED','RUNNING') and trigger not in ('APPROVE','CLAIM'): one live run per site |
| trigger | text | `CONNECT`, `MANUAL`, `SCHEDULE`, `PING`, `DEMO_MUTATE`, `APPROVE` (approve-time extraction, SP-014a; may overlap a crawl, SP-013's dataset locks keep the watermark safe), `CLAIM` (one targeted re-fetch for a STALE / REMOVED claim, SP-048c; may overlap a crawl, like APPROVE) |
| status | text | `QUEUED`, `RUNNING`, `SUCCEEDED`, `PARTIAL`, `FAILED`, `PAUSED` |
| workflow_run_id | text | Render Workflows run id, or `inproc:<id>` in fallback mode |
| pages_total, pages_fetched, pages_not_modified, pages_failed | int | Progress for W10 |
| records_added, records_updated, records_removed | int | |
| ai_calls | int not null default 0 | **Must stay 0** for runs after approval (test asserts it) |
| error | text | |
| started_at, finished_at | timestamptz | |
| idempotency_key | text null | Client `Idempotency-Key` of `POST /api/sites/:id/crawl`; unique per site (SP-009b, migration 002) |

### bot_hits (aggregated by the gate)
| Column | Type | Notes |
|---|---|---|
| site_id | uuid FK | |
| bucket | timestamptz | Minute bucket |
| category | text | `SEARCH`, `AI_TRAINING`, `AI_AGENT`, `SCRAPER_TOOL`, `UNKNOWN`, `HUMAN` |
| bot_name | text | `GPTBot`, `python-requests`, … or `-` |
| decision | text | `PASS`, `QUOTE_402`, `FAIL_OPEN`, `SPIGOT_CRAWLER` |
| hits | int | |
| bytes | bigint | Response bytes (PASS) or avoided bytes (402, estimated from the page's last snapshot size) |
| is_simulated | bool default false | SIM traffic from `sim-bots.ts` |
| PK (site_id, bucket, category, bot_name, decision, is_simulated) | | Upsert `hits = hits + EXCLUDED.hits` |

### buyers
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | "Acme Agents" |
| email | text unique | Buyer portal login (magic link or password, P0 password) |
| password_hash | text | P0 password login |
| auto_topup_enabled | bool default false | |
| auto_topup_amount_cents | int default 2000 | $20 |
| auto_topup_threshold_micros | bigint default 2000000 | Top up when balance < $2 |
| monthly_topup_cap_cents | int default 10000 | $100; sum of `VAULT_MIT` top-ups (AUTO + MCP) this calendar month (UTC) may not exceed (rule 11) |
| vault_id | text | PayPal vault token (card or PayPal wallet), from S7/S8 |
| vault_kind | text | `CARD`, `PAYPAL` |
| per_call_max_micros | bigint default 1000000 | Safety cap: a single call may not cost more than $1 unless the request raises `max_price` |
| is_simulated | bool default false | |
| mock_decline_next | bool not null default false | Demo: the next AUTO top-up is declined by the mock (`ALLOW_MOCK_DECLINE`, sandbox only; set by `npm run demo:decline`) |
| auto_topup_declined_at | timestamptz | Set when a vault top-up is declined (with `auto_topup_enabled=false`); W11's declined banner while auto top-up is off. Cleared by `PUT /api/buyer/auto-topup` or a newly saved method |

### api_keys
| id, buyer_id FK, name, prefix (first 8 chars, shown), key_hash (SHA-256), scopes text[] (`read`, `topup`), rate_limit_per_min int default 60, last_used_at, revoked_at |
Used by REST (`Authorization: Bearer sk_spg_…`) and MCP.

### topups
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | **Also the `PayPal-Request-Id`** for order create |
| buyer_id | uuid FK | |
| amount_cents | int not null | 500–50,000 ($5–$500), CHECK |
| currency | text not null default 'USD' | USD only |
| method | text | `PAYPAL_WALLET`, `CARD`, `VAULT_MIT` |
| trigger | text | `MANUAL`, `AUTO`, `MCP`, `SIM` |
| paypal_order_id | text unique | |
| paypal_capture_id | text unique | Needed for refunds |
| status | text | See state machine |
| refunded_cents | int not null default 0 | |
| ledger_txn_id | uuid FK null | Set when the credit posts |
| error_code | text | e.g. `INSTRUMENT_DECLINED` |
| idempotency_key | text | Client `Idempotency-Key`; unique(buyer_id, idempotency_key) |
| pending_reason | text | Capture `PENDING` reason; the row stays `AWAITING_APPROVAL`, no credit |
| paypal_fee_cents | int | PayPal's fee, tracked outside the ledger |
| needs_reconcile | bool not null default false | e.g. a capture amount that differs from the top-up |

### ledger_accounts
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| kind | text | `BUYER_BALANCE`, `PUBLISHER_PAYABLE`, `PLATFORM_REVENUE`, `PAYPAL_CASH`, `PAYOUTS_IN_FLIGHT` |
| owner_id | uuid null | buyer id / publisher id; null for platform accounts |
| balance_micros | bigint not null default 0 | Cached sum of entries, updated in the same transaction |
| unique(kind, owner_id) | | |
| check | | `kind <> 'BUYER_BALANCE' OR balance_micros >= 0`. `PUBLISHER_PAYABLE` **may** go negative: a claim credited after a payout claws back from the next payout |

### ledger_txns
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| kind | text | `TOPUP`, `CHARGE`, `CREDIT`, `REFUND`, `REFUND_REVERSAL` (a failed refund puts the money back, SP-049), `PAYOUT_SENT`, `PAYOUT_SETTLED`, `PAYOUT_RETURNED`, `DEMO_RESET` (SP-038 zeroes demo balances without deleting entries) |
| idempotency_key | text unique not null | e.g. `topup:<topupId>`, `charge:<apiCallId>`, `payout_item:<itemId>` |
| ref_type, ref_id | text, uuid | `topup`, `api_call`, `claim`, `payout_item`, `balance_refund` |
| memo | text | |
| is_simulated | bool default false | |
| created_at | timestamptz | The caller may backdate it **only** when `is_simulated` (SP-036's simulated week): an insert trigger enforces `is_simulated OR created_at >= now() - interval '5 minutes'`. Entries follow their txn's `is_simulated` |

### ledger_entries (append-only)
| id bigserial PK, txn_id FK, account_id FK, amount_micros bigint (signed, ≠ 0), created_at |
- A deferred constraint trigger checks `sum(amount_micros) = 0` per `txn_id` at commit.
- No UPDATE or DELETE grants for the app role (`REVOKE` from PUBLIC and `spigot_app`), plus a trigger that raises on UPDATE / DELETE / TRUNCATE so it holds even when the app connects as the owner.

Sign convention: liabilities (buyer balances, payables, revenue, payouts in flight) are positive; `PAYPAL_CASH` (our asset at PayPal) is negative. Every txn sums to 0, so the sum of all `balance_micros` is always 0.

Postings:
| Txn | Entries |
|---|---|
| TOPUP $20 | `PAYPAL_CASH −20,000,000` · `BUYER_BALANCE(b) +20,000,000` |
| CHARGE 1,000 records at 1,500 | `BUYER_BALANCE(b) −1,500,000` · `PUBLISHER_PAYABLE(p) +1,200,000` · `PLATFORM_REVENUE +300,000` |
| CREDIT (claim) | Reverse of the CHARGE lines for the credited amount |
| REFUND $7.40 to PayPal | `BUYER_BALANCE(b) −7,400,000` · `PAYPAL_CASH +7,400,000` |
| PAYOUT_SENT $12.00 | `PUBLISHER_PAYABLE −12,000,000` · `PAYOUTS_IN_FLIGHT +12,000,000` |
| PAYOUT_SETTLED | `PAYOUTS_IN_FLIGHT −12,000,000` · `PAYPAL_CASH +12,000,000` |
| PAYOUT_RETURNED (unclaimed/failed) | `PAYOUTS_IN_FLIGHT −12,000,000` · `PUBLISHER_PAYABLE +12,000,000` |

Commission split: `commission = floor(price × commission_bps / 10,000)`, publisher gets `price − commission` (the publisher keeps the rounding remainder).
PayPal's own fees are tracked outside the ledger on `topups` and `payout_items` (README note), so the demo ledger stays readable.

### api_calls
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| buyer_id | uuid FK | |
| api_key_id | uuid FK | |
| channel | text | `REST`, `MCP` |
| dataset_id | uuid FK | |
| endpoint | text | `records.search`, `records.get`, `changes.list` |
| idempotency_key | text not null | Client-supplied, or `auto:<sha256(key_id + request_hash + minute bucket)>` when absent (see rule 4) |
| request_hash | text | Canonical query hash; a replay with the same key but a different request → 409 |
| status | text | See state machine |
| records_returned | int | |
| changes_returned | int | |
| unit_price_micros | bigint | Snapshot of the dataset price at call time |
| price_micros | bigint | What was charged (0 if NOT_CHARGED) |
| credited_micros | bigint default 0 | Claims credited against this call |
| http_status | int | |
| response_body | jsonb | Stored for 24 h for idempotent replay (purged by cron) |
| charge_txn_id | uuid FK null | |
| commission_bps | int | Snapshot of the publisher's commission at call time (SP-016, SP-048a) |
| served_record_keys | jsonb | Keys + hashes served; kept ≥ 7 days for claims after `response_body` is purged |
| hidden_at | timestamptz | SP-038 hides demo calls instead of deleting them |
| is_simulated | bool default false | |
| unique(api_key_id, idempotency_key) | | |

### claims (P1)
| id, api_call_id FK, record_id FK, buyer_id FK, reason (`STALE`, `WRONG_VALUE`, `MISSING_FIELD`, `DUPLICATE`, `REMOVED`), note text, status (`OPEN`, `AUTO_CREDITED`, `CREDITED`, `REJECTED`), credit_micros, decided_by (`AUTO`, `PUBLISHER`, `ADMIN`), ai_recommendation jsonb, ledger_txn_id |
unique(api_call_id, record_id): one claim per record per call.

### record_refetches (P1, SP-048c)
| record_id PK FK, crawl_run_id FK (the CLAIM run; null when nothing was fetched), outcome (`FETCHED`, `GONE`, `FAILED`), http_status, fetched_at |
The record's latest STALE / REMOVED re-fetch: at most one per record per 10 minutes; a claim inside the window reuses it. Re-fetches of one record are serialized on the advisory lock `claim-refetch:<record id>`.

### balance_refunds (P1)
| id (PayPal-Request-Id), buyer_id, topup_id FK, amount_cents, currency, paypal_refund_id unique, status (`REQUESTED`, `PENDING`, `COMPLETED`, `FAILED`), ledger_txn_id, error_code, idempotency_key |
unique(buyer_id, idempotency_key). `REQUESTED → PENDING | COMPLETED | FAILED`, `PENDING → COMPLETED | FAILED`.

### payout_batches
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | **Also `sender_batch_id`** |
| period_start, period_end | timestamptz | unique(period_end) for SCHEDULE runs |
| trigger | text | `SCHEDULE`, `MANUAL_DEMO` |
| status | text | `BUILDING`, `SUBMITTED`, `PENDING`, `PROCESSING`, `SUCCESS`, `PARTIAL`, `DENIED`, `FAILED` |
| paypal_batch_id | text unique | `payout_batch_id` from PayPal |
| total_cents | int | |
| item_count | int | |
| needs_reconcile | bool not null default false | A duplicate-batch response with no `payout_batch_id` (SP-020) |

### payout_items
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | **Also `sender_item_id`** |
| batch_id | uuid FK | |
| publisher_id | uuid FK | |
| receiver_email | text | Snapshot of `payout_email` at batch time |
| gross_micros | bigint | Charges accrued in the period (for the statement) |
| commission_micros | bigint | |
| net_cents | int | `microsToCentsFloor(payable)` |
| fee_cents | int | PayPal's payout fee, tracked outside the ledger |
| paypal_item_id | text | |
| status | text | See state machine |
| error_code | text | e.g. `RECEIVER_UNREGISTERED` |
| ledger_txn_id | uuid | PAYOUT_SENT |

### webhook_events
| id text PK (PayPal event id), event_type, received_at, payload jsonb, verified bool, processed_at |

### audit_events (append-only)
| Column | Type | Notes |
|---|---|---|
| id | bigserial PK | |
| at | timestamptz | |
| actor_type | text | `PUBLISHER`, `BUYER`, `MCP_CLIENT`, `SCHEMA_AGENT`, `WORKFLOW`, `GATE`, `PAYPAL_WEBHOOK`, `SYSTEM`, `SIM` |
| actor_id | text | |
| publisher_id | uuid | Tenant filter |
| entity | text | `site`, `dataset`, `schema_version`, `topup`, `api_call`, `payout_item`, `claim` |
| entity_id | uuid | |
| action | text | e.g. `SCHEMA_PROPOSED`, `SCHEMA_APPROVED`, `TOPUP_COMPLETED`, `CALL_CHARGED`, `PAYOUT_SENT` |
| paypal_id | text | Order / capture / refund / payout item id |
| data | jsonb | |

No UPDATE or DELETE grants for the app role; the same append-only trigger as `ledger_entries`.

### job_ticks
| name text PK, last_tick bigint, last_run_at |
`runEvery` (SP-002, `apps/api/src/db/jobs.ts`) claims each tick here under `pg_try_advisory_lock('job:<name>')`, so a job runs once per tick across API processes even when their timers aren't aligned.

## State machines

### Site
```
PENDING_VERIFY ──token found at /.well-known/spigot.txt──> VERIFIED ──first crawl done──> PROPOSING ──≥1 proposal──> READY
                                                                                                         │
                                                         PAUSED <──owner pauses / origin 429s 3× in a row┘ (resume → READY)
```
| From | To | Trigger | Who |
|---|---|---|---|
| PENDING_VERIFY | VERIFIED | Verify check passes (demo: seeded token) | Publisher |
| VERIFIED | PROPOSING | Discovery crawl SUCCEEDED | Workflow |
| PROPOSING | READY | Schema agent wrote ≥ 1 PROPOSED schema | Schema agent |
| READY | PAUSED | Owner pause, or 3 consecutive rate-limited runs | Publisher / Workflow |

### Dataset
```
PROPOSED ──owner approves (price, visible fields, rights attested)──> LIVE ──drift detected──> LIVE_STALE ──owner approves v(n+1)──> LIVE
    │                                                                   │
    └─owner rejects──> REJECTED                                        └─owner unpublishes──> UNPUBLISHED (API returns 410)
```
**`DEMO_RESET`:** `LIVE | LIVE_STALE | UNPUBLISHED → PROPOSED`, allowed **only** through SP-038's demo-reset path and only for an `is_demo` publisher (the code path checks and refuses otherwise). Records are kept.
Only `LIVE` and `LIVE_STALE` datasets are sold. `LIVE_STALE` serves the last good records with `freshness.stale_since` set.

### Crawl run
`QUEUED → RUNNING → SUCCEEDED | PARTIAL (some pages failed) | FAILED`; `RUNNING → PAUSED` on origin 429 with `Retry-After` > 10 min.

### Top-up
```
CREATED ──(wallet) order PAYER_ACTION_REQUIRED──> AWAITING_APPROVAL ──buyer approves, we capture──> COMPLETED ──partial refund──> PARTIALLY_REFUNDED
   │                                                    └─abandoned 30 min / cancelled──> ABANDONED
   └─(card / vault MIT) captured in create──> COMPLETED
   └─declined──> FAILED
```
| From | To | Trigger | Who |
|---|---|---|---|
| CREATED | AWAITING_APPROVAL | Order created with PayPal wallet source | API |
| CREATED / AWAITING_APPROVAL | COMPLETED | Capture status `COMPLETED` → ledger TOPUP posted in the same DB transaction | API return handler / webhook |
| CREATED | FAILED | `INSTRUMENT_DECLINED` etc. | API |
| AWAITING_APPROVAL | FAILED | Capture declined | API |
| AWAITING_APPROVAL | ABANDONED | 30 min cron | Cron |
| ABANDONED | COMPLETED | Late capture or webhook after the sweep (still credits once) | API / webhook / poller |
| COMPLETED | PARTIALLY_REFUNDED | Refund COMPLETED | API (10) |
| COMPLETED / PARTIALLY_REFUNDED | REFUNDED | Whole amount refunded | API (10) |

Capture `PENDING` (rare, e.g. eCheck): stays `AWAITING_APPROVAL` with `pending_reason`; balance is credited only on `PAYMENT.CAPTURE.COMPLETED`.

### API call (money)
```
RECEIVED ──validation/auth fail──> REJECTED (no charge)
    │
    ├─price > balance (and no auto top-up possible)──> PAYMENT_REQUIRED (402, no charge) ──retry, same key──> RECEIVED
    ├─result built, 2xx──> CHARGED ──claim approved──> PARTIALLY_CREDITED / CREDITED
    └─result built but 0 records, or 5xx──> NOT_CHARGED
```
`PAYMENT_REQUIRED` and `REJECTED` are not terminal: a retry with the same key and request moves the row back to `RECEIVED` (rule 4).
The review's `QUOTED → CHARGED → REFUNDED` maps to: quote (no row, stateless) → `CHARGED` → `CREDITED` (balance credit) and, separately, a PayPal refund of unused balance.

### Payout item
```
ACCRUING (implicit: payable balance) ──batch built──> PENDING ──PayPal SUCCESS──> SUCCESS
                                                         ├─UNCLAIMED (no PayPal account)──> UNCLAIMED ──30 days──> RETURNED ──> back to payable
                                                         └─FAILED / BLOCKED / DENIED──> FAILED ──> back to payable, retried next batch
```
| From | To | Trigger | Ledger |
|---|---|---|---|
| (payable ≥ threshold) | PENDING | `payoutRun` builds the batch and Payouts returns 201 | PAYOUT_SENT |
| PENDING | SUCCESS | Webhook `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` or poll | PAYOUT_SETTLED |
| PENDING | UNCLAIMED | Item status `UNCLAIMED` | none yet (still in flight) |
| UNCLAIMED | SUCCESS | Receiver claimed within 30 days | PAYOUT_SETTLED |
| UNCLAIMED | RETURNED | Item `RETURNED` (30 days) | PAYOUT_RETURNED |
| PENDING | FAILED | Item `FAILED`, `BLOCKED`, `DENIED`, `REFUNDED` | PAYOUT_RETURNED |

### Claim (P1)
`OPEN → AUTO_CREDITED` (deterministic check passes) · `OPEN → CREDITED | REJECTED` (publisher decides, with the AI recommendation shown).

## Locking and idempotency rules

1. **Conditional status updates.** Every transition is `UPDATE … SET status=$new WHERE id=$id AND status=$expected RETURNING *`. Zero rows means someone else won the race, so stop.
2. **One ledger function.** All money moves go through `ledger.post({ kind, idempotencyKey, entries })`, which in one transaction:
   - inserts `ledger_txns` (unique `idempotency_key`; on conflict returns the existing txn and does nothing else);
   - locks the touched `ledger_accounts` rows `FOR UPDATE` **in id order** (no deadlocks);
   - inserts entries and updates `balance_micros`; the check constraint rejects a negative buyer balance;
   - the deferred trigger rejects an unbalanced txn.
3. **Charge only on 2xx.** The API builds the full response first (records, filtered, hidden fields stripped), computes `price = n × unit_price`, then in one transaction: posts the CHARGE, writes `api_calls` CHARGED with `response_body`, commits, then sends. If the CHARGE fails on the balance check, nothing is sent except a 402. If the client disconnects after commit, a replay returns the stored body (rule 4).
4. **Client idempotency.** Paid calls take an `Idempotency-Key` header (MCP tools take `idempotencyKey`; the MCP server generates one per tool call if the agent omits it). `unique(api_key_id, idempotency_key)`.
   - Same key, same `request_hash` → return the stored response with header `Spigot-Replay: true`, no new charge.
   - Same key, different request → `409 IDEMPOTENCY_MISMATCH`.
   - No key on REST → server derives `auto:` key from `(api_key_id, request_hash, minute bucket)` so an accidental double-send within the same minute isn't charged twice.
     The minute bucket is deliberate: without it a buyer polling the same query would get the first response replayed forever. A replay is only guaranteed within the bucket, so clients that need exact retry safety send their own `Idempotency-Key` (SP-023 documents this).
   - Same key, same request, original call `PAYMENT_REQUIRED` (or `REJECTED`) → not terminal: the retry claims the row back to `RECEIVED` with a conditional update and re-runs the charge, so 402 → top-up → retry with the same key → 200, charged once. Two racing retries: one charges, the other replays it.
   - Same key, same request, but `response_body` already purged (24 h) → `409 IDEMPOTENCY_KEY_EXPIRED`; never a second charge.
5. **PayPal idempotency.** Each PayPal call sends `PayPal-Request-Id` (proven in S3):
   - order create = `topup.id`; order capture = `capture:<topup.id>`;
   - refund = `balance_refund.id`;
   - payouts `sender_batch_id` = `payout_batch.id`, `sender_item_id` = `payout_item.id`.
6. **Top-up crediting happens once.** The return handler, the webhook and the poller can all see a completed capture. Each calls `creditTopup(topupId)`, which does a conditional update `→ COMPLETED` and posts `ledger.post({ idempotencyKey: 'topup:'+id })`. Whoever loses the race does nothing.
7. **Changes-feed watermark.** `record_versions.seq` is a bigserial, so concurrent transactions can commit out of order. Readers only see `seq <= datasets.published_seq`. Each `extractPage` batch commits its versions, then `publishWatermark(datasetId)` takes `pg_advisory_xact_lock(dataset)` and sets `published_seq = (select max(seq) …)` only after all of the run's page batches have committed (the run's last step). Result: a cursor never skips a change.
8. **Record upsert.** `INSERT … ON CONFLICT (dataset_id, record_key) DO UPDATE … WHERE records.hash <> EXCLUDED.hash RETURNING` — only a real change bumps `version` and writes a `record_versions` row.
9. **One crawl per site.** Partial unique index on `crawl_runs(site_id) where status in ('QUEUED','RUNNING')`. A second "Crawl now" returns the live run.
10. **One payout run at a time.** `payoutRun` takes `pg_advisory_lock('payout')`. A publisher with a PENDING item is skipped in the next batch until it resolves.
11. **Vault top-ups at most once in flight, within the cap.** Every `VAULT_MIT` top-up (AUTO from a short call, MCP `top_up` from the vault) goes through `reserveVaultTopup()`: a short tx takes `SELECT … FROM buyers WHERE id=$1 FOR NO KEY UPDATE` (never `FOR UPDATE`, which conflicts with the `FOR KEY SHARE` every foreign-key check on `buyer_id` takes and deadlocks a charge against a credit) and re-reads the balance (if another call's top-up already covers the price, skip); skip if a `topups` row with `method='VAULT_MIT'` (any trigger) is `CREATED` for this buyer; check this calendar month's (UTC) `VAULT_MIT` sum (AUTO + MCP; every status but `FAILED` / `ABANDONED`, so in-flight and later-refunded top-ups count) + amount ≤ `monthly_topup_cap_cents`; insert the row and COMMIT. The PayPal call runs after the commit, never under the buyer lock.
12. **Webhook dedupe.** Insert into `webhook_events` with PayPal's event id as PK; on conflict, skip.
13. **Hidden fields never leave.** The serializer builds output only from the active schema's `visible=true` fields (allowlist, not denylist).
