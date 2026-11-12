import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { ApiError } from '../http/errors.js';
import { CHANGES_RETENTION_DAYS, readChanges } from './changes.js';
import { encodeChangesCursor } from './cursor.js';
import { fieldExpr, filterSql, parseQueryFilters, parseSort } from './filters.js';
import {
  countRecords,
  getRecord,
  loadServedDataset,
  queryRecords,
  type ServedDataset,
} from './query.js';

/** The demo Listing schema: `agent_phone` is extracted (in `records.data`) but hidden. */
const LISTING_FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  {
    name: 'price_usd',
    type: 'integer',
    visible: true,
    filterable: ['eq', 'lt', 'lte', 'gt', 'gte'],
  },
  { name: 'bedrooms', type: 'integer', visible: true, filterable: ['eq', 'gte', 'lte'] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq', 'in'] },
  { name: 'pets', type: 'boolean', visible: true, filterable: ['eq'] },
  { name: 'available_from', type: 'date', visible: true, filterable: ['gte', 'lt'] },
  { name: 'agent_phone', type: 'string', visible: false, pii: true, filterable: ['eq'] },
];
const SECRET = '512-555-';

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return `${e.status} ${e.code}`;
    throw e; // a pg error here (e.g. a SQL syntax error from injection) fails the test
  }
  return 'resolved';
}

