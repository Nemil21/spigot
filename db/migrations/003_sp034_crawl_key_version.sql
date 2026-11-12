-- SP-034: crawl-key rotation (W16 Keys tab; features/02 §Edge cases "Our crawler's key leaked").
-- The crawl key is derived from SESSION_SECRET and the site id (apps/api/src/crawl/crawlKey.ts),
-- so the crawler can recompute it without the key ever being stored. Rotation bumps this counter:
-- the crawler derives the key for the current version, `crawl_key_hash` is replaced with the new
-- key's hash, and the old key is no longer recognised. Version 1 is the original derivation, so
-- every existing site keeps its key.
ALTER TABLE sites ADD COLUMN crawl_key_version int NOT NULL DEFAULT 1 CHECK (crawl_key_version >= 1);
