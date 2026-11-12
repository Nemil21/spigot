import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { twoPools, testDatabaseUrl, type TwoPools } from '../db/test-db.js';
import {
  insertSnapshots,
  listings,
  newRun,
  seedDataset,
  startFeedReader,
  upsertListingPages,
  type Listing,
  type SeededDataset,
} from '../test/extract-fixtures.js';
import { extractPage, extractPages } from './extractPage.js';
import { extractTemplate } from './extractTemplate.js';
import { publishWatermark } from './publishWatermark.js';

const T0 = new Date('2026-11-12T06:00:00Z');
const T1 = new Date('2026-11-12T07:00:00Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise you resolve from outside. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

describe.skipIf(!testDatabaseUrl)('changes-feed watermark under concurrent writers', () => {
  let pools: TwoPools;
  let dbA: Db;
  let dbB: Db;
  let ds: SeededDataset;

  const allSeqs = async () =>
    (
      await pools.a.query<{ seq: number }>(
        'SELECT seq FROM record_versions WHERE dataset_id = $1 ORDER BY seq',
        [ds.datasetId],
      )
    ).rows.map((r) => r.seq);
  const publishedSeq = async () =>
    (
      await pools.a.query<{ p: number }>('SELECT published_seq AS p FROM datasets WHERE id = $1', [
        ds.datasetId,
      ])
    ).rows[0]!.p;

  /** Pages + T0 snapshots for `n` listings; ids in listing order. */
  const seedPages = async (n: number) => {
    const ls = listings(n);
    const ids = await upsertListingPages(pools.a, ds, ls);
    await insertSnapshots(pools.a, ids, ls, T0);
    return { ls, ids, ordered: ls.map((l) => ids.get(l.slug)!) };
  };

  beforeAll(async () => {
    pools = await twoPools();
    dbA = createDb(pools.a);
    dbB = createDb(pools.b);
  });
  afterAll(async () => {
    await pools?.close();
  });
  beforeEach(async () => {
    await pools.a.query('TRUNCATE publishers CASCADE');
    ds = await seedDataset(pools.a);
  });

  it('2 parallel batches + a polling reader: publish waits for the slower batch, no seq is skipped', async () => {
    const { ordered } = await seedPages(80);
    const runId = await newRun(pools.a, ds.siteId, 'MANUAL');
    const reader = startFeedReader(pools.a, ds.datasetId);

    // Batch A writes first (lower seqs) and stalls before COMMIT.
    const aWritten = gate();
    const releaseA = gate();
    let aCommitted = false;
    const batchA = extractPages(
      dbA,
      { datasetId: ds.datasetId, runId, pageIds: ordered.slice(0, 40) },
      {
        beforeCommit: async () => {
          aWritten.open();
          await releaseA.opened;
        },
      },
    ).then((r) => ((aCommitted = true), r));
    await aWritten.opened;

    // Batch B writes higher seqs and commits, then publishes. The publish must wait for A.
    const resB = await extractPages(dbB, {
      datasetId: ds.datasetId,
      runId,
      pageIds: ordered.slice(40),
    });
    expect(resB.added).toBe(40);
    let published = false;
    const publish = publishWatermark(dbB, { datasetId: ds.datasetId }).then(
      (r) => ((published = true), r),
    );
    await sleep(300);
    expect(published).toBe(false);
    expect(await publishedSeq()).toBe(0);
    expect(reader.seen).toEqual([]);

    releaseA.open();
    expect((await batchA).added).toBe(40);
    const { publishedSeq: p } = await publish;
    expect(aCommitted).toBe(true);

    const seen = await reader.stop();
    const all = await allSeqs();
    expect(all).toHaveLength(80);
    expect(p).toBe(all.at(-1));
    expect(seen).toEqual(all); // in order, nothing skipped, nothing twice
  });

  it('control: a watermark published without the exclusive lock would skip the slow batch', async () => {
    const { ordered } = await seedPages(20);
    const runId = await newRun(pools.a, ds.siteId, 'MANUAL');
    const reader = startFeedReader(pools.a, ds.datasetId);
    const aWritten = gate();
    const releaseA = gate();
    const batchA = extractPages(
      dbA,
      { datasetId: ds.datasetId, runId, pageIds: ordered.slice(0, 10) },
      { beforeCommit: async () => (aWritten.open(), releaseA.opened) },
    );
    await aWritten.opened;
    await extractPages(dbB, { datasetId: ds.datasetId, runId, pageIds: ordered.slice(10) });
    // Naive publish: max(seq) with no lock, while A's lower seqs are still uncommitted.
    await pools.b.query(
      `UPDATE datasets SET published_seq = (SELECT max(seq) FROM record_versions WHERE dataset_id = $1) WHERE id = $1`,
      [ds.datasetId],
    );
    await sleep(100); // let the reader advance past A's seqs
    releaseA.open();
    await batchA;
    await publishWatermark(dbB, { datasetId: ds.datasetId });

    const seen = await reader.stop();
    expect(seen.length).toBeLessThan((await allSeqs()).length); // the race the locks prevent is real
  });

  it('stress: 8 overlapping batches, each followed by a publish, + a reader: seen seqs are contiguous', async () => {
    const { ordered } = await seedPages(200);
    const runId = await newRun(pools.a, ds.siteId, 'MANUAL');
    const reader = startFeedReader(pools.a, ds.datasetId);
    const watermarks: number[] = [];

    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const db = i % 2 ? dbB : dbA;
        await sleep(i * 3);
        await extractPages(
          db,
          { datasetId: ds.datasetId, runId, pageIds: ordered.slice(i * 25, i * 25 + 25) },
          { beforeCommit: () => sleep(Math.floor(Math.random() * 40)) },
        );
        watermarks.push((await publishWatermark(db, { datasetId: ds.datasetId })).publishedSeq);
      }),
    );

    const seen = await reader.stop();
    const all = await allSeqs();
    expect(all).toHaveLength(200);
    expect(seen).toEqual(all);
    expect(watermarks.at(-1)).toBe(all.at(-1));
    expect([...watermarks].sort((a, b) => a - b)).toEqual(watermarks); // never moves backwards
  });

  it('overlap: an APPROVE extractTemplate and a crawl run on the same dataset + a reader', async () => {
    const { ls, ids } = await seedPages(300);
    const approveRun = await newRun(pools.a, ds.siteId, 'APPROVE');
    const crawlRun = await newRun(pools.b, ds.siteId, 'MANUAL');
    const reader = startFeedReader(pools.a, ds.datasetId);

    // The crawl re-fetches 60 pages; 40 of them changed price since T0.
    const recrawled: Listing[] = ls
      .filter((_, i) => i % 5 === 0)
      .map((l, i) => (i < 40 ? { ...l, price: l.price + 10 } : l));
    const watermarks: number[] = [];

    const approve = extractTemplate(
      dbA,
      { datasetId: ds.datasetId, runId: approveRun },
      { batchSize: 50 },
    ).then((r) => {
      watermarks.push(r.publishedSeq);
      return r;
    });
    const crawl = (async () => {
      for (const [i, l] of recrawled.entries()) {
        await insertSnapshots(pools.b, ids, [l], T1);
        await extractPage(dbB, {
          pageId: ids.get(l.slug)!,
          datasetId: ds.datasetId,
          runId: crawlRun,
        });
        if (i % 10 === 9)
          watermarks.push((await publishWatermark(dbB, { datasetId: ds.datasetId })).publishedSeq);
      }
      watermarks.push((await publishWatermark(dbB, { datasetId: ds.datasetId })).publishedSeq);
    })();
    await Promise.all([approve, crawl]);
    const final = await publishWatermark(dbA, { datasetId: ds.datasetId });

    const seen = await reader.stop();
    const all = await allSeqs();
    expect(seen).toEqual(all);
    expect(final.publishedSeq).toBe(all.at(-1));
    expect(final.recordCount).toBe(300);

    // Every version carries a run; each record's versions are 1..n in seq order.
    const vs = (
      await pools.a.query<{
        record_id: string;
        version: number;
        crawl_run_id: string | null;
        op: string;
      }>(
        'SELECT record_id, version, crawl_run_id, op FROM record_versions WHERE dataset_id = $1 ORDER BY seq',
        [ds.datasetId],
      )
    ).rows;
    expect(vs.every((v) => v.crawl_run_id === approveRun || v.crawl_run_id === crawlRun)).toBe(
      true,
    );
    const lastVersion = new Map<string, number>();
    for (const v of vs) {
      expect(v.version).toBe((lastVersion.get(v.record_id) ?? 0) + 1);
      lastVersion.set(v.record_id, v.version);
    }
    expect(vs.filter((v) => v.op === 'add')).toHaveLength(300);
    // A changed page the crawl reached before the APPROVE batch did is born with its new price
    // (one add); otherwise it's an add then one update. Never more, never an unchanged page.
    const changedIds = new Set(
      (
        await pools.a.query<{ id: string }>(
          'SELECT id FROM records WHERE dataset_id = $1 AND record_key = ANY($2::text[])',
          [ds.datasetId, recrawled.slice(0, 40).map((l) => l.slug)],
        )
      ).rows.map((r) => r.id),
    );
    const updates = vs.filter((v) => v.op === 'update');
    expect(updates.every((v) => changedIds.has(v.record_id))).toBe(true);
    expect(new Set(updates.map((v) => v.record_id)).size).toBe(updates.length);

    // No overlap reverted a record to older content.
    const prices = new Map(
      (
        await pools.a.query<{ record_key: string; price: number }>(
          `SELECT record_key, (data->>'price_usd')::int AS price FROM records WHERE dataset_id = $1`,
          [ds.datasetId],
        )
      ).rows.map((r) => [r.record_key, r.price]),
    );
    const expected = new Map(ls.map((l) => [l.slug, l.price]));
    for (const l of recrawled) expected.set(l.slug, l.price);
    expect(prices).toEqual(expected);
  });
});
