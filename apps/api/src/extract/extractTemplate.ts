import type { Db } from '../db/index.js';
import {
  addCounts,
  extractPages,
  type ExtractBatchResult,
  type ExtractCounts,
} from './extractPage.js';
import { publishWatermark } from './publishWatermark.js';

/** Snapshots per batch transaction (features/03 §Render Workflows layout). */
export const EXTRACT_BATCH_SIZE = 200;

export interface ExtractTemplateResult extends ExtractCounts {
  batches: number;
  skipped?: ExtractBatchResult['skipped'];
  publishedSeq: number;
  recordCount: number;
}

/**
 * Workflows task: (re-)extract every page of a dataset's template (SP-013). Called on approve by
 * SP-014a with a `crawl_runs` row of `trigger = APPROVE`, so every version carries a run id. Each
 * batch of 200 is its own transaction under the shared dataset lock; once all have committed,
 * `publishWatermark` makes the run's changes visible. Pages that are gone (or no longer yield a
 * record) remove their record. Idempotent: a re-run writes no versions.
 */
export async function extractTemplate(
  db: Db,
  args: { datasetId: string; runId: string },
  opts: { batchSize?: number } = {},
): Promise<ExtractTemplateResult> {
  const batchSize = opts.batchSize ?? EXTRACT_BATCH_SIZE;
  const pageIds = (
    await db.pool.query<{ id: string }>(
      `SELECT p.id FROM pages p JOIN datasets d ON d.template_id = p.template_id
        WHERE d.id = $1 ORDER BY p.id`,
      [args.datasetId],
    )
  ).rows.map((r) => r.id);

  let totals: ExtractCounts = { added: 0, updated: 0, removed: 0, unchanged: 0, stale: 0 };
  let batches = 0;
  let skipped: ExtractBatchResult['skipped'];
  for (let i = 0; i < pageIds.length; i += batchSize) {
    const res = await extractPages(db, { ...args, pageIds: pageIds.slice(i, i + batchSize) });
    batches += 1;
    if (res.skipped) {
      skipped = res.skipped;
      break;
    }
    totals = addCounts(totals, res);
  }

  const { publishedSeq, recordCount } = await publishWatermark(db, { datasetId: args.datasetId });
  return { ...totals, batches, ...(skipped ? { skipped } : {}), publishedSeq, recordCount };
}
