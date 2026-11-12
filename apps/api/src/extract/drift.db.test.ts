import { gzipSync } from 'node:zlib';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePublisherEvent, PUBLISHER_EVENTS_CHANNEL, type PublisherEvent } from '@spigot/shared';
import { extractChangedPage, publishRunDatasets } from '../datasets/extractRun.js';
import { createDb, type Db } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
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
import { admitChangedPage, backstopRunDrift, PROBE_PAGES, settleRunDrift } from './drift.js';

/**
 * SP-052a drift probe on SP-013 fixture pages (ticket §Scope, §Acceptance): the probe decides
 * once per (dataset, run) even with `onPageChanged` firing concurrently from two processes; a
 * broken layout writes 0 versions and alerts once; re-fired hooks (a resumed run) change
 * nothing; a run with < 20 changed pages decides at run end; the backstop catches what the
 * probe missed; a crash between "passed" and the held pages' extraction is finished at run end.
 */

/** What the self-check would have stored for LISTING_SPEC on healthy pages. */
const SAMPLE_STATS = {
  source: 'selfcheck',
  sampled: 20,
  fields: {
    price_usd: { nullRate: 0 },
    bedrooms: { nullRate: 0 },
    city: { nullRate: 0 },
    status: { nullRate: 0 },
  },
};

/** The "redesign": the offer moves out of JSON-LD, so the required price is gone. */
const brokenHtml = (l: Listing, nonce: string) =>
  listingHtml(l, nonce).replace('"offers"', '"offerz"');