describe.skipIf(!testDatabaseUrl)('records query + changes reader', { timeout: 120_000 }, () => {
  let pools: TwoPools;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pools.a.query(sql, params)).rows as T[];

  beforeAll(async () => {
    pools = await twoPools();
  });
  afterAll(async () => {
    await pools?.close();
  });

  /** A site with one LIVE dataset whose active schema is LISTING_FIELDS, and `n` records. */
  async function dataset(n: number, opts: { slug?: string } = {}): Promise<ServedDataset> {
    const tag = randomUUID().slice(0, 8);
    const [pub] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ($1, $2, $2) RETURNING id`,
      [`Pub ${tag}`, `pub-${tag}@example.com`],
    );
    const [site] = await q<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
       VALUES ($1, $2, 'v', 'c', 'g') RETURNING id`,
      [pub!.id, `https://${tag}.example.com`],
    );
    const [ds] = await q<{ id: string }>(
      `INSERT INTO datasets (site_id, slug, type_name, status) VALUES ($1, $2, 'Listing', 'LIVE') RETURNING id`,
      [site!.id, opts.slug ?? 'listings'],
    );
    const [sv] = await q<{ id: string }>(
      `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
      [ds!.id, JSON.stringify(LISTING_FIELDS)],
    );
    await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
    if (n > 0) {
      await q(
        `INSERT INTO pages (site_id, url) SELECT $1, $2 || '/listings/l-' || i FROM generate_series(1, $3) i`,
        [site!.id, `https://${tag}.example.com`, n],
      );
      // Groups of 7 records share an updated_at that differs from the next group by 1µs, so the
      // keyset has to break ties on id and keep microsecond precision.
      await q(
        `INSERT INTO records (dataset_id, record_key, page_id, data, hash, version, crawled_at, updated_at)
         SELECT $1, 'l-' || i, p.id,
                jsonb_build_object(
                  'title', 'Listing ' || i,
                  'price_usd', 1000 + (i * 37) % 2000,
                  'bedrooms', i % 5,
                  'city', (ARRAY['Austin','Dallas','Waco'])[i % 3 + 1],
                  'pets', i % 2 = 0,
                  'available_from', to_char(date '2026-11-01' + (i % 30), 'YYYY-MM-DD'),
                  'agent_phone', '${SECRET}' || lpad(i::text, 4, '0')),
                md5(i::text), 1, now(),
                timestamptz '2026-11-11T00:00:00Z' + (i / 7) * interval '1 microsecond'
           FROM generate_series(1, $2) i
           JOIN pages p ON p.site_id = $3 AND p.url = $4 || '/listings/l-' || i`,
        [ds!.id, n, site!.id, `https://${tag}.example.com`],
      );
    }
    return (await loadServedDataset(pools.a, ds!.id))!;
  }

  describe('queryRecords', () => {
    let big: ServedDataset;
    beforeAll(async () => {
      big = await dataset(2341);
    });

    test.each([
      ['desc', 100],
      ['asc', 100],
      ['desc', 7],
      ['asc', 13],
    ] as const)(
      'keyset pagination over 2,341 records (%s, limit %i) returns each exactly once, in order',
      async (sort, limit) => {
        const keys: string[] = [];
        const stamps: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await queryRecords(pools.a, big, { sort, limit, cursor });
          keys.push(...page.records.map((r) => r.key));
          stamps.push(...page.records.map((r) => r.data.updated_at as string));
          cursor = page.next;
          pages++;
          expect(pages).toBeLessThan(2341);
        } while (cursor);
        expect(keys).toHaveLength(2341);
        expect(new Set(keys).size).toBe(2341);
        const sorted = [...stamps].sort();
        expect(stamps).toEqual(sort === 'asc' ? sorted : sorted.reverse());
      },
    );

    test('filters: bedrooms[gte]=3&price_usd[lt]=2000&city=Austin matches a hand count; count is capped', async () => {
      const filters = parseQueryFilters(
        { 'bedrooms[gte]': '3', 'price_usd[lt]': '2000', city: 'Austin' },
        big.fields,
      );
      let expected = 0;
      for (let i = 1; i <= 2341; i++) {
        if (i % 5 >= 3 && 1000 + ((i * 37) % 2000) < 2000 && i % 3 === 0) expected++;
      }
      expect(expected).toBeGreaterThan(50);
      const all: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await queryRecords(pools.a, big, { filters, limit: 50, cursor });
        for (const r of page.records) {
          expect(r.data.bedrooms as number).toBeGreaterThanOrEqual(3);
          expect(r.data.price_usd as number).toBeLessThan(2000);
          expect(r.data.city).toBe('Austin');
        }
        all.push(...page.records.map((r) => r.key));
        cursor = page.next;
      } while (cursor);
      expect(all).toHaveLength(expected);
      expect(await countRecords(pools.a, big, filters, 1000)).toBe(expected);
      expect(await countRecords(pools.a, big, filters, 37)).toBe(37);
    });

    test('in, boolean, date and updated_at filters', async () => {
      const count = (query: Record<string, unknown>) =>
        countRecords(pools.a, big, parseQueryFilters(query, big.fields), 1000);
      expect(await count({ 'city[in]': 'Waco,Dallas' })).toBe(1000); // capped
      expect(await count({ 'city[in]': 'Nowhere' })).toBe(0);
      expect(await count({ pets: 'true', 'bedrooms[eq]': '0' })).toBe(
        Array.from({ length: 2341 }, (_, k) => k + 1).filter((i) => i % 2 === 0 && i % 5 === 0)
          .length,
      );
      expect(await count({ 'available_from[lt]': '2026-11-02' })).toBe(
        Array.from({ length: 2341 }, (_, k) => k + 1).filter((i) => i % 30 === 0).length,
      );
      // Records 7·100 … are at +100µs and later.
      expect(await count({ 'updated_at[gte]': '2026-11-11T00:00:00.001Z' })).toBe(
        Array.from({ length: 2341 }, (_, k) => k + 1).filter((i) => Math.floor(i / 7) >= 1000)
          .length,
      );
    });

    test('injection strings → 400 (parse) and quoted values stay data', async () => {
      const run = async (query: Record<string, unknown>, sort?: unknown) =>
        queryRecords(pools.a, big, {
          filters: parseQueryFilters(query, big.fields),
          sort: parseSort(sort),
          limit: 10,
        });
      expect(await rejects(run({ 'price_usd[lt]': '1;DROP TABLE records' }))).toBe(
        '400 VALIDATION_ERROR',
      );
      expect(await rejects(run({ "data->>'x' OR 1=1": '1' }))).toBe('400 UNSUPPORTED_FILTER');
      expect(await rejects(run({}, 'agent_phone'))).toBe('400 VALIDATION_ERROR');
      expect(await rejects(run({}, 'price_usd;--'))).toBe('400 VALIDATION_ERROR');
      expect(await rejects(run({ agent_phone: `${SECRET}0001` }))).toBe('400 UNSUPPORTED_FILTER');
      // A string value full of SQL is just a city name nobody has.
      const page = await run({ city: "Austin' OR '1'='1'; DROP TABLE records; --" });
      expect(page.records).toEqual([]);
      const [{ n }] = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM records WHERE dataset_id = $1`,
        [big.id],
      );
      expect(n).toBe(2341);
      // A tampered cursor is a 400 too.
      expect(
        await rejects(
          queryRecords(pools.a, big, { limit: 10, cursor: "'; DROP TABLE records; --" }),
        ),
      ).toBe('400 VALIDATION_ERROR');
    });

    test('a records cursor from another dataset → 400', async () => {
      const other = await dataset(3);
      const page = await queryRecords(pools.a, big, { limit: 5 });
      expect(await rejects(queryRecords(pools.a, other, { limit: 5, cursor: page.next }))).toBe(
        '400 VALIDATION_ERROR',
      );
    });

    test('the hidden field never appears in records or getRecord; removed records are not served', async () => {
      const page = await queryRecords(pools.a, big, { limit: 1000 });
      const text = JSON.stringify(page);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('agent_phone');
      expect(Object.keys(page.records[0]!.data).sort()).toEqual(
        [
          'available_from',
          'bedrooms',
          'city',
          'pets',
          'price_usd',
          'title',
          'updated_at',
          'url',
        ].sort(),
      );
      expect(page.records[0]!.key).toMatch(/^listings\/l-\d+$/);

      const one = await getRecord(pools.a, big, 'listings/l-42');
      expect(one?.record.data.title).toBe('Listing 42');
      expect(one?.record.data.url).toMatch(/\/listings\/l-42$/);
      expect(JSON.stringify(one)).not.toContain(SECRET);
      expect((await getRecord(pools.a, big, 'l-42'))?.record.key).toBe('listings/l-42');
      expect(await getRecord(pools.a, big, 'listings/nope')).toBeNull();

      const gone = await dataset(2);
      await q(
        `UPDATE records SET removed_at = now() WHERE dataset_id = $1 AND record_key = 'l-1'`,
        [gone.id],
      );
      expect(await getRecord(pools.a, gone, 'listings/l-1')).toBeNull();
      expect((await queryRecords(pools.a, gone, { limit: 10 })).records.map((r) => r.key)).toEqual([
        'listings/l-2',
      ]);
    });

    test('limit outside 1..1000 → 400', async () => {
      for (const limit of [0, -1, 1001, 2.5]) {
        expect(await rejects(queryRecords(pools.a, big, { limit }))).toBe('400 VALIDATION_ERROR');
      }
    });

    test('fieldExpr is index-legal for every filterable type (SP-014a builds indexes with it)', async () => {
      for (const f of big.fields.filter((x) => x.filterable.length > 0)) {
        const name = `records_test_${f.name}_${randomUUID().slice(0, 6)}`;
        await q(`CREATE INDEX ${name} ON records ((${fieldExpr(f.name, f.type)}))`);
        await q(`DROP INDEX ${name}`);
      }
    });

    test('values that do not match the schema type never raise: same dataset, other dataset, index build', async () => {
      // Another dataset stores the same field names with other types ("$1,200", "yes").
      const other = await dataset(3);
      await q(
        `UPDATE records SET data = data || '{"price_usd": "$1,200", "pets": "yes", "bedrooms": null}'
          WHERE dataset_id = $1`,
        [other.id],
      );
      // And in this dataset, one row from an "older schema" with a string price and boolean.
      const mixed = await dataset(5);
      await q(
        `UPDATE records SET data = data || '{"price_usd": "1,200", "pets": "maybe"}'
          WHERE dataset_id = $1 AND record_key = 'l-1'`,
        [mixed.id],
      );

      // Indexes over the whole table still build, and later mismatched upserts still succeed.
      const names: string[] = [];
      for (const f of mixed.fields.filter((x) => x.filterable.length > 0)) {
        const name = `records_test_${f.name}_${randomUUID().slice(0, 6)}`;
        await q(`CREATE INDEX ${name} ON records ((${fieldExpr(f.name, f.type)}))`);
        names.push(name);
      }
      try {
        await q(
          `UPDATE records SET data = data || '{"price_usd": "n/a", "pets": 1}'
            WHERE dataset_id = $1 AND record_key = 'l-2'`,
          [other.id],
        );

        const keys = async (query: Record<string, unknown>) =>
          (
            await queryRecords(pools.a, mixed, {
              filters: parseQueryFilters(query, mixed.fields),
              limit: 100,
            })
          ).records
            .map((r) => r.key)
            .sort();
        // The bad row just doesn't match; the others do (prices 1037..1185 < 5000).
        expect(await keys({ 'price_usd[lt]': '5000' })).toEqual(
          ['listings/l-2', 'listings/l-3', 'listings/l-4', 'listings/l-5'].sort(),
        );
        expect(await keys({ pets: 'true' })).toEqual(['listings/l-2', 'listings/l-4']);
        expect(await keys({ pets: 'false' })).toEqual(['listings/l-3', 'listings/l-5']);
        expect(
          await countRecords(
            pools.a,
            other,
            parseQueryFilters({ 'price_usd[gte]': '0' }, other.fields),
            100,
          ),
        ).toBe(0);
        // The bad value is still served as stored (it's a visible field), just not filterable.
        expect((await getRecord(pools.a, mixed, 'listings/l-1'))?.record.data.price_usd).toBe(
          '1,200',
        );

        // The planner uses an index built from exactly `fieldExpr`.
        const client = await pools.a.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL enable_seqscan = off');
          await client.query('SET LOCAL enable_bitmapscan = on');
          const params: unknown[] = [];
          const where = filterSql(
            parseQueryFilters({ 'price_usd[lt]': '1500' }, mixed.fields),
            mixed.fields,
            params,
          );
          const plan = await client.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN SELECT id FROM records WHERE ${where.join(' AND ')}`,
            params,
          );
          expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(names[0]!);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      } finally {
        for (const name of names) await q(`DROP INDEX ${name}`);
      }
    });
  });

  describe('readChanges', () => {
    /** Versions for records l-1..l-3 of `ds`. Returns their seqs in insert order. */
    async function versions(
      ds: ServedDataset,
      rows: { key: string; op: string; version: number; patch: unknown; ageDays?: number }[],
    ): Promise<number[]> {
      const seqs: number[] = [];
      for (const r of rows) {
        const [v] = await q<{ seq: number }>(
          `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, changed_at)
           SELECT $1, id, $3, $4, $5, now() - make_interval(days => $6) FROM records WHERE dataset_id = $1 AND record_key = $2
           RETURNING seq`,
          [ds.id, r.key, r.version, r.op, JSON.stringify(r.patch), r.ageDays ?? 0],
        );
        seqs.push(v!.seq);
      }
      return seqs;
    }
    const publish = (ds: ServedDataset, seq: number) =>
      q(`UPDATE datasets SET published_seq = $2 WHERE id = $1`, [ds.id, seq]);

    test('watermark, hidden-field stripping, skipped hidden-only changes, include=record, cursors', async () => {
      const ds = await dataset(3);
      const seqs = await versions(ds, [
        {
          key: 'l-1',
          op: 'add',
          version: 1,
          patch: [
            {
              op: 'add',
              path: '',
              value: { title: 'Listing 1', price_usd: 1037, agent_phone: `${SECRET}0001` },
            },
          ],
        },
        {
          key: 'l-2',
          op: 'update',
          version: 2,
          patch: [{ op: 'replace', path: '/agent_phone', value: `${SECRET}9999` }],
        },
        {
          key: 'l-1',
          op: 'update',
          version: 2,
          patch: [
            { op: 'replace', path: '/price_usd', value: 1795 },
            { op: 'replace', path: '/agent_phone', value: `${SECRET}7777` },
          ],
        },
        { key: 'l-3', op: 'remove', version: 2, patch: [{ op: 'remove', path: '' }] },
        // Committed but above the watermark: in flight as far as readers are concerned.
        {
          key: 'l-2',
          op: 'update',
          version: 3,
          patch: [{ op: 'replace', path: '/price_usd', value: 1 }],
        },
      ]);
      await q(
        `UPDATE records SET removed_at = now() WHERE dataset_id = $1 AND record_key = 'l-3'`,
        [ds.id],
      );
      await publish(ds, seqs[3]!);

      // since omitted → nothing, cursor at the last published change.
      const start = await readChanges(pools.a, ds, { limit: 50 });
      expect(start).toEqual({
        changes: [],
        next: encodeChangesCursor(ds.id, seqs[3]!),
        hasMore: false,
      });

      const all = await readChanges(pools.a, ds, { since: 0, limit: 50, includeRecord: true });
      const text = JSON.stringify(all);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('agent_phone');
      expect(all.changes.map((c) => [c.key, c.op])).toEqual([
        ['listings/l-1', 'add'],
        ['listings/l-1', 'update'],
        ['listings/l-3', 'remove'],
      ]);
      expect(all.changes[0]!.patch).toEqual([
        {
          op: 'add',
          path: '',
          value: {
            title: 'Listing 1',
            price_usd: 1037,
            bedrooms: null,
            city: null,
            pets: null,
            available_from: null,
          },
        },
      ]);
      expect(all.changes[1]!.patch).toEqual([{ op: 'replace', path: '/price_usd', value: 1795 }]);
      expect(all.changes[1]!.record?.key).toBe('listings/l-1');
      expect(all.changes[2]!.record).toBeNull();
      expect(all.next).toBe(encodeChangesCursor(ds.id, seqs[3]!));
      expect(all.hasMore).toBe(false);
      for (const c of all.changes) expect(c.cursor).toMatch(/^c_/);
      expect(
        Math.max(
          ...all.changes.map((c) =>
            Number(Buffer.from(c.cursor.slice(2), 'base64url').toString().split(':')[1]),
          ),
        ),
      ).toBeLessThanOrEqual(seqs[3]!);

      // Without include=record there is no record key at all.
      expect(
        'record' in (await readChanges(pools.a, ds, { since: 0, limit: 50 })).changes[0]!,
      ).toBe(false);

      // Paging with limit 1 walks the same changes; the hidden-only one is skipped, not returned.
      const walked: string[] = [];
      let since: string | number = 0;
      for (let i = 0; i < 10; i++) {
        const page = await readChanges(pools.a, ds, { since, limit: 1 });
        walked.push(...page.changes.map((c) => c.cursor));
        since = page.next;
        if (!page.hasMore) break;
      }
      expect(walked).toEqual(all.changes.map((c) => c.cursor));

      // The watermark moves → the in-flight change appears.
      await publish(ds, seqs[4]!);
      const more = await readChanges(pools.a, ds, { since: all.next, limit: 50 });
      expect(more.changes.map((c) => c.patch)).toEqual([
        [{ op: 'replace', path: '/price_usd', value: 1 }],
      ]);
    });

    test('a changes cursor from dataset A used on dataset B → 400; garbage → 400', async () => {
      const a = await dataset(1);
      const b = await dataset(1);
      const [seq] = await versions(a, [
        {
          key: 'l-1',
          op: 'update',
          version: 2,
          patch: [{ op: 'replace', path: '/title', value: 'x' }],
        },
      ]);
      await publish(a, seq!);
      const page = await readChanges(pools.a, a, { since: 0, limit: 10 });
      expect(page.changes).toHaveLength(1);
      expect(await rejects(readChanges(pools.a, b, { since: page.next, limit: 10 }))).toBe(
        '400 VALIDATION_ERROR',
      );
      expect(await rejects(readChanges(pools.a, b, { since: 'c_8812', limit: 10 }))).toBe(
        '400 VALIDATION_ERROR',
      );
      expect(
        await rejects(
          readChanges(pools.a, b, { since: '1; DROP TABLE record_versions', limit: 10 }),
        ),
      ).toBe('400 VALIDATION_ERROR');
    });

    test(`a cursor older than ${CHANGES_RETENTION_DAYS} days (or purged) → 410 CURSOR_EXPIRED`, async () => {
      const ds = await dataset(1);
      const seqs = await versions(ds, [
        {
          key: 'l-1',
          op: 'update',
          version: 2,
          patch: [{ op: 'replace', path: '/title', value: 'a' }],
          ageDays: 40,
        },
        {
          key: 'l-1',
          op: 'update',
          version: 3,
          patch: [{ op: 'replace', path: '/title', value: 'b' }],
          ageDays: 10,
        },
        {
          key: 'l-1',
          op: 'update',
          version: 4,
          patch: [{ op: 'replace', path: '/title', value: 'c' }],
        },
      ]);
      await publish(ds, seqs[2]!);
      expect(
        await rejects(
          readChanges(pools.a, ds, { since: encodeChangesCursor(ds.id, seqs[0]!), limit: 10 }),
        ),
      ).toBe('410 CURSOR_EXPIRED');
      expect(
        (await readChanges(pools.a, ds, { since: encodeChangesCursor(ds.id, seqs[1]!), limit: 10 }))
          .changes,
      ).toHaveLength(1);
      // Purged (SP-019's retention job deleted it): also expired.
      await q(`DELETE FROM record_versions WHERE seq = $1`, [seqs[1]]);
      expect(
        await rejects(
          readChanges(pools.a, ds, { since: encodeChangesCursor(ds.id, seqs[1]!), limit: 10 }),
        ),
      ).toBe('410 CURSOR_EXPIRED');
      // Caught up: nothing to miss, so no 410 even for an old position.
      expect(
        (await readChanges(pools.a, ds, { since: encodeChangesCursor(ds.id, seqs[2]!), limit: 10 }))
          .changes,
      ).toEqual([]);
    });

    test('never returns seq > published_seq while a writer commits ahead of the watermark', async () => {
      const ds = await dataset(1);
      let stop = false;
      const writer = (async () => {
        for (let i = 0; i < 40; i++) {
          // Commit a batch of versions, then (separately, later) advance the watermark to it:
          // readers polling in between must not see the batch.
          const seqs = await versions(ds, [
            {
              key: 'l-1',
              op: 'update',
              version: i * 2 + 2,
              patch: [{ op: 'replace', path: '/title', value: `t${i}a` }],
            },
            {
              key: 'l-1',
              op: 'update',
              version: i * 2 + 3,
              patch: [{ op: 'replace', path: '/title', value: `t${i}b` }],
            },
          ]);
          await new Promise((r) => setTimeout(r, 2));
          await pools.b.query(`UPDATE datasets SET published_seq = $2 WHERE id = $1`, [
            ds.id,
            seqs[1],
          ]);
        }
        stop = true;
      })();
      const seqOf = (cursor: string) =>
        Number(Buffer.from(cursor.slice(2), 'base64url').toString().split(':')[1]);
      const seen: number[] = [];
      let since: string | number = 0;
      for (;;) {
        const done = stop;
        const page = await readChanges(pools.a, ds, { since, limit: 7 });
        const [{ published_seq }] = await q<{ published_seq: number }>(
          `SELECT published_seq FROM datasets WHERE id = $1`,
          [ds.id],
        );
        for (const c of page.changes) {
          expect(seqOf(c.cursor)).toBeLessThanOrEqual(published_seq);
          seen.push(seqOf(c.cursor));
        }
        since = page.next;
        // `done` was read before this page: the writer had finished, so this read saw everything.
        if (done && !page.hasMore) break;
      }
      await writer;
      const all = await q<{ seq: number }>(
        `SELECT seq FROM record_versions WHERE dataset_id = $1 ORDER BY seq`,
        [ds.id],
      );
      expect(seen).toEqual(all.map((r) => r.seq));
    });
  });
});
