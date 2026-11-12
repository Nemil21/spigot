-- SP-034: crawl-key rotation (W16 Keys tab; features/02 §Edge cases "Our crawler's key leaked").
-- The crawl key is derived from SESSION_SECRET and the site id (apps/api/src/crawl/crawlKey.ts),
-- so the crawler can recompute it without the key ever being stored. Rotation bumps
-- `crawl_key_version` and replaces `crawl_key_hash`; version 1 is the original derivation, so
-- every existing site keeps its key.
--
-- Handover: the gate holds the hash from its last policy pull (refreshed every 60 s). Until it has
-- pulled a policy at or after the rotation's `policy_version`, the crawler keeps sending
-- `crawl_key_prev_version` (the key the gate still recognises), so its requests are never
-- classified as an unknown bot (and 402-ed when the owner quotes those) in between.
-- `gate_policy_version_seen` is the newest policy version `GET /api/gate/policy` served (200 or
-- 304) for the site.
ALTER TABLE sites
  ADD COLUMN crawl_key_version int NOT NULL DEFAULT 1 CHECK (crawl_key_version >= 1),
  ADD COLUMN crawl_key_prev_version int CHECK (crawl_key_prev_version >= 1),
  ADD COLUMN crawl_key_rotated_policy_version int,
  ADD COLUMN gate_policy_version_seen int;
