import { gunzipSync } from 'node:zlib';
import { compileExtractor, recordHash } from '@spigot/shared';
import { withAdvisoryXactLock, type Db } from '../db/index.js';
import { nodeSha256, re2Engine } from './adapters.js';
import {
  removeRecord,
  upsertRecord,
  type RecordRemoval,
  type RecordWrite,
  type WriteContext,
} from './upsert.js';

/**
 * `extractPage` / extract batches (SP-013; features/05 §Logic 1–2, data-model rules 7–8).
 *
 * A batch: load each page's latest snapshot, run the dataset's active extractor (SP-011, pure, no
 * model call anywhere in this module), then write every resulting upsert / removal in ONE
 * transaction that holds `pg_advisory_xact_lock_shared('dataset:<id>')`. `publishWatermark` takes
 * the same key exclusively, so it waits for every in-flight batch of every run (crawl, APPROVE,
 * ping, re-crawl) before it reads `max(seq)`: no seq can commit below a published watermark.
 *
 * Never call `publishWatermark` while holding a batch transaction open on the same dataset.
 */

export interface ExtractCounts {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Writes dropped because the record already reflects a newer snapshot. */
  stale: number;
}

export interface ExtractBatchResult extends ExtractCounts {
  /** Set when the batch wrote nothing on purpose. */
  skipped?: 'LIVE_STALE' | 'NO_ACTIVE_SCHEMA' | 'NO_DATASET';
}

export interface ExtractBatchOptions {
  /** Test seam: inside the batch transaction, after the record writes, before the run counters and COMMIT. */
  beforeCommit?: () => Promise<void>;
}

interface DatasetRow {
  status: string;
  template_id: string | null;
  extractor: Record<string, unknown> | null;
  record_key: unknown;
}

interface PageRow {
  id: string;
  url: string;
  removed_at: Date | null;
  sitemap_lastmod: Date | null;
  fetched_at: Date | null;
  http_status: number | null;
  html_gz: Buffer | null;
}

const emptyCounts = (): ExtractCounts => ({
  added: 0,
  updated: 0,
  removed: 0,
  unchanged: 0,
  stale: 0,
});

export function addCounts(a: ExtractCounts, b: ExtractCounts): ExtractCounts {
  return {
    added: a.added + b.added,
    updated: a.updated + b.updated,
    removed: a.removed + b.removed,
    unchanged: a.unchanged + b.unchanged,
    stale: a.stale + b.stale,
  };
}

type Op = { kind: 'upsert'; w: RecordWrite } | { kind: 'remove'; r: RecordRemoval };
const keyOf = (op: Op) => (op.kind === 'upsert' ? op.w.recordKey : op.r.recordKey);

