-- SP-055: CMS ping (`POST /api/sites/:id/ping`; api.md, features/05 §Logic 8). A ping queues the
-- URLs its CMS says changed; the site's live crawl run (a PING run the ping started, or any run it
-- joined) fetches them before it ends, then deletes the row. Durable on purpose: a run that is
-- paused, aborted or killed leaves its pings for the next run (or the one that adopts it).
--
-- One row per (site, URL): pinging a URL again just moves `requested_at`, and a run deletes a row
-- only if `requested_at` is still the value it read, so a re-ping that lands while the URL is
-- being fetched is fetched again.
CREATE TABLE crawl_pings (
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  url text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (site_id, url)
);
