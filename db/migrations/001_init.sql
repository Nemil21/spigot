-- SP-002: the whole Spigot schema in one first migration (docs/spec/data-model.md).
--
-- Frozen at merge. Later changes are new files named NNN_sp0XX_<topic>.sql
-- (e.g. 002_sp049_refund_status.sql); the runner refuses two files with the same NNN.
--
-- Conventions
--   * ids are uuid (gen_random_uuid) unless the spec says bigserial / text.
--   * statuses are text + CHECK (status IN (...)) from each state machine; the allowed
--     edges live in apps/api/src/db/transition.ts.
--   * money: ledger + per-call prices in integer micros (bigint); PayPal amounts in
--     integer cents (int) with a currency column (USD only).
--   * every mutable table has created_at / updated_at; a touch trigger keeps updated_at
--     current on UPDATE, EXCEPT records (SP-013 sets records.updated_at explicitly, only
--     on a content change). Append-only tables (ledger_entries, audit_events) have no
--     updated_at.

-- ---------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Append-only guard. Holds even when the app connects as the table owner, where a
-- REVOKE alone would not.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END $$;

-- ---------------------------------------------------------------------------
-- Publishers, sites, crawl data
-- ---------------------------------------------------------------------------

CREATE TABLE publishers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  email                  text NOT NULL UNIQUE,
  password_hash          text,
  paypal_payer_id        text UNIQUE,
  payout_email           text NOT NULL,
  commission_bps         int  NOT NULL DEFAULT 2000 CHECK (commission_bps BETWEEN 0 AND 10000),
  payout_threshold_cents int  NOT NULL DEFAULT 1000 CHECK (payout_threshold_cents >= 0),
  is_simulated           bool NOT NULL DEFAULT false,
  -- SP-038: only an is_demo publisher may take the DEMO_RESET dataset transition.
  is_demo                bool NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_id       uuid NOT NULL REFERENCES publishers (id),
  origin             text NOT NULL UNIQUE,
  slug               text UNIQUE,
  sitemap_url        text,
  verify_token       text NOT NULL,
  crawl_key_hash     text NOT NULL,
  gate_key_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING_VERIFY'
                     CHECK (status IN ('PENDING_VERIFY', 'VERIFIED', 'PROPOSING', 'READY', 'PAUSED')),
  policy             jsonb NOT NULL DEFAULT '{"SEARCH":"PASS","AI_TRAINING":"QUOTE","AI_AGENT":"QUOTE","SCRAPER_TOOL":"QUOTE","UNKNOWN":"PASS","gated_paths":[]}',
  policy_version     int  NOT NULL DEFAULT 1,
  last_gate_seen_at  timestamptz,
  rights_attested_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sites_publisher_id_idx ON sites (publisher_id);

CREATE TABLE templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES sites (id),
  url_pattern     text NOT NULL,
  jsonld_types    text[],
  page_count      int,
  sample_page_ids uuid[],
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_site_id_idx ON templates (site_id);

CREATE TABLE pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES sites (id),
  url             text NOT NULL,
  template_id     uuid REFERENCES templates (id),
  sitemap_lastmod timestamptz,
  etag            text,
  last_status     int,
  content_hash    text,
  fetched_at      timestamptz,
  removed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, url)
);
CREATE INDEX pages_template_id_idx ON pages (template_id);

-- Owned by the crawler; it keeps the last 2 per page and deletes older rows.
CREATE TABLE snapshots (
  id           bigserial PRIMARY KEY,
  page_id      uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  http_status  int,
  html_gz      bytea,
  content_hash text,
  bytes        int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_page_fetched_idx ON snapshots (page_id, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- Datasets, schemas, records, changes feed
-- ---------------------------------------------------------------------------

CREATE TABLE datasets (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id                 uuid NOT NULL REFERENCES sites (id),
  template_id             uuid UNIQUE REFERENCES templates (id), -- one dataset per template
  slug                    text NOT NULL,
  type_name               text NOT NULL,
  -- LIVE | LIVE_STALE | UNPUBLISHED -> PROPOSED is the DEMO_RESET transition: allowed only
  -- for an is_demo publisher, enforced in SP-038's code path.
  status                  text NOT NULL DEFAULT 'PROPOSED'
                          CHECK (status IN ('PROPOSED', 'LIVE', 'LIVE_STALE', 'REJECTED', 'UNPUBLISHED')),
  active_schema_id        uuid, -- FK added below (schema_versions references datasets)
  price_per_record_micros bigint NOT NULL DEFAULT 1500 CHECK (price_per_record_micros BETWEEN 100 AND 100000),
  price_per_change_micros bigint NOT NULL DEFAULT 500 CHECK (price_per_change_micros >= 0),
  max_records_per_call    int NOT NULL DEFAULT 100 CHECK (max_records_per_call BETWEEN 1 AND 1000),
  record_count            int NOT NULL DEFAULT 0,
  published_seq           bigint NOT NULL DEFAULT 0, -- changes-feed watermark (rule 7)
  stale_since             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, slug)
);

CREATE TABLE schema_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id   uuid NOT NULL REFERENCES datasets (id),
  version      int  NOT NULL,
  status       text NOT NULL DEFAULT 'PROPOSED'
               CHECK (status IN ('PROPOSED', 'APPROVED', 'SUPERSEDED', 'REJECTED')),
  fields       jsonb NOT NULL,
  extractor    jsonb NOT NULL,
  record_key   jsonb NOT NULL,
  sample_stats jsonb,
  ai_model     text,
  ai_rationale text,
  proposed_by  text CHECK (proposed_by IN ('AI', 'OWNER')),
  approved_by  uuid REFERENCES publishers (id),
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, version)
);

