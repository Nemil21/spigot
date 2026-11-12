-- SP-009b: `POST /api/sites/:id/crawl` takes an Idempotency-Key (api.md). The key is stored on
-- the run it created, so a retry with the same key (even one racing the first request) gets the
-- same run back instead of a second run or a 409. Scoped per site; NULL (no key) never conflicts.
ALTER TABLE crawl_runs ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX crawl_runs_site_idempotency_key
  ON crawl_runs (site_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
