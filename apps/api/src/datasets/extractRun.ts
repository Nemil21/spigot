import { PUBLISHER_EVENTS_CHANNEL, publisherEvent } from '@spigot/shared';
import { emitRunFinished } from '../crawl/hooks.js';
import { notify, transition, type Db, type Queryable } from '../db/index.js';
import { extractPage } from '../extract/extractPage.js';
import { extractTemplate, type ExtractTemplateResult } from '../extract/extractTemplate.js';
import { publishWatermark } from '../extract/publishWatermark.js';
import { SOLD_DATASET_STATUSES } from '../gate/policy.js';
import { ensureFilterIndexes } from './filterIndexes.js';

/**
 * Extraction wiring (SP-014a; features/04 §6, features/03 layout `fetchPage → 0–1 × extractPage`).
 *
 * - The APPROVE run: filter indexes, then `extractTemplate` over every page of the template under
 *   SP-013's dataset locks (it publishes the watermark itself), `dataset.extract.progress` per
 *   batch, then the run ends like any other (`onRunFinished`). It has its own `crawl_runs` row
 *   (`trigger = APPROVE`), which the one-live-crawl index ignores, so it may overlap a crawl.
 * - Crawl hooks: `onPageChanged` → `extractPage` into every LIVE / LIVE_STALE dataset of the
 *   page's template; `onRunFinished` → `publishWatermark` for the site's sold datasets, so a
 *   crawl's changes become visible in the feed once all its batches committed.
 *
 * A page the sitemap introduced after the schema agent ran has no `template_id`. It joins the
 * template of a sold dataset whose `url_pattern` matches its path, when exactly one does (two
 * templates can share a pattern and differ by JSON-LD types; then we don't guess).
 */

const SOLD = [...SOLD_DATASET_STATUSES];

/** Path of a stored page URL in SQL, like `urlPath` in @spigot/shared (no query, no trailing /). */
const PATH_SQL = `coalesce(nullif(regexp_replace(regexp_replace(regexp_replace(p.url,
  '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''), '[?#].*$', ''), '/+$', ''), ''), '/')`;

/**
 * Give unassigned pages of `siteId` the template of the sold dataset whose pattern matches.
 * `pageIds` limits it to those pages. Returns the number of pages assigned.
 */
export async function assignTemplates(
  q: Queryable,
  siteId: string,
  pageIds: readonly string[] | null = null,
): Promise<number> {
  const { rowCount } = await q.query(
    `WITH cand AS (
       SELECT p.id, t.id AS template_id, count(*) OVER (PARTITION BY p.id) AS n
         FROM pages p
         JOIN templates t ON t.site_id = p.site_id
         JOIN datasets d ON d.template_id = t.id AND d.status = ANY($3::text[])
        WHERE p.site_id = $1 AND p.template_id IS NULL AND p.removed_at IS NULL
          AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
          AND ${PATH_SQL} ~ t.url_pattern)
     UPDATE pages SET template_id = cand.template_id, updated_at = now()
       FROM cand
      WHERE pages.id = cand.id AND cand.n = 1 AND pages.template_id IS NULL`,
    [siteId, pageIds, SOLD],
  );
  return rowCount ?? 0;
}

/** `onPageChanged` handler: extract the page into each sold dataset of its template. */
export async function extractChangedPage(db: Db, pageId: string, runId: string): Promise<number> {
  const page = (
    await db.pool.query<{ site_id: string; template_id: string | null; removed_at: Date | null }>(
      'SELECT site_id, template_id, removed_at FROM pages WHERE id = $1',
      [pageId],
    )
  ).rows[0];
  if (!page) return 0;
  if (!page.template_id && !page.removed_at) await assignTemplates(db.pool, page.site_id, [pageId]);

  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT d.id FROM datasets d JOIN pages p ON p.template_id = d.template_id
      WHERE p.id = $1 AND d.status = ANY($2::text[])`,
    [pageId, SOLD],
  );
  for (const d of rows) await extractPage({ pageId, datasetId: d.id, runId }, { db });
  return rows.length;
}

/** `onRunFinished` handler: publish the watermark of every sold dataset of the run's site. */
export async function publishRunDatasets(db: Db, runId: string): Promise<string[]> {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT d.id FROM datasets d JOIN crawl_runs r ON r.site_id = d.site_id
      WHERE r.id = $1 AND d.status = ANY($2::text[]) ORDER BY d.id`,
    [runId, SOLD],
  );
  for (const d of rows) await publishWatermark({ datasetId: d.id }, { db });
  return rows.map((r) => r.id);
}

