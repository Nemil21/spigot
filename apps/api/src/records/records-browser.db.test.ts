import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { upsertRecord } from '../extract/upsert.js';
import { cases } from '../security/tenancy/records-browser.cases.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';
import { BLOCK_SIZE } from './browse.js';

/**
 * SP-053 integration (ticket §Test plan): W07's dataset list, server-side row blocks and version
 * history through the real routes. The dataset is the demo's size (2,341 live listings plus one
 * removed); one listing gets its history from SP-013's `upsertRecord`, the way a crawl after
 * `demo:mutate` writes it.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;
const N = 2341;
const CITIES = ['Austin', 'Round Rock', 'Cedar Park', 'Pflugerville'];

const FIELDS = [
  { name: 'title', type: 'string', visible: true, pii: false, filterable: ['eq'] },
  { name: 'price_usd', type: 'integer', visible: true, pii: false, filterable: ['gte', 'lte'] },
  { name: 'bedrooms', type: 'integer', visible: true, pii: false, filterable: ['gte'] },
  { name: 'city', type: 'string', visible: true, pii: false, filterable: ['eq'] },
  { name: 'status', type: 'string', visible: true, pii: false, filterable: [] },
  { name: 'available_on', type: 'date', visible: true, pii: false, filterable: [] },
  { name: 'agent_phone', type: 'string', visible: false, pii: true, filterable: [] },
];

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface Row {
  id: string;
  key: string;
  data: Record<string, unknown>;
  version: number;
  updatedAt: string;
  crawledAt: string | null;
}

describe.skipIf(!testDatabaseUrl)(
  'SP-053 records browser APIs (Postgres)',
  { timeout: 60_000 },
  () => {
    let pools: TwoPools;
    let pool: pg.Pool;
    let app: FastifyInstance;
    let a: { id: string; cookie: string };
    let b: { id: string; cookie: string };
    let siteA: string;
    let siteB: string;
    let dsA: string;
    let dsB: string;
    let mutatedId: string;
    let recordB: string;

    const get = (url: string, cookie: string | null) => {
      const r = request(app.server).get(url);
      if (cookie) r.set('Cookie', cookie);
      return r;
    };
    const rows = (ds: string, q: Record<string, unknown> = {}, cookie = a.cookie) => {
      const qs = new URLSearchParams(
        Object.entries(q).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      );
      return get(`/api/datasets/${ds}/records?${qs}`, cookie);
    };

    async function newPublisher(name: string) {
      const res = await request(app.server)
        .post('/api/auth/signup')
        .set('Origin', APP_ORIGIN)
        .send({
          name,
          email: `p-${randomUUID()}@example.com`,
          password: 'correct horse',
          payoutEmail: 'payouts@example.com',
        });
      expect(res.status).toBe(201);
      return { id: res.body.publisherId as string, cookie: cookiesOf(res) };
    }

    async function newSite(publisherId: string) {
      const id = randomUUID();
      const slug = `site-${id.slice(0, 8)}`;
      const s = generateSiteSecrets(id, SECRET);
      await pool.query(
        `INSERT INTO sites (id, publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY')`,
        [
          id,
          publisherId,
          `https://${slug}.example.com`,
          slug,
          s.verifyToken,
          s.crawlKeyHash,
          s.gateKeyHash,
        ],
      );
      return id;
    }

    async function newDataset(
      siteId: string,
      n: number,
      status = 'LIVE',
      staleSince: Date | null = null,
    ) {
      const d = await pool.query<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count, stale_since)
       VALUES ($1, $2, 'Listing', $3, $4, $5) RETURNING id`,
        [siteId, `listings-${randomUUID().slice(0, 8)}`, status, n, staleSince],
      );
      const id = d.rows[0]!.id;
      const sv = await pool.query<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, ai_model, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'test-model', 'AI') RETURNING id`,
        [id, JSON.stringify(FIELDS)],
      );
      await pool.query('UPDATE datasets SET active_schema_id = $2 WHERE id = $1', [
        id,
        sv.rows[0]!.id,
      ]);
      // Listing i: price 900 + i, i % 5 bedrooms, changed i seconds ago.
      await pool.query(
        `INSERT INTO records (dataset_id, record_key, data, hash, updated_at, crawled_at)
       SELECT $1, 'listings/home-' || lpad(i::text, 4, '0'),
              jsonb_build_object(
                'title', 'Home ' || i, 'price_usd', 900 + i, 'bedrooms', i % 5,
                'city', ($3::text[])[1 + i % 4], 'status', 'available',
                'available_on', to_char(date '2026-11-01' + (i % 30), 'YYYY-MM-DD'),
                'agent_phone', '(512) 555-' || lpad(i::text, 4, '0')),
              'h' || i, now() - make_interval(secs => i), now()
         FROM generate_series(0, $2 - 1) AS i`,
        [id, n, CITIES],
      );
      await pool.query(
        `INSERT INTO records (dataset_id, record_key, data, hash, removed_at)
       VALUES ($1, 'listings/gone', '{"title":"Gone"}', 'hg', now())`,
        [id],
      );
      return id;
    }

    beforeAll(async () => {
      pools = await twoPools();
      pool = pools.a;
      app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: pools.db.url }), {
        logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      });
      await app.ready();
      a = await newPublisher('Bluebonnet');
      b = await newPublisher('Other');
      siteA = await newSite(a.id);
      siteB = await newSite(b.id);
      dsA = await newDataset(siteA, N);
      dsB = await newDataset(siteB, 3, 'LIVE_STALE', new Date('2026-11-12T09:00:00Z'));
      // A proposal has no records yet: not in the browser's list.
      await pool.query(
        `INSERT INTO datasets (site_id, slug, type_name, status) VALUES ($1, 'agents', 'Agent', 'PROPOSED')`,
        [siteA],
      );

      // One listing written by the extractor: added at T0, then a demo:mutate price + status change.
      const db = createDb(pool);
      const run = (
        await pool.query<{ id: string }>(
          `INSERT INTO crawl_runs (site_id, trigger, status, started_at) VALUES ($1, 'APPROVE', 'RUNNING', now()) RETURNING id`,
          [siteA],
        )
      ).rows[0]!.id;
      const page = (
        await pool.query<{ id: string }>(
          `INSERT INTO pages (site_id, url, last_status, fetched_at) VALUES ($1, $2, 200, now()) RETURNING id`,
          [siteA, 'https://bluebonnet.example/listings/2br-east-cesar-chavez-4471'],
        )
      ).rows[0]!.id;
      const base = {
        title: '2BR East Cesar Chavez',
        price_usd: 1850,
        bedrooms: 2,
        city: 'Austin',
        status: 'available',
        available_on: '2026-12-01',
        agent_phone: '(512) 555-0199',
      };
      const write = (data: Record<string, unknown>, h: string, at: string) =>
        db.tx((tx) =>
          upsertRecord(
            tx,
            { datasetId: dsA, runId: run },
            {
              recordKey: 'listings/2br-east-cesar-chavez-4471',
              pageId: page,
              data: data as never,
              hash: h,
              crawledAt: new Date(at),
              sourceLastmod: null,
            },
          ),
        );
      expect(await write(base, 'm1', '2026-11-12T06:00:00Z')).toBe('added');
      expect(
        await write(
          { ...base, price_usd: 1795, status: 'leased', agent_phone: '(512) 555-0100' },
          'm2',
          '2026-11-12T07:00:00Z',
        ),
      ).toBe('updated');
      mutatedId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM records WHERE dataset_id = $1 AND record_key = 'listings/2br-east-cesar-chavez-4471'`,
          [dsA],
        )
      ).rows[0]!.id;
      recordB = (
        await pool.query<{ id: string }>(`SELECT id FROM records WHERE dataset_id = $1 LIMIT 1`, [
          dsB,
        ])
      ).rows[0]!.id;
    });

    afterAll(async () => {
      await app?.close();
      await pools?.close();
    });

    it('lists the tenancy cases it runs', () => {
      expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET /api/sites/:id/datasets',
        'GET /api/datasets/:id/records',
        'GET /api/records/:id/versions',
      ]);
    });

    describe('GET /api/sites/:id/datasets', () => {
      it("lists the site's record-backed datasets with every field, hidden ones flagged", async () => {
        const res = await get(`/api/sites/${siteA}/datasets`, a.cookie);
        expect(res.status).toBe(200);
        expect(res.body.datasets).toHaveLength(1);
        const [d] = res.body.datasets;
        expect(d).toMatchObject({
          id: dsA,
          typeName: 'Listing',
          status: 'LIVE',
          recordCount: N,
          staleSince: null,
        });
        expect(d.fields.map((f: { name: string }) => f.name)).toEqual(FIELDS.map((f) => f.name));
        expect(d.fields.find((f: { name: string }) => f.name === 'agent_phone')).toEqual({
          name: 'agent_phone',
          type: 'string',
          visible: false,
          pii: true,
        });
      });

      it('carries staleSince for the stale banner', async () => {
        const res = await get(`/api/sites/${siteB}/datasets`, b.cookie);
        expect(res.body.datasets[0]).toMatchObject({
          status: 'LIVE_STALE',
          staleSince: '2026-11-12T09:00:00.000Z',
        });
      });
    });

    describe('GET /api/datasets/:id/records', () => {
      it('serves the first block of 100, newest change first, with hidden fields for the owner', async () => {
        const res = await rows(dsA, { startRow: '0', endRow: '100' });
        expect(res.status).toBe(200);
        expect(res.body.rowCount).toBe(N + 1); // + the mutated listing; the removed one never shows
        expect(res.body.rows).toHaveLength(BLOCK_SIZE);
        const first: Row = res.body.rows[0];
        expect(first.key).toBe('listings/2br-east-cesar-chavez-4471');
        expect(first.version).toBe(2);
        expect(first.data.agent_phone).toBe('(512) 555-0100');
        const times = (res.body.rows as Row[]).map((r) => Date.parse(r.updatedAt));
        expect(times).toEqual([...times].sort((x, y) => y - x));
      });

      it('pages all 2,342 rows in blocks with no gaps or repeats, the last block short', async () => {
        const seen = new Set<string>();
        for (let start = 0; start < N + 1; start += BLOCK_SIZE) {
          const res = await rows(dsA, {
            startRow: String(start),
            endRow: String(start + BLOCK_SIZE),
          });
          expect(res.status).toBe(200);
          for (const r of res.body.rows as Row[]) seen.add(r.id);
          if (start + BLOCK_SIZE > N + 1) expect(res.body.rows).toHaveLength((N + 1) % BLOCK_SIZE);
        }
        expect(seen.size).toBe(N + 1);
      });

      it('sorts server-side by a schema field, numerically, with a stable tie-break', async () => {
        const asc = await rows(dsA, { sortModel: [{ colId: 'data.price_usd', sort: 'asc' }] });
        expect((asc.body.rows as Row[]).slice(0, 3).map((r) => r.data.price_usd)).toEqual([
          900, 901, 902,
        ]);
        const desc = await rows(dsA, {
          startRow: '0',
          endRow: '5',
          sortModel: [{ colId: 'data.price_usd', sort: 'desc' }],
        });
        expect((desc.body.rows as Row[]).map((r) => r.data.price_usd)).toEqual([
          3240, 3239, 3238, 3237, 3236,
        ]);
        // A hidden field sorts too: the owner may look at it.
        const hidden = await rows(dsA, {
          endRow: '1',
          sortModel: [{ colId: 'data.agent_phone', sort: 'asc' }],
        });
        expect(hidden.body.rows[0].data.agent_phone).toBe('(512) 555-0000');
        const byVersion = await rows(dsA, {
          endRow: '1',
          sortModel: [{ colId: 'version', sort: 'desc' }],
        });
        expect(byVersion.body.rows[0].version).toBe(2);
      });

      it('filters server-side (number, text, date, combined) and counts the filtered set', async () => {
        const three = await rows(dsA, {
          filterModel: {
            'data.bedrooms': { filterType: 'number', type: 'greaterThanOrEqual', filter: 3 },
            'data.price_usd': { filterType: 'number', type: 'lessThan', filter: 2000 },
            'data.city': { filterType: 'text', type: 'equals', filter: 'austin' },
          },
        });
        expect(three.status).toBe(200);
        const ok = (r: Row) =>
          (r.data.bedrooms as number) >= 3 &&
          (r.data.price_usd as number) < 2000 &&
          r.data.city === 'Austin';
        expect((three.body.rows as Row[]).every(ok)).toBe(true);
        // i in 0..1099 with i%4==0 (Austin) and i%5 in {3,4}, plus the mutated listing has 2 bedrooms.
        let expected = 0;
        for (let i = 0; i < N; i++) if (900 + i < 2000 && i % 4 === 0 && i % 5 >= 3) expected++;
        expect(three.body.rowCount).toBe(expected);

        const contains = await rows(dsA, {
          filterModel: { 'data.title': { filterType: 'text', type: 'contains', filter: 'cesar' } },
        });
        expect(contains.body.rowCount).toBe(1);
        // LIKE wildcards in the value are literal.
        const pct = await rows(dsA, {
          filterModel: { 'data.title': { filterType: 'text', type: 'contains', filter: '%' } },
        });
        expect(pct.body.rowCount).toBe(0);

        const date = await rows(dsA, {
          filterModel: {
            'data.available_on': {
              filterType: 'date',
              type: 'equals',
              dateFrom: '2026-11-03 00:00:00',
            },
          },
        });
        expect((date.body.rows as Row[]).every((r) => r.data.available_on === '2026-11-03')).toBe(
          true,
        );
        expect(date.body.rowCount).toBe(
          Array.from({ length: N }, (_, i) => i % 30).filter((x) => x === 2).length,
        );

        const either = await rows(dsA, {
          filterModel: {
            'data.price_usd': {
              filterType: 'number',
              operator: 'OR',
              conditions: [
                { filterType: 'number', type: 'equals', filter: 900 },
                { filterType: 'number', type: 'equals', filter: 1795 },
              ],
            },
          },
        });
        // Listing 0 (900), listing 895 (1795) and the mutated listing (1795).
        expect(either.body.rowCount).toBe(3);

        const recent = await rows(dsA, {
          filterModel: {
            updatedAt: { filterType: 'date', type: 'greaterThan', dateFrom: '2000-01-01' },
          },
        });
        expect(recent.body.rowCount).toBe(N + 1);
      });

      it('rejects unknown columns, mismatched filter types and oversize blocks with 400', async () => {
        for (const q of [
          { sortModel: [{ colId: 'data.nope', sort: 'asc' }] },
          { sortModel: [{ colId: 'records.id; DROP TABLE records', sort: 'asc' }] },
          {
            filterModel: {
              'data.price_usd': { filterType: 'text', type: 'contains', filter: '1' },
            },
          },
          { filterModel: { 'data.city': { filterType: 'set', values: ['Austin'] } } },
          { filterModel: '{not json' },
          { startRow: '0', endRow: '101' },
          { startRow: '50', endRow: '50' },
          { startRow: '-1', endRow: '10' },
        ]) {
          const res = await rows(dsA, q);
          expect(res.status, JSON.stringify(q)).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    describe('GET /api/records/:id/versions', () => {
      it('returns the history newest first, with the JSON Patch of the mutate change', async () => {
        const res = await get(`/api/records/${mutatedId}/versions`, a.cookie);
        expect(res.status).toBe(200);
        expect(res.body.record).toMatchObject({
          id: mutatedId,
          datasetId: dsA,
          version: 2,
          removedAt: null,
        });
        expect(res.body.hiddenFields).toEqual(['agent_phone']);
        expect(res.body.truncated).toBe(false);
        const [update, add] = res.body.versions;
        expect(update).toMatchObject({ version: 2, op: 'update' });
        expect(update.seq).toBeGreaterThan(add.seq);
        expect(update.patch).toEqual(
          expect.arrayContaining([
            { op: 'replace', path: '/price_usd', value: 1795 },
            { op: 'replace', path: '/status', value: 'leased' },
            { op: 'replace', path: '/agent_phone', value: '(512) 555-0100' },
          ]),
        );
        expect(update.patch).toHaveLength(3);
        expect(add).toMatchObject({ version: 1, op: 'add' });
        expect(add.patch[0]).toMatchObject({ op: 'add', path: '', value: { price_usd: 1850 } });
      });

      it('is empty for a record with no stored versions', async () => {
        const id = (
          await pool.query<{ id: string }>(
            `SELECT id FROM records WHERE dataset_id = $1 AND record_key = 'listings/home-0001'`,
            [dsA],
          )
        ).rows[0]!.id;
        const res = await get(`/api/records/${id}/versions`, a.cookie);
        expect(res.status).toBe(200);
        expect(res.body.versions).toEqual([]);
      });
    });

    describe('tenancy', () => {
      it("404s on another publisher's site, dataset and record", async () => {
        for (const url of [
          `/api/sites/${siteB}/datasets`,
          `/api/datasets/${dsB}/records`,
          `/api/records/${recordB}/versions`,
        ]) {
          const res = await get(url, a.cookie);
          expect(res.status, url).toBe(404);
          expect(res.body.error.code).toBe('NOT_FOUND');
        }
        const own = await rows(dsB, {}, b.cookie);
        expect(own.status).toBe(200);
        expect(own.body.rowCount).toBe(3);
        expect(own.body.staleSince).toBe('2026-11-12T09:00:00.000Z');
      });

      it('404s on a non-uuid id and 401s without a session', async () => {
        expect((await get('/api/datasets/not-a-uuid/records', a.cookie)).status).toBe(404);
        for (const url of [
          `/api/sites/${siteA}/datasets`,
          `/api/datasets/${dsA}/records`,
          `/api/records/${mutatedId}/versions`,
        ]) {
          const res = await get(url, null);
          expect(res.status, url).toBe(401);
        }
      });
    });
  },
);
