import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createDb, type Db } from '../db/index.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import {
  insertSnapshots,
  listingHtml,
  listings,
  newRun,
  seedDataset,
  upsertListingPages,
  versions,
  type Listing,
  type SeededDataset,
} from '../test/extract-fixtures.js';
import { extractPage } from './extractPage.js';
import { extractTemplate } from './extractTemplate.js';
import { upsertRecord } from './upsert.js';

const T0 = new Date('2026-11-12T06:00:00Z');
const T1 = new Date('2026-11-12T07:00:00Z');
const T2 = new Date('2026-11-12T08:00:00Z');

describe.skipIf(!testDatabaseUrl)(
  'extractPage / extractTemplate / publishWatermark',
  { timeout: 60_000 },
  () => {
    let pools: TwoPools;
    let db: Db;
    let ds: SeededDataset;
    let base: Listing[];
    let pageIds: Map<string, string>;

    const record = async (slug: string) =>
      (
        await pools.a.query<{
          data: Record<string, unknown>;
          version: number;
          updated_at: Date;
          crawled_at: Date;
          removed_at: Date | null;
        }>(
          'SELECT data, version, updated_at, crawled_at, removed_at FROM records WHERE dataset_id = $1 AND record_key = $2',
          [ds.datasetId, slug],
        )
      ).rows[0];
    const dataset = async () =>
      (
        await pools.a.query<{ published_seq: number; record_count: number }>(
          'SELECT published_seq, record_count FROM datasets WHERE id = $1',
          [ds.datasetId],
        )
      ).rows[0]!;
    const run = async (id: string) =>
      (
        await pools.a.query<{
          records_added: number;
          records_updated: number;
          records_removed: number;
          ai_calls: number;
        }>(
          'SELECT records_added, records_updated, records_removed, ai_calls FROM crawl_runs WHERE id = $1',
          [id],
        )
      ).rows[0]!;

    /** Base set at T0, extracted by an APPROVE run. */
    const approveBase = async (n = 120) => {
      base = listings(n);
      pageIds = await upsertListingPages(pools.a, ds, base);
      await insertSnapshots(pools.a, pageIds, base, T0);
      const approveRun = await newRun(pools.a, ds.siteId, 'APPROVE');
      const res = await extractTemplate(db, { datasetId: ds.datasetId, runId: approveRun });
      return { approveRun, res };
    };

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

    it('base extract: one add per record, versions published, counts on the run and dataset', async () => {
      const { approveRun, res } = await approveBase();
      expect(res).toMatchObject({
        added: 120,
        updated: 0,
        removed: 0,
        unchanged: 0,
        recordCount: 120,
      });

      const vs = await versions(pools.a, ds.datasetId);
      expect(vs).toHaveLength(120);
      expect(new Set(vs.map((v) => v.op))).toEqual(new Set(['add']));
      expect(vs.every((v) => v.crawl_run_id === approveRun && v.version === 1)).toBe(true);
      expect(vs[0]!.patch).toEqual([
        { op: 'add', path: '', value: (await record(vs[0]!.record_key))!.data },
      ]);

      expect(await dataset()).toEqual({ published_seq: vs.at(-1)!.seq, record_count: 120 });
      expect(await run(approveRun)).toEqual({
        records_added: 120,
        records_updated: 0,
        records_removed: 0,
        ai_calls: 0,
      });
      expect((await record(base[0]!.slug))!.data).toEqual({
        price_usd: base[0]!.price,
        bedrooms: base[0]!.beds,
        city: base[0]!.city,
        status: 'Available',
      });
    });

    it('base then mutated set (30 price + 5 leased + 3 new): exactly 35 update + 3 add, no others', async () => {
      await approveBase();
      const mutated = base.map((l) => ({ ...l }));
      for (const l of mutated.slice(0, 30)) l.price += 75;
      for (const l of mutated.slice(30, 35)) l.status = 'Leased';
      const extra = listings(3, 1000);
      const all = [...mutated, ...extra];
      const ids = await upsertListingPages(pools.a, ds, all);
      await insertSnapshots(pools.a, ids, all, T1); // every page re-crawled, new crawl-time bytes

      const crawlRun = await newRun(pools.a, ds.siteId, 'DEMO_MUTATE');
      const res = await extractTemplate(db, { datasetId: ds.datasetId, runId: crawlRun });
      expect(res).toMatchObject({
        added: 3,
        updated: 35,
        removed: 0,
        unchanged: 120 - 35,
        recordCount: 123,
      });

      const vs = await versions(pools.a, ds.datasetId, crawlRun);
      expect(vs.filter((v) => v.op === 'update')).toHaveLength(35);
      expect(
        vs
          .filter((v) => v.op === 'add')
          .map((v) => v.record_key)
          .sort(),
      ).toEqual(extra.map((l) => l.slug).sort());
      expect(vs).toHaveLength(38);

      // JSON Patch from the previous version.
      const price = vs.find((v) => v.record_key === mutated[0]!.slug)!;
      expect(price).toMatchObject({ op: 'update', version: 2 });
      expect(price.patch).toEqual([
        { op: 'replace', path: '/price_usd', value: mutated[0]!.price },
      ]);
      const leased = vs.find((v) => v.record_key === mutated[30]!.slug)!;
      expect(leased.patch).toEqual([{ op: 'replace', path: '/status', value: 'Leased' }]);

      expect(await run(crawlRun)).toEqual({
        records_added: 3,
        records_updated: 35,
        records_removed: 0,
        ai_calls: 0,
      });
      expect((await dataset()).published_seq).toBe(vs.at(-1)!.seq);
    });

    it('re-extract with no changes writes 0 versions (same snapshots, and a re-crawl with identical content)', async () => {
      await approveBase();
      const before = await versions(pools.a, ds.datasetId);

      const again = await newRun(pools.a, ds.siteId, 'MANUAL');
      expect(await extractTemplate(db, { datasetId: ds.datasetId, runId: again })).toMatchObject({
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 120,
      });

      await insertSnapshots(pools.a, pageIds, base, T1);
      const recrawl = await newRun(pools.a, ds.siteId, 'SCHEDULE');
      expect(await extractTemplate(db, { datasetId: ds.datasetId, runId: recrawl })).toMatchObject({
        unchanged: 120,
      });

      expect(await versions(pools.a, ds.datasetId)).toEqual(before);
      expect(await run(recrawl)).toEqual({
        records_added: 0,
        records_updated: 0,
        records_removed: 0,
        ai_calls: 0,
      });
    });

    it('same content, later crawl time: no version, crawled_at moves, updated_at does not', async () => {
      await approveBase(5);
      const slug = base[0]!.slug;
      const before = (await record(slug))!;
      expect(before.crawled_at).toEqual(T0);

      await insertSnapshots(
        pools.a,
        new Map([[slug, pageIds.get(slug)!]]),
        [base[0]!],
        T2,
        'other-nonce',
      );
      const crawlRun = await newRun(pools.a, ds.siteId, 'PING');
      expect(
        await extractPage(db, {
          pageId: pageIds.get(slug)!,
          datasetId: ds.datasetId,
          runId: crawlRun,
        }),
      ).toMatchObject({
        unchanged: 1,
        added: 0,
        updated: 0,
      });

      const after = (await record(slug))!;
      expect(after.crawled_at).toEqual(T2);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(after.version).toBe(1);
      expect(await versions(pools.a, ds.datasetId, crawlRun)).toEqual([]);
    });

    it('a page removed, or one the extractor returns null for, removes its record; it can come back', async () => {
      await approveBase(5);
      const [gone, nulled] = base;
      const crawlRun = await newRun(pools.a, ds.siteId, 'MANUAL');

      await pools.a.query('UPDATE pages SET removed_at = $2 WHERE id = $1', [
        pageIds.get(gone!.slug),
        T1,
      ]);
      await pools.a.query(
        `INSERT INTO snapshots (page_id, fetched_at, http_status, html_gz) VALUES ($1, $2, 200, $3)`,
        [
          pageIds.get(nulled!.slug),
          T1,
          gzipSync('<html><body>This listing is no longer available.</body></html>'),
        ],
      );
      const res = await extractTemplate(db, { datasetId: ds.datasetId, runId: crawlRun });
      expect(res).toMatchObject({ removed: 2, added: 0, updated: 0, recordCount: 3 });

      const vs = await versions(pools.a, ds.datasetId, crawlRun);
      expect(vs.map((v) => [v.record_key, v.op, v.version, v.patch]).sort()).toEqual(
        [
          [gone!.slug, 'remove', 2, [{ op: 'remove', path: '' }]],
          [nulled!.slug, 'remove', 2, [{ op: 'remove', path: '' }]],
        ].sort(),
      );
      expect((await record(gone!.slug))!.removed_at).not.toBeNull();
      expect(await run(crawlRun)).toMatchObject({ records_removed: 2 });

      // Removing again is a no-op.
      const again = await newRun(pools.a, ds.siteId, 'SCHEDULE');
      expect(await extractTemplate(db, { datasetId: ds.datasetId, runId: again })).toMatchObject({
        removed: 0,
      });

      // The page comes back with the same content: revived as an `add` of the whole record.
      await pools.a.query(
        `INSERT INTO snapshots (page_id, fetched_at, http_status, html_gz) VALUES ($1, $2, 200, $3)`,
        [pageIds.get(nulled!.slug), T2, gzipSync(listingHtml(nulled!))],
      );
      const back = await newRun(pools.a, ds.siteId, 'PING');
      expect(
        await extractPage(db, {
          pageId: pageIds.get(nulled!.slug)!,
          datasetId: ds.datasetId,
          runId: back,
        }),
      ).toMatchObject({
        added: 1,
      });
      const revived = (await versions(pools.a, ds.datasetId, back))[0]!;
      expect(revived).toMatchObject({ op: 'add', version: 3 });
      const rec = (await record(nulled!.slug))!;
      expect(rec.removed_at).toBeNull();
      expect(revived.patch).toEqual([{ op: 'add', path: '', value: rec.data }]);
    });

    it('skips every write while the dataset is LIVE_STALE', async () => {
      await approveBase(5);
      await pools.a.query(
        `UPDATE datasets SET status = 'LIVE_STALE', stale_since = now() WHERE id = $1`,
        [ds.datasetId],
      );
      const changed = { ...base[0]!, price: 9999 };
      await insertSnapshots(pools.a, pageIds, [changed], T1);

      const crawlRun = await newRun(pools.a, ds.siteId, 'MANUAL');
      const res = await extractPage(db, {
        pageId: pageIds.get(changed.slug)!,
        datasetId: ds.datasetId,
        runId: crawlRun,
      });
      expect(res).toMatchObject({ skipped: 'LIVE_STALE', updated: 0 });
      expect((await record(changed.slug))!.data.price_usd).toBe(base[0]!.price);
      expect((await record(changed.slug))!.crawled_at).toEqual(T0);
      expect(await versions(pools.a, ds.datasetId, crawlRun)).toEqual([]);
    });

    it('drops a write whose snapshot is older than the one the record already reflects', async () => {
      await approveBase(2);
      const slug = base[0]!.slug;
      const newer = { ...base[0]!, price: 2500 };
      await insertSnapshots(pools.a, pageIds, [newer], T2);
      const crawlRun = await newRun(pools.a, ds.siteId, 'MANUAL');
      await extractPage(db, {
        pageId: pageIds.get(slug)!,
        datasetId: ds.datasetId,
        runId: crawlRun,
      });

      // An overlapping run that loaded the T1-era content before the crawl stored T2's.
      const outcome = await db.tx((tx) =>
        upsertRecord(
          tx,
          { datasetId: ds.datasetId, runId: crawlRun },
          {
            recordKey: slug,
            pageId: pageIds.get(slug)!,
            data: { price_usd: 1 },
            hash: 'old',
            crawledAt: T1,
            sourceLastmod: null,
          },
        ),
      );
      expect(outcome).toBe('stale');
      expect((await record(slug))!.data.price_usd).toBe(2500);
    });
  },
);
