import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { createRecordedModel } from '../schema-agent/claude.js';
import { proposeForSite } from '../schema-agent/propose.js';
import { cases } from '../security/tenancy/datasets-read.cases.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';
import { demoSite, type DemoPage } from '../test/schema-agent/demoPages.js';

/**
 * SP-014b integration (ticket §Test plan): W05's proposals list and W06's dataset read through the
 * real routes. Proposals come from SP-012a's recorded model on real demo-site snapshots; the LIVE
 * dataset is fixture records.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface FieldBody {
  name: string;
  type: string;
  visible: boolean;
  pii: boolean;
  rightsFlag: boolean;
  filterable: string[];
  nullRate: number;
  example: unknown;
}

interface ProposalBody {
  datasetId: string;
  schemaVersionId: string;
  typeName: string;
  slug: string;
  records: number;
  templatePattern: string;
  source: string;
  sourceBadge: string;
  fields: FieldBody[];
  sampleRows: Record<string, unknown>[];
  suggestedPerRecordMicros: number;
  aiRationale: string;
}

interface Publisher {
  id: string;
  cookie: string;
}

describe.skipIf(!testDatabaseUrl)('SP-014b dataset read APIs (Postgres)', () => {
  let pools: TwoPools;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let a: Publisher;
  let b: Publisher;
  let siteA: { id: string; slug: string };
  let siteB: { id: string; slug: string };
  let liveA: string;
  let proposedB: string;
  let liveB: string;

  const agent = () => request(app.server);
  const get = (url: string, cookie: string | null) => {
    const r = agent().get(url);
    if (cookie) r.set('Cookie', cookie);
    return r;
  };

  async function newPublisher(name: string): Promise<Publisher> {
    const res = await agent()
      .post('/api/auth/signup')
      .set('Origin', APP_ORIGIN)
      .send({
        name,
        email: `p-${randomUUID()}@example.com`,
        password: 'correct horse',
        payoutEmail: 'payouts@example.com',
      });
    expect(res.status).toBe(201);
    return { id: res.body.publisherId, cookie: cookiesOf(res) };
  }

  async function newSite(publisherId: string, status: string) {
    const id = randomUUID();
    const slug = `site-${id.slice(0, 8)}`;
    const s = generateSiteSecrets(id, SECRET);
    await pool.query(
      `INSERT INTO sites (id, publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        publisherId,
        `https://${slug}.example.com`,
        slug,
        s.verifyToken,
        s.crawlKeyHash,
        s.gateKeyHash,
        status,
      ],
    );
    return { id, slug, origin: `https://${slug}.example.com` };
  }

  async function addPages(siteId: string, origin: string, all: DemoPage[]) {
    for (let i = 0; i < all.length; i += 500)
      await addPageBatch(siteId, origin, all.slice(i, i + 500));
  }

  async function addPageBatch(siteId: string, origin: string, pages: DemoPage[]) {
    await pool.query(
      `WITH p AS (
         INSERT INTO pages (site_id, url, last_status, fetched_at)
         SELECT $1, u.url, 200, now() FROM unnest($2::text[]) AS u(url)
         RETURNING id, url)
       INSERT INTO snapshots (page_id, http_status, html_gz, bytes)
       SELECT p.id, 200, h.gz, length(h.gz) FROM p
         JOIN unnest($2::text[], $3::bytea[]) AS h(url, gz) ON h.url = p.url`,
      [siteId, pages.map((p) => origin + p.path), pages.map((p) => gzipSync(p.html))],
    );
  }

  /** A LIVE dataset with a hidden PII field and `n` records, record i changed i minutes ago. */
  async function addLiveDataset(siteId: string, n: number): Promise<string> {
    const fields = [
      {
        name: 'title',
        type: 'string',
        description: 'Title',
        required: true,
        visible: true,
        pii: false,
        rights_flag: false,
        filterable: ['eq'],
      },
      {
        name: 'price_usd',
        type: 'integer',
        description: null,
        required: false,
        visible: true,
        pii: false,
        rights_flag: false,
        filterable: ['gte', 'lte'],
      },
      {
        name: 'agent_phone',
        type: 'string',
        description: null,
        required: false,
        visible: false,
        pii: true,
        rights_flag: false,
        filterable: [],
      },
    ];
    const extractor = {
      recordKey: { from: 'url' },
      fields: [
        { name: 'title', type: 'string', required: true, source: { css: 'h1', attr: 'text' } },
        {
          name: 'price_usd',
          type: 'integer',
          required: false,
          source: { jsonld: '$.offers.price' },
        },
        {
          name: 'agent_phone',
          type: 'string',
          required: false,
          source: { css: '.phone', attr: 'text' },
        },
      ],
    };
    const d = await pool.query<{ id: string }>(
      `INSERT INTO datasets (site_id, slug, type_name, status, record_count, price_per_record_micros, price_per_change_micros)
       VALUES ($1, $2, 'Listing', 'LIVE', $3, 2000, 700) RETURNING id`,
      [siteId, `live-${randomUUID().slice(0, 8)}`, n],
    );
    const id = d.rows[0]!.id;
    const sv = await pool.query<{ id: string }>(
      `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, ai_model, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, $3, '{"from":"url"}', 'test-model', 'AI') RETURNING id`,
      [id, JSON.stringify(fields), JSON.stringify(extractor)],
    );
    await pool.query('UPDATE datasets SET active_schema_id = $2 WHERE id = $1', [
      id,
      sv.rows[0]!.id,
    ]);
    for (let i = 0; i < n; i++) {
      await pool.query(
        `INSERT INTO records (dataset_id, record_key, data, hash, updated_at)
         VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5))`,
        [
          id,
          `r${i}`,
          JSON.stringify({
            title: `Home ${i}`,
            price_usd: 1000 + i,
            agent_phone: `(512) 555-01${String(i).padStart(2, '0')}`,
          }),
          `h${i}`,
          i,
        ],
      );
    }
    // A removed record, newest of all: never a sample row.
    await pool.query(
      `INSERT INTO records (dataset_id, record_key, data, hash, removed_at) VALUES ($1, 'gone', '{"title":"Gone"}', 'hg', now())`,
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

    // The whole demo site (2,341 listings, 88 agents, 40 open houses + blog / about), as crawled.
    const pages = (await demoSite(1)).pages;
    const sa = await newSite(a.id, 'PROPOSING');
    siteA = sa;
    await addPages(sa.id, sa.origin, pages);
    await pool.query(
      `INSERT INTO crawl_runs (site_id, trigger, status, started_at, finished_at)
       VALUES ($1, 'CONNECT', 'SUCCEEDED', now(), now())`,
      [sa.id],
    );
    const r = await proposeForSite({ db: createDb(pool), model: createRecordedModel() }, sa.id, {
      trigger: 'DISCOVERY',
    });
    expect(r.templates.filter((t) => t.status === 'proposed')).toHaveLength(3);
    liveA = await addLiveDataset(sa.id, 25);

    const sb = await newSite(b.id, 'READY');
    siteB = sb;
    liveB = await addLiveDataset(sb.id, 3);
    const pb = await pool.query<{ id: string }>(
      `INSERT INTO datasets (site_id, slug, type_name, status) VALUES ($1, 'b-proposed', 'Thing', 'PROPOSED') RETURNING id`,
      [sb.id],
    );
    proposedB = pb.rows[0]!.id;
    await pool.query(
      `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, ai_model, proposed_by)
       VALUES ($1, 1, 'PROPOSED', '[{"name":"secret","type":"string","visible":true}]',
               '{"recordKey":{"from":"url"},"fields":[{"name":"secret","type":"string","source":{"css":"h1"}}]}',
               '{"from":"url"}', 'test-model', 'AI')`,
      [proposedB],
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pools?.close();
  });

  it('lists the tenancy cases it runs', () => {
    expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/sites/:id/proposals',
      'GET /api/datasets/:id',
    ]);
  });

  describe('GET /api/sites/:id/proposals', () => {
    it('returns the demo site three proposals with 5 sample rows each', async () => {
      const res = await get(`/api/sites/${siteA.id}/proposals`, a.cookie);
      expect(res.status).toBe(200);
      const { proposals } = res.body as { proposals: ProposalBody[] };
      expect(proposals.map((p) => [p.typeName, p.records, p.templatePattern])).toEqual([
        ['Listing', 2341, expect.stringContaining('listings')],
        ['Agent', 88, expect.stringContaining('agents')],
        ['Open House', 40, expect.stringContaining('open-houses')],
      ]);
      for (const p of proposals) {
        expect(p.sampleRows).toHaveLength(5);
        expect(p.schemaVersionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(['JSON-LD', 'CSS']).toContain(p.sourceBadge);
        expect(p.source).toEqual(expect.any(String));
        expect(p.suggestedPerRecordMicros).toBe(1500);
        expect(p.aiRationale).toEqual(expect.any(String));
        expect(p.fields.length).toBeGreaterThan(0);
        for (const f of p.fields) {
          expect(f).toMatchObject({
            name: expect.any(String),
            type: expect.any(String),
            visible: expect.any(Boolean),
            pii: expect.any(Boolean),
            rightsFlag: expect.any(Boolean),
            filterable: expect.any(Array),
          });
          expect(f.nullRate).toBeGreaterThanOrEqual(0);
          expect(f.nullRate).toBeLessThanOrEqual(1);
          expect('example' in f).toBe(true);
        }
        // Rows carry schema fields only.
        const names = new Set(p.fields.map((f: { name: string }) => f.name));
        for (const row of p.sampleRows)
          for (const k of Object.keys(row)) expect(names.has(k)).toBe(true);
      }
      // The Listing proposal reads JSON-LD (Apartment / Offer on the demo site).
      expect(proposals[0].sourceBadge).toBe('JSON-LD');
      expect(proposals[0].source).toMatch(/^JSON-LD/);
    });

    it("never lists LIVE datasets or another publisher's proposals", async () => {
      const res = await get(`/api/sites/${siteA.id}/proposals`, a.cookie);
      const ids = (res.body.proposals as { datasetId: string }[]).map((p) => p.datasetId);
      expect(ids).not.toContain(liveA);
      expect(ids).not.toContain(proposedB);
    });

    it("another publisher's site → 404; no session → 401; junk id → 404", async () => {
      const other = await get(`/api/sites/${siteA.id}/proposals`, b.cookie);
      expect(other.status).toBe(404);
      expect(other.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(other.body)).not.toContain('Listing');
      expect((await get(`/api/sites/${siteB.id}/proposals`, a.cookie)).status).toBe(404);
      expect((await get(`/api/sites/${siteA.id}/proposals`, null)).status).toBe(401);
      expect((await get('/api/sites/not-a-uuid/proposals', a.cookie)).status).toBe(404);
    });
  });

  describe('GET /api/datasets/:id', () => {
    it('PROPOSED: 20 sample rows from the extractor (5 seen + 15 unseen pages), hidden fields included and flagged', async () => {
      const list = await get(`/api/sites/${siteA.id}/proposals`, a.cookie);
      for (const p of list.body.proposals as ProposalBody[]) {
        const res = await get(`/api/datasets/${p.datasetId}`, a.cookie);
        expect(res.status).toBe(200);
        const d = res.body;
        expect(d).toMatchObject({
          id: p.datasetId,
          siteSlug: siteA.slug,
          slug: p.slug,
          typeName: p.typeName,
          status: 'PROPOSED',
          staleSince: null,
          activeSchemaVersion: null,
          latestSchemaVersion: {
            id: p.schemaVersionId,
            version: 1,
            status: 'PROPOSED',
            proposedBy: 'AI',
          },
          prices: { perRecordMicros: 1500, perChangeMicros: 500 },
          recordCount: p.records,
          endpoint: `${APP_ORIGIN.replace(/\/+$/, '')}/v1/${siteA.slug}/datasets/${p.slug}/records`,
        });
        expect(d.sampleRows).toHaveLength(20);
        // The first 5 rows are the pages the model saw: the proposal's own sample rows.
        expect(d.sampleRows.slice(0, 5)).toEqual(p.sampleRows);
        // Every field the schema lists, hidden ones included, is a key the extractor fills.
        const hidden = d.fields.filter((f: { visible: boolean }) => !f.visible);
        for (const f of hidden) {
          expect(d.sampleRows.some((r: Record<string, unknown>) => f.name in r)).toBe(true);
        }
      }
      // The demo site's Agent pages carry phone / email: the guard hides them, W06 still shows them.
      const agentP = (list.body.proposals as ProposalBody[]).find((p) => p.typeName === 'Agent')!;
      const agentD = (await get(`/api/datasets/${agentP.datasetId}`, a.cookie)).body;
      const hiddenAgent = agentD.fields.filter((f: { visible: boolean }) => !f.visible);
      expect(hiddenAgent.length).toBeGreaterThan(0);
      expect(
        hiddenAgent.every((f: { pii: boolean; rightsFlag: boolean }) => f.pii || f.rightsFlag),
      ).toBe(true);
      const someHiddenValue = agentD.sampleRows.some((r: Record<string, unknown>) =>
        hiddenAgent.some((f: { name: string }) => r[f.name] !== null && r[f.name] !== undefined),
      );
      expect(someHiddenValue).toBe(true);
    });

    it('LIVE: the 20 most recent live records, hidden field present in rows and flagged', async () => {
      const res = await get(`/api/datasets/${liveA}`, a.cookie);
      expect(res.status).toBe(200);
      const d = res.body;
      expect(d.status).toBe('LIVE');
      expect(d.prices).toEqual({ perRecordMicros: 2000, perChangeMicros: 700 });
      expect(d.recordCount).toBe(25);
      expect(d.activeSchemaVersion).toMatchObject({ version: 1 });
      expect(d.latestSchemaVersion).toMatchObject({ version: 1, status: 'APPROVED' });
      expect(d.sampleRows).toHaveLength(20);
      expect(d.sampleRows.map((r: { title: string }) => r.title)).toEqual(
        Array.from({ length: 20 }, (_, i) => `Home ${i}`),
      );
      expect(d.sampleRows[0].agent_phone).toBe('(512) 555-0100');
      const phone = d.fields.find((f: { name: string }) => f.name === 'agent_phone');
      expect(phone).toMatchObject({
        visible: false,
        pii: true,
        filterable: [],
        nullRate: 0,
        example: '(512) 555-0100',
      });
      expect(d.fields.find((f: { name: string }) => f.name === 'title')).toMatchObject({
        visible: true,
        description: 'Title',
        filterable: ['eq'],
      });
      expect(d.endpoint).toMatch(
        new RegExp(`/v1/${siteA.slug}/datasets/live-[0-9a-f]{8}/records$`),
      );
    });

    it("another publisher's dataset → 404 (PROPOSED and LIVE); no session → 401", async () => {
      for (const id of [proposedB, liveB]) {
        const res = await get(`/api/datasets/${id}`, a.cookie);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
        expect(JSON.stringify(res.body)).not.toContain('secret');
      }
      expect((await get(`/api/datasets/${liveA}`, b.cookie)).status).toBe(404);
      expect((await get(`/api/datasets/${liveA}`, null)).status).toBe(401);
      expect((await get('/api/datasets/nope', a.cookie)).status).toBe(404);
      expect((await get(`/api/datasets/${randomUUID()}`, a.cookie)).status).toBe(404);
    });
  });
});
