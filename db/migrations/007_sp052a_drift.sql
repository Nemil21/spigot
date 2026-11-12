-- SP-052a: drift detection (features/04 §7; data-model.md, dataset state machine LIVE_STALE).
--
-- "Probe before writing": in each crawl run, a LIVE dataset's changed pages are held (not
-- extracted) until a dry run of the extractor on the first 20 of them is compared with the
-- approved `sample_stats`. Passed → the held pages are extracted and later ones go straight
-- through; drifted → LIVE → LIVE_STALE and the run writes no version for the dataset.
--
-- `drift_checks`: one row per (dataset, run); its row lock serializes the decision.
-- `drift_pages`: every changed page of the dataset in the run (the post-run backstop reads all of
-- them); `held` = changed but not extracted yet (released once the probe passed and the page was
-- extracted, so a crash between the two is retried at run end).
CREATE TABLE drift_checks (
  dataset_id uuid NOT NULL REFERENCES datasets (id),
  run_id     uuid NOT NULL REFERENCES crawl_runs (id),
  status     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PASSED', 'DRIFTED')),
  -- Null rates the probe measured and why it decided (reasons), at decision time.
  probe      jsonb,
  -- The post-run check over every changed page of the run (null until it ran).
  backstop   jsonb,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, run_id)
);
CREATE INDEX drift_checks_run_idx ON drift_checks (run_id);

CREATE TABLE drift_pages (
  dataset_id uuid NOT NULL,
  run_id     uuid NOT NULL,
  page_id    uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  held       boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (dataset_id, run_id, page_id),
  FOREIGN KEY (dataset_id, run_id) REFERENCES drift_checks (dataset_id, run_id)
);

CREATE TRIGGER drift_checks_touch_updated_at BEFORE UPDATE ON drift_checks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
