import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import { extractTemplate } from '../extract/extractTemplate.js';
import {
  insertSnapshots,
  listings,
  newRun,
  seedDataset,
  upsertListingPages,
  type SeededDataset,
} from '../test/extract-fixtures.js';
import { retireRemovedRecords } from './demoReset.js';

const T0 = new Date('2026-11-12T06:00:00Z');

// demo:reset's step 5: the reset crawl doesn't extract into the PROPOSED dataset, so the records
// of listings the demo site's reset deleted must be retired explicitly (W05: 2,341, not 2,344).
describe.skipIf(!testDatabaseUrl)('demo:reset retireRemovedRecords', { timeout: 60_000 }, () => {
  let pools: TwoPools;
  let db: Db;
  let ds: SeededDataset;

  const dataset = async () =>
    (
      await pools.a.query<{ record_count: number; status: string }>(
        'SELECT record_count, status FROM datasets WHERE id = $1',
        [ds.datasetId],
      )
    ).rows[0]!;

  beforeAll(async () => {
    pools = await twoPools();
    db = createDb(pools.a);
  });
  afterAll(async () => {
    await pools?.close();
  });
  beforeEach(async () => {
    await pools.a.query('TRUNCATE publishers CASCADE');
    ds = await seedDataset(pools.a);
  });

  it('removes the records of removed pages in a PROPOSED dataset and refreshes record_count', async () => {
    const base = listings(10);
    const pageIds = await upsertListingPages(pools.a, ds, base);
    await insertSnapshots(pools.a, pageIds, base, T0);
    await extractTemplate(
      { datasetId: ds.datasetId, runId: await newRun(pools.a, ds.siteId, 'APPROVE') },
      { db },
    );
    expect((await dataset()).record_count).toBe(10);

    // demo:reset: the dataset goes back to PROPOSED; the site reset deletes 3 listings and the
    // reset crawl marks their pages removed (without extracting).
    await pools.a.query(`UPDATE datasets SET status = 'PROPOSED' WHERE id = $1`, [ds.datasetId]);
    const gone = base.slice(0, 3).map((l) => pageIds.get(l.slug)!);
    await pools.a.query('UPDATE pages SET removed_at = now() WHERE id = ANY($1::uuid[])', [gone]);

    const run = await newRun(pools.a, ds.siteId, 'MANUAL');
    expect(await retireRemovedRecords(db, [ds.datasetId], run)).toBe(3);
    expect(await dataset()).toEqual({ record_count: 7, status: 'PROPOSED' });
    const { rows } = await pools.a.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM records
        WHERE dataset_id = $1 AND page_id = ANY($2::uuid[]) AND removed_at IS NOT NULL`,
      [ds.datasetId, gone],
    );
    expect(rows[0]!.n).toBe(3);

    // Idempotent: a second pass finds nothing left to retire.
    expect(await retireRemovedRecords(db, [ds.datasetId], run)).toBe(0);
    expect((await dataset()).record_count).toBe(7);
  });
});
