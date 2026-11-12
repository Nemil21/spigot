# 05: Records, Versions & Changes Feed

**Priority:** P0 (records, versions, JSON Patch, cursor feed, watermark) · P1 (CMS ping) · **Owner:** A · **Effort:** 2.5 h

## Purpose
Price **records and changes, not pages**. Buyers who poll a site re-fetch mostly unchanged pages; with Spigot they ask "what changed since my cursor?" and pay only for the changes.

## User stories
- As a buyer agent, I ask for listings changed today and pay only for those.
- As a buyer, I keep a cursor and never miss or double-count a change.
- As a site owner, I see how many records changed in each crawl.

## Screens
W07 Records browser (P1) · W10 Crawls (added/updated/removed) · W06 (record count)

## Logic
1. **`extractPage(pageId, datasetId)`**: load the latest snapshot, run the active extractor (`packages/shared/extract.ts`), build `record_key` (e.g. `listings/<slug>` from URL), canonicalize `data` (sorted keys, normalized numbers, ISO dates), `hash = sha256(canonical)`.
2. **Upsert** in one transaction (data-model rule 8):
   ```sql
   INSERT INTO records (dataset_id, record_key, page_id, data, hash, version, crawled_at, source_lastmod)
   VALUES ($1,$2,$3,$4,$5,1,now(),$6)
   ON CONFLICT (dataset_id, record_key) DO UPDATE
     SET data=EXCLUDED.data, hash=EXCLUDED.hash, version=records.version+1, crawled_at=now(), removed_at=NULL
     WHERE records.hash <> EXCLUDED.hash OR records.removed_at IS NOT NULL
   RETURNING id, version, (xmax = 0) AS inserted;
   ```
   - Inserted → `record_versions(op='add', patch=[{op:'add', path:'', value:data}])`.
   - Updated → `patch = fast-json-patch.compare(old.data, new.data)`, `op='update'`.
   - No row returned → unchanged, nothing written.
   - Page removed or extractor returns null on a page that had a record → `removed_at = now()`, `op='remove'`.
   - Hash-equal pages also refresh `crawled_at` (freshness) without a version.
3. **Watermark:** after the run's page batches commit, `publishWatermark` advances `datasets.published_seq` (data-model rule 7). Readers never see seqs above it, so a cursor can't skip an in-flight change.
4. **Serving records:** query by filters over `data` (parameterized; field names from the schema allowlist; casts by schema type) with `removed_at IS NULL`, ordered by `updated_at DESC, id`. Keyset pagination cursor = `(updated_at, id)` base64.
5. **Serving changes:** `SELECT … FROM record_versions WHERE dataset_id=$1 AND seq > $since AND seq <= published_seq ORDER BY seq LIMIT $n`. Cursor = `c_<seq>`. Hidden fields: drop patch ops whose path starts with a hidden field; if an `add`/`include=record` value is an object, strip hidden keys. A change whose only ops touched hidden fields is skipped (and not charged).
6. **Freshness** on every record: `crawledAt`, `sourceLastmod`, `staleSince` (dataset level, 04 drift).
7. **Retention:** keep 30 days of `record_versions`; `since` older than retention → `410 CURSOR_EXPIRED` with a hint to resync via `/records`.
8. **Ping (P1):** `POST /api/sites/:id/ping` with URLs → targeted `fetchPage` → same path.

## "Changed today" query (the demo question)
`search_records` with `updated_at[gte]=<today 00:00 site tz>&bedrooms[gte]=3&price_usd[lt]=2000` — or `get_changes(since=<morning cursor>)`. Both work; the demo uses `search_records` (simpler to narrate) and shows `get_changes` once.

## Edge cases
| Case | Handling |
|---|---|
| Same page crawled twice concurrently | One run per site; upsert with hash compare is idempotent anyway |
| Field order or whitespace changes only | Canonicalization → same hash → no change |
| Record moves URL (slug change) | Remove + add (documented); P2: key by JSON-LD `@id` when present |
| Buyer cursor from another dataset | Cursor is validated against dataset id (encoded) → 400 |
| Very large patch (full rewrite) | Fine; still one change |

## Acceptance criteria
- [ ] `demo:mutate --prices 30 --leased 5 --new 3` → next crawl writes exactly 35 `update` versions (30 price, 5 status; the script picks disjoint listings) and 3 `add` versions; no others.
- [ ] Re-crawl with no changes writes 0 versions.
- [ ] A cursor read during a running crawl never skips a change (concurrency test: reader loop + crawler).
- [ ] Hidden fields never appear in records or patches (test with `agent_phone`).

## Test plan
Unit: canonicalize + hash; patch for each op; hidden-field stripping. Integration: mutate → crawl → changes. Concurrency: 2 parallel extract batches + a reader polling the feed; assert seen seqs are contiguous up to the watermark.