ALTER TABLE datasets
  ADD CONSTRAINT datasets_active_schema_id_fkey FOREIGN KEY (active_schema_id) REFERENCES schema_versions (id);

-- Owned by the extractor. updated_at = time of the last CONTENT change, set explicitly by
-- SP-013's upsert (insert / update / remove / revive). No touch trigger: a freshness-only
-- crawled_at refresh must not move it.
CREATE TABLE records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id     uuid NOT NULL REFERENCES datasets (id),
  record_key     text NOT NULL,
  page_id        uuid REFERENCES pages (id),
  data           jsonb NOT NULL,
  hash           text NOT NULL,
  version        int  NOT NULL DEFAULT 1,
  source_lastmod timestamptz,
  crawled_at     timestamptz,
  removed_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, record_key)
);
CREATE INDEX records_dataset_updated_idx ON records (dataset_id, updated_at DESC, id);
CREATE INDEX records_dataset_removed_idx ON records (dataset_id, removed_at);
CREATE INDEX records_data_gin_idx ON records USING gin (data jsonb_path_ops);

CREATE TABLE crawl_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id            uuid NOT NULL REFERENCES sites (id),
  trigger            text NOT NULL
                     CHECK (trigger IN ('CONNECT', 'MANUAL', 'SCHEDULE', 'PING', 'DEMO_MUTATE', 'APPROVE')),
  status             text NOT NULL DEFAULT 'QUEUED'
                     CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED')),
  workflow_run_id    text,
  pages_total        int NOT NULL DEFAULT 0,
  pages_fetched      int NOT NULL DEFAULT 0,
  pages_not_modified int NOT NULL DEFAULT 0,
  pages_failed       int NOT NULL DEFAULT 0,
  records_added      int NOT NULL DEFAULT 0,
  records_updated    int NOT NULL DEFAULT 0,
  records_removed    int NOT NULL DEFAULT 0,
  ai_calls           int NOT NULL DEFAULT 0, -- must stay 0 for runs after approval
  error              text,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Rule 9: one live crawl per site. APPROVE runs (approve-time extraction) may overlap a
-- crawl; SP-013's dataset locks keep the watermark safe.
CREATE UNIQUE INDEX crawl_runs_one_live_per_site
  ON crawl_runs (site_id) WHERE status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE';
CREATE INDEX crawl_runs_site_created_idx ON crawl_runs (site_id, created_at DESC);

CREATE TABLE record_versions (
  seq          bigserial PRIMARY KEY, -- global, monotonic: the changes-feed cursor
  dataset_id   uuid NOT NULL REFERENCES datasets (id),
  record_id    uuid NOT NULL REFERENCES records (id),
  version      int  NOT NULL,
  op           text NOT NULL CHECK (op IN ('add', 'update', 'remove')),
  patch        jsonb,
  hash         text,
  crawl_run_id uuid REFERENCES crawl_runs (id),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_versions_dataset_seq_idx ON record_versions (dataset_id, seq);
CREATE INDEX record_versions_record_idx ON record_versions (record_id);

-- Aggregated by the gate: upsert hits = hits + EXCLUDED.hits.
CREATE TABLE bot_hits (
  site_id      uuid NOT NULL REFERENCES sites (id),
  bucket       timestamptz NOT NULL, -- minute bucket
  category     text NOT NULL
               CHECK (category IN ('SEARCH', 'AI_TRAINING', 'AI_AGENT', 'SCRAPER_TOOL', 'UNKNOWN', 'HUMAN')),
  bot_name     text NOT NULL DEFAULT '-',
  decision     text NOT NULL CHECK (decision IN ('PASS', 'QUOTE_402', 'FAIL_OPEN', 'SPIGOT_CRAWLER')),
  hits         int    NOT NULL DEFAULT 0,
  bytes        bigint NOT NULL DEFAULT 0,
  is_simulated bool   NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, bucket, category, bot_name, decision, is_simulated)
);

