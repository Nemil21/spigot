import jsonpatch from 'fast-json-patch';
import type { RecordData } from '@spigot/shared';
import { withAdvisoryXactLock, type Tx } from '../db/index.js';

/**
 * The extractor's writes to `records` + `record_versions` (SP-013; features/05 §Logic 2,
 * data-model §records, rule 8). Only a real content change bumps `version`, writes a version row
 * and moves `records.updated_at`; a hash-equal re-extract refreshes `crawled_at` alone.
 *
 * Every call runs inside an extract batch transaction that already holds the shared
 * `dataset:<id>` lock (see extractPage.ts). Each record is serialized across concurrent runs by a
 * transaction-scoped `record:<datasetId>:<key>` advisory lock, taken before the previous row is
 * read, so the JSON Patch is always computed against the version it replaces. Callers apply
 * operations sorted by record key, so two overlapping batches take these locks in the same order.
 *
 * Stale-snapshot guard: `crawled_at` is the `fetched_at` of the snapshot the row was last
 * extracted from. A write whose evidence is older than that (an APPROVE run that loaded its
 * snapshots before a crawl stored a newer one) is dropped, so overlapping runs can't revert a
 * record to older content.
 */

export interface WriteContext {
  datasetId: string;
  /** `crawl_runs.id`: every version row carries it. */
  runId: string;
}

export type WriteOutcome = 'added' | 'updated' | 'removed' | 'unchanged' | 'stale';

export interface RecordWrite {
  recordKey: string;
  pageId: string;
  data: RecordData;
  /** `recordHash(data)`. */
  hash: string;
  /** The snapshot's `fetched_at`: becomes `records.crawled_at`. */
  crawledAt: Date;
  sourceLastmod: Date | null;
}

export interface RecordRemoval {
  recordKey: string;
  /** Only a record still sourced from this page is removed. */
  pageId: string;
  /** When the page was found gone (or the extractor returned null for it). */
  at: Date;
}

interface PrevRow {
  data: RecordData;
  removed_at: Date | null;
  crawled_at: Date | null;
}

const REMOVE_PATCH = JSON.stringify([{ op: 'remove', path: '' }]);

async function lockAndRead(
  tx: Tx,
  ctx: WriteContext,
  recordKey: string,
): Promise<PrevRow | undefined> {
  await withAdvisoryXactLock(tx, `record:${ctx.datasetId}:${recordKey}`);
  const { rows } = await tx.query<PrevRow>(
    `SELECT data, removed_at, crawled_at FROM records
      WHERE dataset_id = $1 AND record_key = $2
      FOR UPDATE`,
    [ctx.datasetId, recordKey],
  );
  return rows[0];
}

async function insertVersion(
  tx: Tx,
  ctx: WriteContext,
  v: {
    recordId: string;
    version: number;
    op: 'add' | 'update' | 'remove';
    patch: string;
    hash: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash, crawl_run_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [ctx.datasetId, v.recordId, v.version, v.op, v.patch, v.hash, ctx.runId],
  );
}

/** Insert, update, revive or freshness-refresh one record. */
export async function upsertRecord(
  tx: Tx,
  ctx: WriteContext,
  w: RecordWrite,
): Promise<WriteOutcome> {
  const prev = await lockAndRead(tx, ctx, w.recordKey);
  if (prev?.crawled_at && prev.crawled_at > w.crawledAt) return 'stale';

  // Rule 8: the conditional upsert. No row back = same hash on a live record.
  const { rows } = await tx.query<{ id: string; version: number; inserted: boolean }>(
    `INSERT INTO records (dataset_id, record_key, page_id, data, hash, version, crawled_at, source_lastmod, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, 1, $6, $7, now())
     ON CONFLICT (dataset_id, record_key) DO UPDATE
       SET data = EXCLUDED.data, hash = EXCLUDED.hash, version = records.version + 1,
           page_id = EXCLUDED.page_id, crawled_at = EXCLUDED.crawled_at,
           source_lastmod = EXCLUDED.source_lastmod, removed_at = NULL, updated_at = now()
       WHERE records.hash <> EXCLUDED.hash OR records.removed_at IS NOT NULL
     RETURNING id, version, (xmax = 0) AS inserted`,
    [
      ctx.datasetId,
      w.recordKey,
      w.pageId,
      JSON.stringify(w.data),
      w.hash,
      w.crawledAt,
      w.sourceLastmod,
    ],
  );
  const row = rows[0];

  if (!row) {
    // Unchanged: freshness only. `updated_at` stays put.
    await tx.query(
      `UPDATE records
          SET crawled_at = GREATEST(crawled_at, $3), source_lastmod = $4, page_id = $5
        WHERE dataset_id = $1 AND record_key = $2`,
      [ctx.datasetId, w.recordKey, w.crawledAt, w.sourceLastmod, w.pageId],
    );
    return 'unchanged';
  }

  // A new record, or a removed one coming back: the buyer gets the whole object again.
  if (row.inserted || !prev || prev.removed_at) {
    await insertVersion(tx, ctx, {
      recordId: row.id,
      version: row.version,
      op: 'add',
      patch: JSON.stringify([{ op: 'add', path: '', value: w.data }]),
      hash: w.hash,
    });
    return 'added';
  }

  await insertVersion(tx, ctx, {
    recordId: row.id,
    version: row.version,
    op: 'update',
    patch: JSON.stringify(jsonpatch.compare(prev.data, w.data)),
    hash: w.hash,
  });
  return 'updated';
}

/** Soft-delete one live record still sourced from `pageId`; emits a `remove` version. */
export async function removeRecord(
  tx: Tx,
  ctx: WriteContext,
  r: RecordRemoval,
): Promise<WriteOutcome> {
  const prev = await lockAndRead(tx, ctx, r.recordKey);
  if (!prev || prev.removed_at) return 'unchanged';
  if (prev.crawled_at && prev.crawled_at > r.at) return 'stale';

  const { rows } = await tx.query<{ id: string; version: number; hash: string }>(
    `UPDATE records
        SET removed_at = now(), updated_at = now(), version = version + 1,
            crawled_at = GREATEST(crawled_at, $4)
      WHERE dataset_id = $1 AND record_key = $2 AND page_id = $3 AND removed_at IS NULL
      RETURNING id, version, hash`,
    [ctx.datasetId, r.recordKey, r.pageId, r.at],
  );
  const row = rows[0];
  if (!row) return 'unchanged'; // the key now lives on another page
  await insertVersion(tx, ctx, {
    recordId: row.id,
    version: row.version,
    op: 'remove',
    patch: REMOVE_PATCH,
    hash: row.hash,
  });
  return 'removed';
}
