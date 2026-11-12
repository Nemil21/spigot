-- SP-048c: STALE / REMOVED claims re-fetch the record's source page (features/10 §Claims 2).
--
-- `CLAIM` runs: the one targeted `fetchPage` a claim makes runs inside its own `crawl_runs` row
-- (every snapshot and version carries a run id). Like APPROVE runs, a CLAIM run may overlap the
-- site's live crawl, so it is left out of the one-live-crawl index (rule 9): otherwise a "Crawl
-- now" landing during a claim would join the claim's one-page run instead of crawling.
ALTER TABLE crawl_runs DROP CONSTRAINT crawl_runs_trigger_check;
ALTER TABLE crawl_runs ADD CONSTRAINT crawl_runs_trigger_check
  CHECK (trigger IN ('CONNECT', 'MANUAL', 'SCHEDULE', 'PING', 'DEMO_MUTATE', 'APPROVE', 'CLAIM'));

DROP INDEX crawl_runs_one_live_per_site;
CREATE UNIQUE INDEX crawl_runs_one_live_per_site
  ON crawl_runs (site_id)
  WHERE status IN ('QUEUED', 'RUNNING') AND trigger <> 'APPROVE' AND trigger <> 'CLAIM';

-- At most one targeted re-fetch per record per 10 minutes: the latest one per record. A repeat
-- claim inside the window reuses it (and compares its own served version with the record now).
-- `outcome`: FETCHED (200 / 304, the record is as the page is now), GONE (404 / 410, or the
-- page was already removed), FAILED (network, other status, rate limited, or no source page).
CREATE TABLE record_refetches (
  record_id    uuid PRIMARY KEY REFERENCES records (id),
  crawl_run_id uuid REFERENCES crawl_runs (id),
  outcome      text NOT NULL CHECK (outcome IN ('FETCHED', 'GONE', 'FAILED')),
  http_status  int,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