-- ---------------------------------------------------------------------------
-- Buyers, keys
-- ---------------------------------------------------------------------------

CREATE TABLE buyers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text,
  email                       text UNIQUE,
  password_hash               text, -- buyer portal login (P0 password)
  auto_topup_enabled          bool   NOT NULL DEFAULT false,
  auto_topup_amount_cents     int    NOT NULL DEFAULT 2000,
  auto_topup_threshold_micros bigint NOT NULL DEFAULT 2000000,
  monthly_topup_cap_cents     int    NOT NULL DEFAULT 10000,
  vault_id                    text,
  vault_kind                  text CHECK (vault_kind IN ('CARD', 'PAYPAL')),
  per_call_max_micros         bigint NOT NULL DEFAULT 1000000,
  is_simulated                bool   NOT NULL DEFAULT false,
  -- Demo: the next top-up is declined by the mock (ALLOW_MOCK_DECLINE, sandbox only).
  mock_decline_next           bool   NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id           uuid NOT NULL REFERENCES buyers (id),
  name               text,
  prefix             text NOT NULL, -- first 8 chars, shown
  key_hash           text NOT NULL UNIQUE, -- SHA-256
  scopes             text[] NOT NULL DEFAULT '{read}',
  rate_limit_per_min int NOT NULL DEFAULT 60,
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_buyer_id_idx ON api_keys (buyer_id);

-- ---------------------------------------------------------------------------
-- Ledger (double entry, micros)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL
                 CHECK (kind IN ('BUYER_BALANCE', 'PUBLISHER_PAYABLE', 'PLATFORM_REVENUE', 'PAYPAL_CASH', 'PAYOUTS_IN_FLIGHT')),
  owner_id       uuid, -- buyer / publisher id; NULL for platform accounts
  balance_micros bigint NOT NULL DEFAULT 0, -- cached sum of entries, same transaction
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_kind_owner_key UNIQUE NULLS NOT DISTINCT (kind, owner_id),
  CONSTRAINT ledger_accounts_owner_matches_kind
    CHECK ((kind IN ('BUYER_BALANCE', 'PUBLISHER_PAYABLE')) = (owner_id IS NOT NULL)),
  -- PUBLISHER_PAYABLE may go negative (a claim credited after a payout claws back).
  CONSTRAINT ledger_accounts_buyer_balance_nonnegative
    CHECK (kind <> 'BUYER_BALANCE' OR balance_micros >= 0)
);

