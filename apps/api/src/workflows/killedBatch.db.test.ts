import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CrawlDeps } from '../crawl/deps.js';
import { planBatches, type FetchBatchArgs } from '../crawl/fetchBatch.js';
import { clearCrawlHooks, onPageChanged } from '../crawl/hooks.js';
import { resetHostQueues } from '../crawl/queue.js';
import type { SafeResponse } from '../crawl/safeFetch.js';
import { extractChangedPage } from '../datasets/extractRun.js';
import { createDb, type Db } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import {
  listingHtml,
  listings,
  newRun,
  seedDataset,
  upsertListingPages,
  urlOf,
  type Listing,
  type SeededDataset,
} from '../test/extract-fixtures.js';
import { fanOutBatches, workflowTaskBodies } from './runtime.js';

/**
 * SP-041b acceptance: killing a `fetchBatch` run mid-way and letting Workflows retry it gives
 * no duplicate snapshots or record versions.
 *
 * The run's pages go through SP-041a's real fan-out (`fanOutBatches`, 2 shares) and task bodies.
 * "Render" retries a failed `fetchBatch` once (its registered policy). Share 0's first attempt is
 * killed while a request is in flight: its `signal` aborts (the process is gone) and the request
 * never answers. The page hook extracts changed pages into a LIVE dataset, as the workflow
 * service wires it (`wireWorkflowHooks`).
 */

const SECRET = 'workflows-test-secret-'.padEnd(40, 'x');
const PAGES = 40;
const KILL_AT_FETCH = 8;
const silentLog = { info() {}, warn() {}, error() {} } as never;