export interface ApproveRunArgs {
  datasetId: string;
  runId: string;
  publisherId: string;
  /** The approved schema's stored fields (for the filter indexes). */
  fields: unknown;
}

export interface ApproveRunOptions {
  /** `false` builds indexes without CONCURRENTLY (inside a caller's transaction). Default true. */
  concurrentIndexes?: boolean;
  batchSize?: number;
  log?: { error: (obj: object, msg: string) => void };
}

export interface ApproveRunResult {
  status: 'SUCCEEDED' | 'FAILED';
  indexes: string[];
  extract: ExtractTemplateResult | null;
  error?: string;
}

const progressEvent = (db: Db, publisherId: string, ids: string[]) =>
  notify(
    db.pool,
    PUBLISHER_EVENTS_CHANNEL,
    publisherEvent(publisherId, 'dataset.extract.progress', ids),
  );

/**
 * The APPROVE run (`crawl_runs.trigger = APPROVE`, created RUNNING by `approveDataset`). Never
 * throws: a failure ends the run FAILED with the error, and the dataset stays LIVE (a later
 * crawl or re-approve extracts again; every step is idempotent).
 */
export async function runApproveExtract(
  db: Db,
  args: ApproveRunArgs,
  opts: ApproveRunOptions = {},
): Promise<ApproveRunResult> {
  const { datasetId, runId, publisherId } = args;
  const ids = [datasetId, runId];
  let indexes: string[] = [];
  let extract: ExtractTemplateResult | null = null;
  let error: string | undefined;

  try {
    indexes = await ensureFilterIndexes(db.pool, args.fields, {
      concurrently: opts.concurrentIndexes ?? true,
    });
  } catch (err) {
    // Filters still work without the index (just slower); don't hold the data back for it.
    opts.log?.error({ err, datasetId }, 'approve: filter index build failed');
  }

  try {
    const ds = (
      await db.pool.query<{ site_id: string }>('SELECT site_id FROM datasets WHERE id = $1', [
        datasetId,
      ])
    ).rows[0];
    if (ds) await assignTemplates(db.pool, ds.site_id);
    await progressEvent(db, publisherId, ids).catch(() => {});
    extract = await extractTemplate(
      { datasetId, runId },
      { db },
      {
        batchSize: opts.batchSize,
        onBatch: async ({ done, total }) => {
          await db.pool.query(
            'UPDATE crawl_runs SET pages_total = $2, pages_fetched = $3 WHERE id = $1',
            [runId, total, done],
          );
          await progressEvent(db, publisherId, ids).catch(() => {});
        },
      },
    );
    if (extract.skipped) error = `Extraction skipped: ${extract.skipped}`;
  } catch (err) {
    error = `Extraction failed: ${(err as Error).message}`;
    opts.log?.error({ err, datasetId, runId }, 'approve: extraction failed');
  }

  const status = error ? 'FAILED' : 'SUCCEEDED';
  const ended = await db
    .tx(async (tx) => {
      const row = await transition(tx, 'crawl_runs', runId, 'RUNNING', status, {
        finished_at: new Date(),
        error: error ?? null,
      });
      if (row) {
        await notify(
          tx,
          PUBLISHER_EVENTS_CHANNEL,
          publisherEvent(publisherId, 'dataset.extract.progress', ids),
        );
      }
      return row !== null;
    })
    .catch((err) => {
      opts.log?.error({ err, runId }, 'approve: could not end the APPROVE run');
      return false;
    });
  if (ended) await emitRunFinished(runId);
  return { status, indexes, extract, ...(error ? { error } : {}) };
}