CREATE TABLE ledger_txns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL
                  CHECK (kind IN ('TOPUP', 'CHARGE', 'CREDIT', 'REFUND', 'REFUND_REVERSAL',
                                  'PAYOUT_SENT', 'PAYOUT_SETTLED', 'PAYOUT_RETURNED', 'DEMO_RESET')),
  idempotency_key text NOT NULL UNIQUE,
  ref_type        text,
  ref_id          uuid,
  memo            text,
  is_simulated    bool NOT NULL DEFAULT false,
  -- Caller may backdate created_at only when is_simulated (SP-036's simulated week);
  -- enforced by ledger_txns_no_backdate below.
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_txns_ref_idx ON ledger_txns (ref_type, ref_id);
CREATE INDEX ledger_txns_created_idx ON ledger_txns (created_at);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  txn_id        uuid   NOT NULL REFERENCES ledger_txns (id),
  account_id    uuid   NOT NULL REFERENCES ledger_accounts (id),
  amount_micros bigint NOT NULL CONSTRAINT ledger_entries_amount_nonzero CHECK (amount_micros <> 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries (txn_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id);

-- "CHECK (is_simulated OR created_at >= now() - interval '5 minutes')", as an INSERT trigger:
-- a CHECK calling now() would be re-evaluated on every UPDATE of an old row and would break
-- pg_dump/restore. Entries inherit is_simulated from their txn.
CREATE FUNCTION ledger_no_backdate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  simulated bool;
BEGIN
  IF TG_TABLE_NAME = 'ledger_txns' THEN
    simulated := NEW.is_simulated;
  ELSE
    SELECT t.is_simulated INTO simulated FROM ledger_txns t WHERE t.id = NEW.txn_id;
  END IF;
  IF NOT coalesce(simulated, false) AND NEW.created_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION '%: created_at may be backdated only for is_simulated rows', TG_TABLE_NAME
      USING ERRCODE = '23514', CONSTRAINT = TG_TABLE_NAME || '_no_backdate';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_txns_no_backdate BEFORE INSERT ON ledger_txns
  FOR EACH ROW EXECUTE FUNCTION ledger_no_backdate();
CREATE TRIGGER ledger_entries_no_backdate BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_no_backdate();

-- Every txn's entries sum to 0, checked at COMMIT.
CREATE FUNCTION ledger_entries_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
BEGIN
  SELECT coalesce(sum(amount_micros), 0) INTO total FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger txn % is unbalanced: entries sum to %', NEW.txn_id, total
      USING ERRCODE = '23514', CONSTRAINT = 'ledger_entries_balanced';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_check_balanced();

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Top-ups, paid calls, claims, refunds
-- ---------------------------------------------------------------------------

CREATE TABLE topups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- also the order-create PayPal-Request-Id
  buyer_id          uuid NOT NULL REFERENCES buyers (id),
  amount_cents      int  NOT NULL CHECK (amount_cents BETWEEN 500 AND 50000),
  currency          text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  method            text CHECK (method IN ('PAYPAL_WALLET', 'CARD', 'VAULT_MIT')),
  trigger           text NOT NULL DEFAULT 'MANUAL' CHECK (trigger IN ('MANUAL', 'AUTO', 'MCP', 'SIM')),
  paypal_order_id   text UNIQUE,
  paypal_capture_id text UNIQUE,
  status            text NOT NULL DEFAULT 'CREATED'
                    CHECK (status IN ('CREATED', 'AWAITING_APPROVAL', 'COMPLETED', 'PARTIALLY_REFUNDED',
                                      'REFUNDED', 'FAILED', 'ABANDONED')),
  refunded_cents    int  NOT NULL DEFAULT 0 CHECK (refunded_cents BETWEEN 0 AND amount_cents),
  ledger_txn_id     uuid REFERENCES ledger_txns (id),
  error_code        text,
  idempotency_key   text,
  pending_reason    text, -- capture PENDING (e.g. eCheck): stays AWAITING_APPROVAL, no credit
  paypal_fee_cents  int,
  needs_reconcile   bool NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, idempotency_key)
);
CREATE INDEX topups_buyer_trigger_status_idx ON topups (buyer_id, trigger, status);
CREATE INDEX topups_status_created_idx ON topups (status, created_at);

CREATE TABLE api_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id           uuid NOT NULL REFERENCES buyers (id),
  api_key_id         uuid NOT NULL REFERENCES api_keys (id),
  channel            text NOT NULL CHECK (channel IN ('REST', 'MCP')),
  dataset_id         uuid REFERENCES datasets (id),
  endpoint           text,
  idempotency_key    text NOT NULL,
  request_hash       text,
  status             text NOT NULL DEFAULT 'RECEIVED'
                     CHECK (status IN ('RECEIVED', 'REJECTED', 'PAYMENT_REQUIRED', 'CHARGED',
                                       'PARTIALLY_CREDITED', 'CREDITED', 'NOT_CHARGED')),
  records_returned   int,
  changes_returned   int,
  unit_price_micros  bigint,
  price_micros       bigint NOT NULL DEFAULT 0,
  credited_micros    bigint NOT NULL DEFAULT 0,
  commission_bps     int, -- snapshot of the publisher's commission at call time
  served_record_keys jsonb, -- keys + hashes served; kept >= 7 days for claims after response_body is purged
  hidden_at          timestamptz, -- SP-038 hides demo calls instead of deleting them
  http_status        int,
  response_body      jsonb, -- 24 h, for idempotent replay
  charge_txn_id      uuid REFERENCES ledger_txns (id),
  is_simulated       bool NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_calls_api_key_id_idempotency_key_key UNIQUE (api_key_id, idempotency_key)
);
CREATE INDEX api_calls_buyer_created_idx ON api_calls (buyer_id, created_at DESC);
CREATE INDEX api_calls_dataset_created_idx ON api_calls (dataset_id, created_at DESC);