/** Extract and write a batch of pages of one dataset in one transaction. */
export async function extractPages(
  db: Db,
  args: { datasetId: string; runId: string; pageIds: readonly string[] },
  opts: ExtractBatchOptions = {},
): Promise<ExtractBatchResult> {
  const { datasetId, runId } = args;
  const ds = (
    await db.pool.query<DatasetRow>(
      `SELECT d.status, d.template_id, sv.extractor, sv.record_key
         FROM datasets d LEFT JOIN schema_versions sv ON sv.id = d.active_schema_id
        WHERE d.id = $1`,
      [datasetId],
    )
  ).rows[0];
  if (!ds) return { ...emptyCounts(), skipped: 'NO_DATASET' };
  if (ds.status === 'LIVE_STALE') return { ...emptyCounts(), skipped: 'LIVE_STALE' };
  if (!ds.extractor || !ds.template_id) return { ...emptyCounts(), skipped: 'NO_ACTIVE_SCHEMA' };
  if (args.pageIds.length === 0) return emptyCounts();

  // `schema_versions.record_key` is the dedicated column; the spec may also carry its own.
  const extractor = compileExtractor(
    { ...ds.extractor, recordKey: ds.record_key ?? ds.extractor.recordKey },
    { regex: re2Engine },
  );

  // Pages of this dataset's template with their latest 2xx snapshot.
  const pages = (
    await db.pool.query<PageRow>(
      `SELECT p.id, p.url, p.removed_at, p.sitemap_lastmod, s.fetched_at, s.http_status, s.html_gz
         FROM pages p
         LEFT JOIN LATERAL (
           SELECT fetched_at, http_status, html_gz FROM snapshots
            WHERE page_id = p.id AND html_gz IS NOT NULL
            ORDER BY fetched_at DESC, id DESC LIMIT 1
         ) s ON true
        WHERE p.id = ANY($1::uuid[]) AND p.template_id = $2`,
      [args.pageIds, ds.template_id],
    )
  ).rows;
  const pageIds = pages.map((p) => p.id);

  // Live records currently sourced from these pages (a page normally has one).
  const liveKeys = new Map<string, string[]>();
  for (const r of (
    await db.pool.query<{ page_id: string; record_key: string }>(
      `SELECT page_id, record_key FROM records
        WHERE dataset_id = $1 AND page_id = ANY($2::uuid[]) AND removed_at IS NULL`,
      [datasetId, pageIds],
    )
  ).rows) {
    liveKeys.set(r.page_id, [...(liveKeys.get(r.page_id) ?? []), r.record_key]);
  }

  const ops: Op[] = [];
  const removeAll = (pageId: string, at: Date, except?: string) => {
    for (const recordKey of liveKeys.get(pageId) ?? []) {
      if (recordKey !== except) ops.push({ kind: 'remove', r: { recordKey, pageId, at } });
    }
  };
  for (const p of pages) {
    if (p.removed_at) {
      removeAll(p.id, p.removed_at);
      continue;
    }
    if (
      !p.html_gz ||
      !p.fetched_at ||
      (p.http_status !== null && (p.http_status < 200 || p.http_status > 299))
    ) {
      continue; // nothing usable fetched yet: leave the record alone
    }
    const rec = extractor.extract(gunzipSync(p.html_gz).toString('utf8'), p.url);
    if (!rec) {
      removeAll(p.id, p.fetched_at);
      continue;
    }
    ops.push({
      kind: 'upsert',
      w: {
        recordKey: rec.recordKey,
        pageId: p.id,
        data: rec.data,
        hash: recordHash(rec.data, nodeSha256),
        crawledAt: p.fetched_at,
        sourceLastmod: p.sitemap_lastmod,
      },
    });
    // The page's record key changed (e.g. a new JSON-LD @id): the old record goes.
    removeAll(p.id, p.fetched_at, rec.recordKey);
  }
  // One global lock order for record locks across overlapping batches; upserts before removals
  // of the same key, so a key moving between pages becomes an update, not remove + add.
  ops.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.kind === b.kind ? 0 : a.kind === 'upsert' ? -1 : 1;
  });

  const ctx: WriteContext = { datasetId, runId };
  return db.tx(async (tx) => {
    await withAdvisoryXactLock(tx, `dataset:${datasetId}`, { shared: true });
    // Drift (SP-052a) may have flipped the dataset while we were extracting.
    const status = (
      await tx.query<{ status: string }>('SELECT status FROM datasets WHERE id = $1', [datasetId])
    ).rows[0]?.status;
    if (status === 'LIVE_STALE') return { ...emptyCounts(), skipped: 'LIVE_STALE' as const };

    const counts = emptyCounts();
    for (const op of ops) {
      const outcome =
        op.kind === 'upsert'
          ? await upsertRecord(tx, ctx, op.w)
          : await removeRecord(tx, ctx, op.r);
      counts[outcome] += 1;
    }
    await opts.beforeCommit?.();
    // Last statement: concurrent batches of one run hold this row lock only until their COMMIT.
    if (counts.added + counts.updated + counts.removed > 0) {
      await tx.query(
        `UPDATE crawl_runs
            SET records_added = records_added + $2, records_updated = records_updated + $3,
                records_removed = records_removed + $4
          WHERE id = $1`,
        [runId, counts.added, counts.updated, counts.removed],
      );
    }
    return counts;
  });
}

/**
 * Workflows task: extract one page into its dataset (features/03 layout: `fetchPage → 0–1 ×
 * extractPage`). Writes versions but doesn't publish them; the run's last step calls
 * `publishWatermark`. Idempotent: a re-run upserts by `record_key` with hash compare.
 */
export async function extractPage(
  db: Db,
  args: { pageId: string; datasetId: string; runId: string },
): Promise<ExtractBatchResult> {
  return extractPages(db, { datasetId: args.datasetId, runId: args.runId, pageIds: [args.pageId] });
}