describe.skipIf(!testDatabaseUrl)(
  'a killed fetchBatch run, retried by Workflows (SP-041b)',
  { timeout: 60_000 },
  () => {
    let pools: TwoPools;
    let db: Db;
    let ds: SeededDataset;
    let ls: Listing[];
    let pageIds: string[];

    const byUrl = () => new Map(ls.map((l) => [urlOf(l), l]));

    /** The origin: each listing's page, same bytes on every fetch. */
    const answer = (url: string): SafeResponse => {
      const l = byUrl().get(url);
      if (!l) throw new Error(`unexpected fetch ${url}`);
      return {
        url,
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from(listingHtml(l)),
        redirects: [],
        address: '203.0.113.10',
      };
    };

    const baseDeps = (): CrawlDeps => ({
      db,
      crawlSecret: SECRET,
      allowLocal: false,
      appBaseUrl: 'http://spigot.test',
      minGapMs: 1,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      fetch: async (url) => answer(url),
    });

    const counts = async () =>
      (
        await pools.a.query<{
          snaps: number;
          dupSnaps: number;
          records: number;
          versions: number;
          dupVersions: number;
        }>(
          `SELECT
           (SELECT count(*)::int FROM snapshots s JOIN pages p ON p.id = s.page_id WHERE p.site_id = $1) AS snaps,
           (SELECT count(*)::int FROM (SELECT page_id FROM snapshots s JOIN pages p ON p.id = s.page_id
              WHERE p.site_id = $1 GROUP BY page_id HAVING count(*) > 1) d) AS "dupSnaps",
           (SELECT count(*)::int FROM records WHERE dataset_id = $2) AS records,
           (SELECT count(*)::int FROM record_versions WHERE dataset_id = $2) AS versions,
           (SELECT count(*)::int FROM (SELECT record_id FROM record_versions WHERE dataset_id = $2
              GROUP BY record_id HAVING count(*) > 1) d) AS "dupVersions"`,
          [ds.siteId, ds.datasetId],
        )
      ).rows[0]!;
    const runRow = async (runId: string) =>
      (
        await pools.a.query<{ pages_fetched: number; pages_failed: number }>(
          'SELECT pages_fetched, pages_failed FROM crawl_runs WHERE id = $1',
          [runId],
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
      resetHostQueues();
      clearCrawlHooks();
      // The workflow service's page hook (runtime.ts wireWorkflowHooks).
      onPageChanged((pageId, runId) => extractChangedPage(db, pageId, runId).then(() => {}));
      ds = await seedDataset(pools.a);
      ls = listings(PAGES);
      const ids = await upsertListingPages(pools.a, ds, ls);
      pageIds = ls.map((l) => ids.get(l.slug)!);
    });
    afterEach(() => clearCrawlHooks());

    it('kill mid-request → retry: every page once, one snapshot and one version each, nothing lost', async () => {
      const runId = await newRun(pools.a, ds.siteId, 'MANUAL');
      const bodies = workflowTaskBodies({ db, crawlDeps: baseDeps(), log: silentLog });

      // The attempt that dies: on its KILL_AT_FETCH-th request the process goes away.
      const kill = new AbortController();
      let killedFetches = 0;
      let releaseZombie!: () => void;
      const zombieHeld = new Promise<void>((r) => (releaseZombie = r));
      const doomed = workflowTaskBodies({
        db,
        crawlDeps: {
          ...baseDeps(),
          signal: kill.signal,
          fetch: async (url) => {
            killedFetches += 1;
            if (killedFetches === KILL_AT_FETCH) {
              kill.abort();
              await zombieHeld; // never answers while the run is "dead"
            }
            return answer(url);
          },
        },
        log: silentLog,
      });
      const died = new Promise<void>((r) => kill.signal.addEventListener('abort', () => r()));

      const attempts: { share: number; attempt: number }[] = [];
      let zombie: Promise<unknown> | undefined;
      const shares = planBatches(pageIds);
      /** Render: run the task; on failure retry once (fetchBatch's maxRetries: 1). */
      const runFetchBatch = async (batch: FetchBatchArgs) => {
        const share = shares.findIndex((s) => s[0] === batch.pageIds[0]);
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          attempts.push({ share, attempt });
          if (share === 0 && attempt === 1) {
            zombie = doomed.fetchBatch(batch);
            await died;
            continue; // Render sees the run fail and starts the retry on fresh compute
          }
          return bodies.fetchBatch(batch);
        }
        throw new Error('unreachable');
      };

      const results = await fanOutBatches(
        { db, log: silentLog },
        { runFetchBatch },
        runId,
        pageIds,
      );

      expect(attempts).toEqual(
        expect.arrayContaining([
          { share: 0, attempt: 1 },
          { share: 0, attempt: 2 },
          { share: 1, attempt: 1 },
        ]),
      );
      expect(attempts).toHaveLength(3);
      // The retry skipped what the dead attempt had finished, and fetched the rest.
      const finishedBeforeKill = KILL_AT_FETCH - 1;
      const retry = results[0]!;
      expect(retry.alreadyDone).toBe(finishedBeforeKill);
      expect(retry.attempted).toBe(shares[0]!.length - finishedBeforeKill);

      expect(await counts()).toEqual({
        snaps: PAGES,
        dupSnaps: 0,
        records: PAGES,
        versions: PAGES,
        dupVersions: 0,
      });
      expect(await runRow(runId)).toMatchObject({ pages_fetched: PAGES, pages_failed: 0 });

      // The dead attempt's request answers after all (a slow zombie). Same bytes → same snapshot
      // hash and no new version: still nothing duplicated.
      releaseZombie();
      await zombie;
      expect(await counts()).toEqual({
        snaps: PAGES,
        dupSnaps: 0,
        records: PAGES,
        versions: PAGES,
        dupVersions: 0,
      });
    });

    it('a retried batch whose first attempt finished every page refetches nothing', async () => {
      const runId = await newRun(pools.a, ds.siteId, 'MANUAL');
      const bodies = workflowTaskBodies({ db, crawlDeps: baseDeps(), log: silentLog });
      const [share] = planBatches(pageIds);
      // Attempt 1 completes, then the run is killed before Render records the result; Render retries.
      await bodies.fetchBatch({ runId, pageIds: share! });
      const before = await counts();
      const again = await bodies.fetchBatch({ runId, pageIds: share! });
      expect(again).toEqual({ attempted: 0, alreadyDone: share!.length, stopped: false });
      expect(await counts()).toEqual(before);
      expect(before).toMatchObject({ dupSnaps: 0, dupVersions: 0, versions: share!.length });
    });
  },
);