CREATE TABLE claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_call_id       uuid NOT NULL REFERENCES api_calls (id),
  record_id         uuid NOT NULL REFERENCES records (id),
  buyer_id          uuid NOT NULL REFERENCES buyers (id),
  reason            text NOT NULL CHECK (reason IN ('STALE', 'WRONG_VALUE', 'MISSING_FIELD', 'DUPLICATE', 'REMOVED')),
  note              text,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'AUTO_CREDITED', 'CREDITED', 'REJECTED')),
  credit_micros     bigint,
  decided_by        text CHECK (decided_by IN ('AUTO', 'PUBLISHER', 'ADMIN')),
  ai_recommendation jsonb,
  ledger_txn_id     uuid REFERENCES ledger_txns (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_call_id, record_id)
);
CREATE INDEX claims_buyer_idx ON claims (buyer_id, created_at DESC);

CREATE TABLE balance_refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- also the PayPal-Request-Id
  buyer_id         uuid NOT NULL REFERENCES buyers (id),
  topup_id         uuid NOT NULL REFERENCES topups (id),
  amount_cents     int  NOT NULL CHECK (amount_cents > 0),
  currency         text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  paypal_refund_id text UNIQUE,
  status           text NOT NULL DEFAULT 'REQUESTED'
                   CHECK (status IN ('REQUESTED', 'PENDING', 'COMPLETED', 'FAILED')),
  ledger_txn_id    uuid REFERENCES ledger_txns (id),
  error_code       text,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, idempotency_key)
);
CREATE INDEX balance_refunds_topup_idx ON balance_refunds (topup_id);
CREATE INDEX balance_refunds_status_idx ON balance_refunds (status, created_at);

-- ---------------------------------------------------------------------------
-- Payouts
-- ---------------------------------------------------------------------------

CREATE TABLE payout_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- also sender_batch_id
  period_start    timestamptz,
  period_end      timestamptz,
  trigger         text NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL_DEMO')),
  status          text NOT NULL DEFAULT 'BUILDING'
                  CHECK (status IN ('BUILDING', 'SUBMITTED', 'PENDING', 'PROCESSING', 'SUCCESS',
                                    'PARTIAL', 'DENIED', 'FAILED')),
  paypal_batch_id text UNIQUE,
  total_cents     int,
  item_count      int,
  currency        text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  needs_reconcile bool NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payout_batches_one_schedule_per_period
  ON payout_batches (period_end) WHERE trigger = 'SCHEDULE';

CREATE TABLE payout_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- also sender_item_id
  batch_id          uuid NOT NULL REFERENCES payout_batches (id),
  publisher_id      uuid NOT NULL REFERENCES publishers (id),
  receiver_email    text,
  gross_micros      bigint,
  commission_micros bigint,
  net_cents         int,
  currency          text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  fee_cents         int,
  paypal_item_id    text,
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'SUCCESS', 'UNCLAIMED', 'RETURNED', 'FAILED')),
  error_code        text,
  ledger_txn_id     uuid REFERENCES ledger_txns (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_items_batch_idx ON payout_items (batch_id);
CREATE INDEX payout_items_publisher_status_idx ON payout_items (publisher_id, status);

-- ---------------------------------------------------------------------------
-- Webhooks, audit, jobs
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_events (
  id           text PRIMARY KEY, -- PayPal event id (rule 12: insert, on conflict skip)
  event_type   text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb,
  verified     bool,
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL
               CHECK (actor_type IN ('PUBLISHER', 'BUYER', 'MCP_CLIENT', 'SCHEMA_AGENT', 'WORKFLOW',
                                     'GATE', 'PAYPAL_WEBHOOK', 'SYSTEM', 'SIM')),
  actor_id     text,
  publisher_id uuid,
  entity       text,
  entity_id    uuid,
  action       text NOT NULL,
  paypal_id    text,
  data         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_publisher_at_idx ON audit_events (publisher_id, at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity, entity_id);

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- runEvery (apps/api/src/db/jobs.ts): the last tick each job ran, so two API processes run
-- a job once per tick even when their timers are not aligned.
CREATE TABLE job_ticks (
  name        text PRIMARY KEY,
  last_tick   bigint NOT NULL,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Privileges: no UPDATE / DELETE on the append-only tables for anyone but the owner.
-- The forbid_mutation triggers above cover the owner too.
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, audit_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spigot_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, audit_events FROM spigot_app';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- updated_at touch triggers (every mutable table except records)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'publishers', 'sites', 'templates', 'pages', 'snapshots', 'datasets', 'schema_versions',
    'crawl_runs', 'record_versions', 'bot_hits', 'buyers', 'api_keys', 'ledger_accounts',
    'ledger_txns', 'topups', 'api_calls', 'claims', 'balance_refunds', 'payout_batches',
    'payout_items', 'webhook_events', 'job_ticks'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      t || '_touch_updated_at', t);
  END LOOP;
END $$;
