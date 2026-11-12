import { withAdvisoryXactLock, type Db } from '../db/index.js';

/**
 * Advance the changes-feed watermark (SP-013; data-model rule 7, features/05 §Logic 3).
 *
 * Takes `dataset:<id>` EXCLUSIVELY, which waits for every in-flight extract batch (they hold it
 * shared) to commit or roll back; only then, in a later statement (so a fresh READ COMMITTED
 * snapshot), reads `max(seq)`. Seqs are a bigserial allocated before commit, so without the lock a
 * slow batch could commit a lower seq after a faster one had been published, and a reader's cursor
 * would already be past it. The watermark never moves backwards.
 *
 * Also refreshes `datasets.record_count` (live records), here rather than per batch so concurrent
 * batches don't contend on the dataset row. Call it after all of a run's batches committed (the
 * run's last step), never from inside a batch transaction on the same dataset.
 */
export async function publishWatermark(
  args: { datasetId: string },
  { db }: { db: Db },
): Promise<{ publishedSeq: number; recordCount: number }> {
  return db.tx(async (tx) => {
    await withAdvisoryXactLock(tx, `dataset:${args.datasetId}`);
    const { rows } = await tx.query<{ published_seq: number; record_count: number }>(
      `UPDATE datasets
          SET published_seq = GREATEST(
                published_seq,
                COALESCE((SELECT max(seq) FROM record_versions WHERE dataset_id = $1), 0)),
              record_count = (SELECT count(*) FROM records WHERE dataset_id = $1 AND removed_at IS NULL)
        WHERE id = $1
        RETURNING published_seq, record_count`,
      [args.datasetId],
    );
    const row = rows[0];
    if (!row) throw new Error(`publishWatermark: dataset ${args.datasetId} not found`);
    return { publishedSeq: row.published_seq, recordCount: row.record_count };
  });
}