describe.skipIf(!testDatabaseUrl)('SP-052a drift probe (Postgres, fixtures)', () => {
  let pools: TwoPools;
  let a: Db;
  let b: Db;
  let pool: pg.Pool;
  let t = Date.parse('2026-11-12T00:00:00Z');
  const nextFetch = () => new Date((t += 60_000));

  beforeAll(async () => {
    pools = await twoPools();
    pool = pools.a;
    a = createDb(pools.a);
    b = createDb(pools.b);
  });
  afterAll(async () => {
    await pools?.close();
  });

  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows[0] as T;

  async function seed(tag: string, n: number, opts: { baseline?: boolean } = {}) {
    const ds = await seedDataset(pool, tag);
    if (opts.baseline !== false) {
      await pool.query('UPDATE schema_versions SET sample_stats = $2 WHERE id = $1', [
        ds.schemaId,
        JSON.stringify(SAMPLE_STATS),
      ]);
    }
    const ls = listings(n);
    const ids = await upsertListingPages(pool, ds, ls);
    return { ds, ls, ids };
  }

  async function brokenSnapshots(ids: Map<string, string>, ls: readonly Listing[]) {
    const at = nextFetch();
    await pool.query(
      `INSERT INTO snapshots (page_id, fetched_at, http_status, html_gz)
       SELECT p, $2, 200, h FROM unnest($1::uuid[], $3::bytea[]) AS t(p, h)`,
      [
        ls.map((l) => ids.get(l.slug)!),
        at,
        ls.map((l) => gzipSync(brokenHtml(l, at.toISOString()))),
      ],
    );
  }

  /** Fire `onPageChanged` for every page, alternating the two "processes", all at once. */
  const admitAll = (ds: SeededDataset, runId: string, pageIds: string[]) =>
    Promise.all(
      pageIds.map((pageId, i) =>
        admitChangedPage(i % 2 ? b : a, { datasetId: ds.datasetId, pageId, runId }),
      ),
    );

  /** A healthy first crawl: every listing becomes a record. */
  async function goodRun(s: Awaited<ReturnType<typeof seed>>, ls = s.ls) {
    await insertSnapshots(pool, s.ids, ls, nextFetch());
    const runId = await newRun(pool, s.ds.siteId, 'MANUAL');
    await admitAll(
      s.ds,
      runId,
      ls.map((l) => s.ids.get(l.slug)!),
    );
    await settleRunDrift(a, runId);
    await publishRunDatasets(a, runId);
    return runId;
  }

  const check = (ds: SeededDataset, runId: string) =>
    one<{
      status: string;
      probe: { sampled: number; drift: boolean; final: boolean } | null;
      backstop: { drift: boolean } | null;
    }>('SELECT status, probe, backstop FROM drift_checks WHERE dataset_id = $1 AND run_id = $2', [
      ds.datasetId,
      runId,
    ]);
  const held = async (ds: SeededDataset, runId: string) =>
    (
      await one<{ n: number }>(
        'SELECT count(*)::int AS n FROM drift_pages WHERE dataset_id = $1 AND run_id = $2 AND held',
        [ds.datasetId, runId],
      )
    ).n;
  const dataset = (ds: SeededDataset) =>
    one<{ status: string; stale_since: Date | null }>(
      'SELECT status, stale_since FROM datasets WHERE id = $1',
      [ds.datasetId],
    );
  const alerts = async (ds: SeededDataset) =>
    (
      await pool.query<{
        data: {
          kind: string;
          phase: string;
          runId: string;
          partialBadVersionsRunId: string | null;
          reasons: string[];
        };
      }>(
        `SELECT data FROM audit_events WHERE action = 'ALERT' AND entity = 'datasets' AND entity_id = $1 ORDER BY id`,
        [ds.datasetId],
      )
    ).rows.map((r) => r.data);

  async function listen() {
    const client = await pool.connect();
    const events: PublisherEvent[] = [];
    client.on('notification', (n) => {
      const e = n.payload ? parsePublisherEvent(n.payload) : null;
      if (e) events.push(e);
    });
    await client.query(`LISTEN ${PUBLISHER_EVENTS_CHANNEL}`);
    return {
      events,
      async stop() {
        await client.query(`UNLISTEN ${PUBLISHER_EVENTS_CHANNEL}`);
        client.release();
      },
    };
  }

  it('40 pages changed concurrently in two processes: one decision on 20 pages, every page written once', async () => {
    const s = await seed('race-ok', 40);
    await insertSnapshots(pool, s.ids, s.ls, nextFetch());
    const runId = await newRun(pool, s.ds.siteId, 'MANUAL');

    const outcomes = await admitAll(s.ds, runId, [...s.ids.values()]);
    // Pages before the decision are held, the rest go straight through; none is left held.
    expect(new Set(outcomes)).toEqual(new Set(['HELD', 'EXTRACTED']));
    expect(outcomes.filter((o) => o === 'EXTRACTED').length).toBeGreaterThanOrEqual(
      40 - PROBE_PAGES + 1,
    );
    expect(await held(s.ds, runId)).toBe(0);
    expect(await check(s.ds, runId)).toMatchObject({
      status: 'PASSED',
      probe: { sampled: PROBE_PAGES, drift: false, final: false },
    });

    const v = await versions(pool, s.ds.datasetId, runId);
    expect(v).toHaveLength(40);
    expect(new Set(v.map((x) => x.record_key)).size).toBe(40);
    expect(v.every((x) => x.op === 'add')).toBe(true);

    // Run end and re-fired hooks (a resumed run): nothing new.
    await settleRunDrift(a, runId);
    await admitAll(s.ds, runId, [...s.ids.values()]);
    expect(await publishRunDatasets(b, runId)).toContain(s.ds.datasetId);
    expect(await versions(pool, s.ds.datasetId, runId)).toHaveLength(40);
    expect(await check(s.ds, runId)).toMatchObject({
      status: 'PASSED',
      backstop: { drift: false },
    });
    expect(await dataset(s.ds)).toMatchObject({ status: 'LIVE', stale_since: null });
    expect(await alerts(s.ds)).toEqual([]);
  });

  it('a broken layout changed concurrently in two processes: LIVE_STALE once, 0 versions, one alert and event; re-fires and later runs write nothing', async () => {
    const s = await seed('race-drift', 40);
    await goodRun(s);
    const before = await pool.query(
      'SELECT record_key, data FROM records WHERE dataset_id = $1 ORDER BY record_key',
      [s.ds.datasetId],
    );
    expect(before.rows).toHaveLength(40);

    const sub = await listen();
    try {
      await brokenSnapshots(s.ids, s.ls);
      const runId = await newRun(pool, s.ds.siteId, 'MANUAL');
      const outcomes = await admitAll(s.ds, runId, [...s.ids.values()]);
      expect(outcomes).not.toContain('EXTRACTED');
      expect(outcomes).toContain('DRIFTED');
      expect(await check(s.ds, runId)).toMatchObject({
        status: 'DRIFTED',
        probe: { sampled: PROBE_PAGES, drift: true },
      });
      const d = await dataset(s.ds);
      expect(d.status).toBe('LIVE_STALE');
      expect(d.stale_since).toBeInstanceOf(Date);

      // Run end, a resumed run re-firing everything, the backstop: still nothing written.
      await settleRunDrift(b, runId);
      await admitAll(s.ds, runId, [...s.ids.values()]);
      await publishRunDatasets(a, runId);
      await publishRunDatasets(b, runId);
      expect(await versions(pool, s.ds.datasetId, runId)).toEqual([]);

      // The next crawl (dataset already LIVE_STALE) writes nothing either.
      await brokenSnapshots(s.ids, s.ls);
      const run2 = await newRun(pool, s.ds.siteId, 'SCHEDULE');
      await Promise.all(
        [...s.ids.values()].map((p, i) => extractChangedPage(i % 2 ? b : a, p, run2)),
      );
      await publishRunDatasets(a, run2);
      expect(await versions(pool, s.ds.datasetId, run2)).toEqual([]);

      // Last good values kept; the stale mark is untouched by later runs.
      const after = await pool.query(
        'SELECT record_key, data FROM records WHERE dataset_id = $1 ORDER BY record_key',
        [s.ds.datasetId],
      );
      expect(after.rows).toEqual(before.rows);
      expect((await dataset(s.ds)).stale_since).toEqual(d.stale_since);

      const al = await alerts(s.ds);
      expect(al).toHaveLength(1);
      expect(al[0]).toMatchObject({
        kind: 'DATASET_DRIFT',
        phase: 'probe',
        runId,
        partialBadVersionsRunId: null,
      });
      expect(al[0]!.reasons).toEqual([
        'required field "price_usd" empty on 100% of pages (was 0%)',
      ]);

      await new Promise((r) => setTimeout(r, 50));
      const stale = sub.events.filter((e) => e.type === 'dataset.stale');
      expect(stale).toHaveLength(1);
      expect(stale[0]!.ids).toEqual([s.ds.datasetId, runId]);
    } finally {
      await sub.stop();
    }
  });

  it('fewer than 20 changed pages: held until run end, then probed on what there is and written', async () => {
    const s = await seed('small', 30);
    await goodRun(s);

    // 5 listings change price.
    const changed = s.ls.slice(0, 5).map((l) => ({ ...l, price: l.price + 100 }));
    await insertSnapshots(pool, s.ids, changed, nextFetch());
    const runId = await newRun(pool, s.ds.siteId, 'DEMO_MUTATE');
    const outcomes = await admitAll(
      s.ds,
      runId,
      changed.map((l) => s.ids.get(l.slug)!),
    );
    expect(outcomes).toEqual(Array(5).fill('HELD'));
    expect(await versions(pool, s.ds.datasetId, runId)).toEqual([]);

    await settleRunDrift(a, runId);
    expect(await check(s.ds, runId)).toMatchObject({
      status: 'PASSED',
      probe: { sampled: 5, final: true },
    });
    const v = await versions(pool, s.ds.datasetId, runId);
    expect(v.map((x) => x.op)).toEqual(Array(5).fill('update'));
    expect(await held(s.ds, runId)).toBe(0);

    // The same with 5 broken pages: drift, nothing written.
    const s2 = await seed('small-broken', 30);
    await goodRun(s2);
    await brokenSnapshots(s2.ids, s2.ls.slice(0, 5));
    const run2 = await newRun(pool, s2.ds.siteId, 'PING');
    await admitAll(
      s2.ds,
      run2,
      s2.ls.slice(0, 5).map((l) => s2.ids.get(l.slug)!),
    );
    await settleRunDrift(b, run2);
    expect(await check(s2.ds, run2)).toMatchObject({
      status: 'DRIFTED',
      probe: { sampled: 5, final: true },
    });
    expect(await versions(pool, s2.ds.datasetId, run2)).toEqual([]);
    expect((await dataset(s2.ds)).status).toBe('LIVE_STALE');
  });

  it('backstop: drift the probe missed → LIVE_STALE after the run; the alert names the run', async () => {
    const s = await seed('backstop', 50);
    await goodRun(s);

    // The first 20 changed pages are healthy (a price change), the next 30 broken.
    const good = s.ls.slice(0, 20).map((l) => ({ ...l, price: l.price + 5 }));
    const bad = s.ls.slice(20);
    await insertSnapshots(pool, s.ids, good, nextFetch());
    await brokenSnapshots(s.ids, bad);
    const runId = await newRun(pool, s.ds.siteId, 'MANUAL');
    for (const l of good)
      await admitChangedPage(a, { datasetId: s.ds.datasetId, pageId: s.ids.get(l.slug)!, runId });
    expect(await check(s.ds, runId)).toMatchObject({ status: 'PASSED' });
    await admitAll(
      s.ds,
      runId,
      bad.map((l) => s.ids.get(l.slug)!),
    );
    // Partial bad versions: the broken pages' records were removed (no price → no record).
    expect(
      (await versions(pool, s.ds.datasetId, runId)).filter((x) => x.op === 'remove'),
    ).toHaveLength(30);

    await settleRunDrift(a, runId);
    await publishRunDatasets(a, runId);
    expect(await check(s.ds, runId)).toMatchObject({
      status: 'DRIFTED',
      backstop: { drift: true },
    });
    expect((await dataset(s.ds)).status).toBe('LIVE_STALE');
    expect(await backstopRunDrift(b, runId)).toEqual([]);
    const al = await alerts(s.ds);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ phase: 'backstop', runId, partialBadVersionsRunId: runId });
  });

  it('a crash after "passed" but before the held pages were written: run end writes them, once', async () => {
    const s = await seed('crash', 25);
    await insertSnapshots(pool, s.ids, s.ls, nextFetch());
    const runId = await newRun(pool, s.ds.siteId, 'MANUAL');
    // State the crashed process left: decision recorded, pages still held, nothing extracted.
    await pool.query(
      `INSERT INTO drift_checks (dataset_id, run_id, status, decided_at) VALUES ($1, $2, 'PASSED', now())`,
      [s.ds.datasetId, runId],
    );
    await pool.query(
      `INSERT INTO drift_pages (dataset_id, run_id, page_id) SELECT $1, $2, unnest($3::uuid[])`,
      [s.ds.datasetId, runId, [...s.ids.values()]],
    );
    expect(await versions(pool, s.ds.datasetId, runId)).toEqual([]);
    await Promise.all([settleRunDrift(a, runId), settleRunDrift(b, runId)]);
    expect(await versions(pool, s.ds.datasetId, runId)).toHaveLength(25);
    expect(await held(s.ds, runId)).toBe(0);
    await settleRunDrift(a, runId);
    expect(await versions(pool, s.ds.datasetId, runId)).toHaveLength(25);
  });

  it('a dataset without baseline null rates is not gated (extracted at once, no drift rows)', async () => {
    const s = await seed('ungated', 3, { baseline: false });
    await insertSnapshots(pool, s.ids, s.ls, nextFetch());
    const runId = await newRun(pool, s.ds.siteId, 'MANUAL');
    for (const p of s.ids.values()) await extractChangedPage(a, p, runId);
    expect(await versions(pool, s.ds.datasetId, runId)).toHaveLength(3);
    expect(
      (
        await one<{ n: number }>(
          'SELECT count(*)::int AS n FROM drift_checks WHERE dataset_id = $1',
          [s.ds.datasetId],
        )
      ).n,
    ).toBe(0);
  });
});
