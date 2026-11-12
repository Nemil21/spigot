import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl, twoPools, type TwoPools } from '../apps/api/src/db/test-db.js';
import { seedDataset, type SeededDataset } from '../apps/api/src/test/extract-fixtures.js';
import { formatReport, modeOf, workflowsReport } from './workflows-report.lib.js';

describe('modeOf', () => {
  it('reads the run mode from workflow_run_id', () => {
    expect(modeOf('inproc:abc')).toBe('inproc');
    expect(modeOf('trn-123')).toBe('workflows');
    expect(modeOf(null)).toBe('unknown');
  });
});

describe.skipIf(!testDatabaseUrl)('workflows-report (SP-041b)', () => {
  let pools: TwoPools;
  let ds: SeededDataset;

  beforeAll(async () => {
    pools = await twoPools();
  });
  afterAll(async () => {
    await pools?.close();
  });
  beforeEach(async () => {
    await pools.a.query('TRUNCATE publishers, payout_batches CASCADE');
    ds = await seedDataset(pools.a);
  });

  /** A finished run `seconds` long that started `afterConnect` seconds after the site was made. */
  async function run(
    trigger: string,
    workflowRunId: string,
    afterConnect: number,
    seconds: number,
  ) {
    await pools.a.query(
      `INSERT INTO crawl_runs (site_id, trigger, status, workflow_run_id, pages_total, pages_fetched,
                               started_at, finished_at)
       SELECT id, $2, 'SUCCEEDED', $3, 10, 10,
              created_at + make_interval(secs => $4), created_at + make_interval(secs => $4 + $5)
         FROM sites WHERE id = $1`,
      [ds.siteId, trigger, workflowRunId, afterConnect, seconds],
    );
  }

  it('reports both modes, the connect → discovery time and duplicate checks', async () => {
    await run('CONNECT', 'inproc:r1', 5, 100);
    await run('MANUAL', 'trn-abc', 300, 80);
    const pages = await pools.a.query<{ id: string }>(
      `INSERT INTO pages (site_id, url) VALUES ($1, 'https://x.test/a'), ($1, 'https://x.test/b') RETURNING id`,
      [ds.siteId],
    );
    const [a, b] = pages.rows.map((r) => r.id);
    // Page a: two different snapshots (normal history). Page b: the same hash twice (a duplicate).
    await pools.a.query(
      `INSERT INTO snapshots (page_id, content_hash) VALUES ($1, 'h1'), ($1, 'h2'), ($2, 'h3'), ($2, 'h3')`,
      [a, b],
    );

    const report = (await workflowsReport(pools.a, ds.siteId))!;
    expect(report.connectToDiscoverySeconds).toBe(105);
    expect(report.runs.map((r) => [r.trigger, r.mode, r.seconds])).toEqual([
      ['MANUAL', 'workflows', 80],
      ['CONNECT', 'inproc', 100],
    ]);
    expect(report).toMatchObject({ pages: 2, snapshots: 4, pagesWithDuplicateSnapshots: 1 });
    expect(report.datasets).toEqual([
      expect.objectContaining({
        id: ds.datasetId,
        records: 0,
        versions: 0,
        recordsWithDuplicateVersions: 0,
      }),
    ]);

    // By origin too; the text form flags the 4-minute criterion.
    const byOrigin = (await workflowsReport(pools.a, report.site.origin))!;
    expect(byOrigin.site.id).toBe(ds.siteId);
    expect(formatReport(report)).toContain('connect → discovery crawl: 105 s (< 4 min: pass)');
    expect(await workflowsReport(pools.a, 'https://nope.test')).toBeNull();
  });
});
