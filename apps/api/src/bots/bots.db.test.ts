import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { cases } from '../security/tenancy/bots.cases.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-027a integration (ticket §Test plan): the W04 bot report and the activity feed through the
 * real routes, on fixture `bot_hits`, `api_calls` and `audit_events` rows.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface Hit {
  bucket: string;
  category: string;
  botName: string;
  decision: string;
  hits: number;
  bytes: number;
  sim: boolean;
}

interface Publisher {
  id: string;
  cookie: string;
}

const FROM = '2026-11-05T00:00:00.000Z';
const TO = '2026-11-12T00:00:00.000Z';

/** Fixture buckets for site A: in range, out of range (before / at `to`), real and SIM. */
const HITS: Hit[] = [
  {
    bucket: '2026-11-05T00:00:00Z',
    category: 'AI_TRAINING',
    botName: 'GPTBot',
    decision: 'QUOTE_402',
    hits: 40,
    bytes: 4_000_000,
    sim: false,
  },
  {
    bucket: '2026-11-06T13:07:00Z',
    category: 'AI_TRAINING',
    botName: 'GPTBot',
    decision: 'QUOTE_402',
    hits: 60,
    bytes: 6_000_000,
    sim: true,
  },
  {
    bucket: '2026-11-06T13:07:00Z',
    category: 'AI_TRAINING',
    botName: 'ClaudeBot',
    decision: 'QUOTE_402',
    hits: 25,
    bytes: 2_500_000,
    sim: false,
  },
  {
    bucket: '2026-11-07T09:00:00Z',
    category: 'SEARCH',
    botName: 'Googlebot',
    decision: 'PASS',
    hits: 300,
    bytes: 30_000_000,
    sim: false,
  },
  {
    bucket: '2026-11-08T22:59:00Z',
    category: 'SCRAPER_TOOL',
    botName: 'python-requests',
    decision: 'QUOTE_402',
    hits: 15,
    bytes: 1_500_000,
    sim: true,
  },
  {
    bucket: '2026-11-09T01:30:00Z',
    category: 'AI_AGENT',
    botName: 'ChatGPT-User',
    decision: 'PASS',
    hits: 8,
    bytes: 800_000,
    sim: false,
  },
  {
    bucket: '2026-11-09T01:30:00Z',
    category: 'UNKNOWN',
    botName: '-',
    decision: 'FAIL_OPEN',
    hits: 2,
    bytes: 0,
    sim: false,
  },
  {
    bucket: '2026-11-10T10:10:00Z',
    category: 'HUMAN',
    botName: '-',
    decision: 'PASS',
    hits: 9_000,
    bytes: 900_000_000,
    sim: false,
  },
  {
    bucket: '2026-11-10T10:10:00Z',
    category: 'HUMAN',
    botName: '-',
    decision: 'PASS',
    hits: 1_000,
    bytes: 100_000_000,
    sim: true,
  },
  {
    bucket: '2026-11-11T23:59:00Z',
    category: 'AI_TRAINING',
    botName: 'GPTBot',
    decision: 'QUOTE_402',
    hits: 5,
    bytes: 500_000,
    sim: false,
  },
  // Outside [FROM, TO): never counted.
  {
    bucket: '2026-11-04T23:59:00Z',
    category: 'AI_TRAINING',
    botName: 'GPTBot',
    decision: 'QUOTE_402',
    hits: 999,
    bytes: 1,
    sim: false,
  },
  {
    bucket: '2026-11-12T00:00:00Z',
    category: 'HUMAN',
    botName: '-',
    decision: 'PASS',
    hits: 999,
    bytes: 1,
    sim: false,
  },
];

/** What the report must say, computed straight from the fixture array. */
function expectedTotals(rows: Hit[], includeSim: boolean) {
  const inRange = rows.filter(
    (h) =>
      Date.parse(h.bucket) >= Date.parse(FROM) &&
      Date.parse(h.bucket) < Date.parse(TO) &&
      (includeSim || !h.sim),
  );
  const sum = (xs: Hit[], f: (h: Hit) => number) => xs.reduce((a, h) => a + f(h), 0);
  const quoted = inRange.filter((h) => h.decision === 'QUOTE_402');
  return {
    botHits: sum(
      inRange.filter((h) => h.category !== 'HUMAN'),
      (h) => h.hits,
    ),
    humanHits: sum(
      inRange.filter((h) => h.category === 'HUMAN'),
      (h) => h.hits,
    ),
    quoted402: sum(quoted, (h) => h.hits),
    bytesSavedEstimate: sum(quoted, (h) => h.bytes),
    all: sum(inRange, (h) => h.hits),
  };
}

describe.skipIf(!testDatabaseUrl)('SP-027a bots + activity APIs (Postgres)', () => {
  let pools: TwoPools;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let a: Publisher;
  let b: Publisher;
  let siteA: string;
  let siteB: string;

  let datasetB: string;

  const agent = () => request(app.server);
  const bots = (siteId: string, cookie: string | null, query: Record<string, string> = {}) => {
    const r = agent().get(`/api/sites/${siteId}/bots`).query(query);
    if (cookie) r.set('Cookie', cookie);
    return r;
  };
  const activity = (cookie: string | null, query: Record<string, string> = {}) => {
    const r = agent().get('/api/publishers/me/activity').query(query);
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

  async function newSite(publisherId: string): Promise<string> {
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

  async function addDataset(
    siteId: string,
    status: string,
    price: number,
    pages: number,
    records: number,
    typeName = 'Listing',
  ): Promise<string> {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO templates (site_id, url_pattern, page_count) VALUES ($1, $2, $3) RETURNING id`,
      [siteId, `^/${randomUUID().slice(0, 8)}/`, pages],
    );
    const d = await pool.query<{ id: string }>(
      `INSERT INTO datasets (site_id, template_id, slug, type_name, status, price_per_record_micros, record_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [siteId, t.rows[0]!.id, `ds-${randomUUID().slice(0, 8)}`, typeName, status, price, records],
    );
    return d.rows[0]!.id;
  }

  async function insertHits(siteId: string, rows: Hit[]): Promise<void> {
    for (const h of rows) {
      await pool.query(
        `INSERT INTO bot_hits (site_id, bucket, category, bot_name, decision, hits, bytes, is_simulated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [siteId, h.bucket, h.category, h.botName, h.decision, h.hits, h.bytes, h.sim],
      );
    }
  }

  async function newBuyer(name: string, sim = false): Promise<{ id: string; keyId: string }> {
    const buyer = await pool.query<{ id: string }>(
      `INSERT INTO buyers (name, email, is_simulated) VALUES ($1, $2, $3) RETURNING id`,
      [name, `b-${randomUUID()}@example.com`, sim],
    );
    const key = await pool.query<{ id: string }>(
      `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'sk_test_', $2) RETURNING id`,
      [buyer.rows[0]!.id, randomUUID()],
    );
    return { id: buyer.rows[0]!.id, keyId: key.rows[0]!.id };
  }

  async function addCall(
    buyer: { id: string; keyId: string },
    datasetId: string,
    o: {
      price: number;
      status?: string;
      sim?: boolean;
      hidden?: boolean;
      records?: number;
      at?: string;
      credited?: number;
    },
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO api_calls (buyer_id, api_key_id, channel, dataset_id, endpoint, idempotency_key, status,
                              records_returned, price_micros, credited_micros, commission_bps,
                              is_simulated, hidden_at, created_at)
       VALUES ($1, $2, 'REST', $3, 'records.search', $4, $5, $6, $7, $8, 2000, $9,
               CASE WHEN $10::bool THEN now() END, COALESCE($11::timestamptz, now()))
       RETURNING id`,
      [
        buyer.id,
        buyer.keyId,
        datasetId,
        randomUUID(),
        o.status ?? 'CHARGED',
        o.records ?? 10,
        o.price,
        o.credited ?? 0,
        o.sim ?? false,
        o.hidden ?? false,
        o.at ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async function addAudit(e: {
    at: string;
    action: string;
    publisherId: string | null;
    entity?: string;
    entityId?: string;
    actorType?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO audit_events (at, actor_type, publisher_id, entity, entity_id, action, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        e.at,
        e.actorType ?? 'SYSTEM',
        e.publisherId,
        e.entity ?? null,
        e.entityId ?? null,
        e.action,
        e.data ? JSON.stringify(e.data) : null,
      ],
    );
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
    // Detail template (1 record / page) at $1.50 / 1,000 records; a REJECTED one never prices.
    await addDataset(siteA, 'LIVE', 1500, 100, 100);
    await addDataset(siteA, 'REJECTED', 90_000, 1000, 1000);
    datasetB = await addDataset(siteB, 'LIVE', 2000, 10, 10);

    await insertHits(siteA, HITS);
    // Site B has hits in the same buckets; they must never show in A's report.
    await insertHits(
      siteB,
      HITS.map((h) => ({ ...h, hits: h.hits * 7 + 3, bytes: h.bytes * 7 + 3 })),
    );
  });

  afterAll(async () => {
    await app?.close();
    await pools?.close();
  });

  describe('GET /api/sites/:id/bots', () => {
    it.each([true, false])(
      'totals equal sums over the bot_hits fixtures (includeSim=%s)',
      async (includeSim) => {
        const res = await bots(siteA, a.cookie, {
          from: FROM,
          to: TO,
          includeSim: String(includeSim),
        });
        expect(res.status).toBe(200);
        const want = expectedTotals(HITS, includeSim);
        const { totals } = res.body;
        expect(totals).toMatchObject({
          botHits: want.botHits,
          humanHits: want.humanHits,
          quoted402: want.quoted402,
          bytesSavedEstimate: want.bytesSavedEstimate,
          wouldHaveEarnedMicros: want.quoted402 * 1500,
          estimate: true,
          estimateBasis: { perGatedPageMicros: 1500, priceSource: 'LIVE' },
        });
        expect(res.body.includeSim).toBe(includeSim);
        expect(res.body.range).toEqual({ from: FROM, to: TO, bucketSize: 'hour' });

        // byBot sums back to botHits; series sums to every hit in range.
        const byBot = res.body.byBot as {
          hits: number;
          wouldHavePaid: number;
          isSimulated: boolean;
        }[];
        expect(byBot.reduce((s, r) => s + r.hits, 0)).toBe(want.botHits);
        expect(byBot.reduce((s, r) => s + r.wouldHavePaid, 0)).toBe(want.quoted402 * 1500);
        const series = res.body.series as { hits: number }[];
        expect(series.reduce((s, r) => s + r.hits, 0)).toBe(want.all);
        if (!includeSim) expect(byBot.every((r) => !r.isSimulated)).toBe(true);
      },
    );

    it('the SIM toggle changes the totals', async () => {
      const on = await bots(siteA, a.cookie, { from: FROM, to: TO });
      const off = await bots(siteA, a.cookie, { from: FROM, to: TO, includeSim: 'false' });
      expect(on.body.totals.botHits).toBe(off.body.totals.botHits + 60 + 15);
      expect(on.body.totals.humanHits).toBe(off.body.totals.humanHits + 1_000);
      expect(on.body.totals.quoted402).toBe(off.body.totals.quoted402 + 75);
      expect(on.body.totals.ratio).toBe('1 bot per 22 human visits'); // 10,000 / 455
      expect(off.body.totals.ratio).toBe('1 bot per 24 human visits'); // 9,000 / 380
    });

    it('splits byBot by bot, decision and SIM, largest first, with lastSeen and bytes', async () => {
      const res = await bots(siteA, a.cookie, { from: FROM, to: TO });
      const byBot = res.body.byBot as Record<string, unknown>[];
      expect(byBot[0]).toEqual({
        botName: 'Googlebot',
        category: 'SEARCH',
        hits: 300,
        decision: 'PASS',
        lastSeen: '2026-11-07T09:00:00.000Z',
        bytes: 30_000_000,
        wouldHavePaid: 0,
        isSimulated: false,
      });
      const gpt = byBot.filter((r) => r.botName === 'GPTBot');
      expect(gpt).toEqual([
        expect.objectContaining({ hits: 60, isSimulated: true, wouldHavePaid: 90_000 }),
        expect.objectContaining({
          hits: 45,
          isSimulated: false,
          wouldHavePaid: 67_500,
          lastSeen: '2026-11-11T23:59:00.000Z',
        }),
      ]);
      expect(byBot.some((r) => r.category === 'HUMAN')).toBe(false);
    });

    it('buckets the series by the range: minute for ≤ 3 h, hour for 7 d, day beyond', async () => {
      const short = await bots(siteA, a.cookie, {
        from: '2026-11-06T13:00:00Z',
        to: '2026-11-06T14:00:00Z',
      });
      expect(short.body.range.bucketSize).toBe('minute');
      expect(short.body.series).toEqual([
        { bucket: '2026-11-06T13:07:00.000Z', category: 'AI_TRAINING', hits: 85 },
      ]);

      const week = await bots(siteA, a.cookie, { from: FROM, to: TO });
      expect(week.body.series).toContainEqual({
        bucket: '2026-11-08T22:00:00.000Z',
        category: 'SCRAPER_TOOL',
        hits: 15,
      });

      const month = await bots(siteA, a.cookie, {
        from: '2026-10-20T00:00:00Z',
        to: '2026-11-20T00:00:00Z',
      });
      expect(month.body.range.bucketSize).toBe('day');
      expect(month.body.series).toContainEqual({
        bucket: '2026-11-10T00:00:00.000Z',
        category: 'HUMAN',
        hits: 10_000,
      });
    });

    it("another publisher's site → 404; a bad id → 404; no session → 401", async () => {
      expect(cases.map((c) => c.url)).toContain('/api/sites/:id/bots');
      const cross = await bots(siteB, a.cookie);
      expect(cross.status).toBe(404);
      expect(cross.body.error.code).toBe('NOT_FOUND');
      expect((await bots('not-a-uuid', a.cookie)).status).toBe(404);
      expect((await bots(randomUUID(), a.cookie)).status).toBe(404);
      expect((await bots(siteA, null)).status).toBe(401);
      // B sees its own site, with its own (larger) numbers.
      const own = await bots(siteB, b.cookie, { from: FROM, to: TO });
      expect(own.status).toBe(200);
      expect(own.body.totals.wouldHaveEarnedMicros).toBe(own.body.totals.quoted402 * 2000);
    });

    it('rejects a bad range with 400 VALIDATION_ERROR', async () => {
      const res = await bots(siteA, a.cookie, { from: TO, to: FROM });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('earnedThisWeek is the net of charged calls in the last 7 days, with the SIM share', async () => {
      const site = await newSite(a.id);
      const ds = await addDataset(site, 'LIVE', 1500, 10, 10);
      const buyer = await newBuyer('Acme Agents');
      await addCall(buyer, ds, { price: 1_000_000 }); // net 800,000
      await addCall(buyer, ds, { price: 500_000, sim: true }); // net 400,000 (SIM)
      await addCall(buyer, ds, { price: 300_000, credited: 100_000, status: 'PARTIALLY_CREDITED' }); // 160,000
      await addCall(buyer, ds, { price: 9_000_000, hidden: true }); // demo-hidden
      await addCall(buyer, ds, { price: 9_000_000, status: 'CREDITED' }); // fully credited back
      await addCall(buyer, ds, { price: 0, status: 'PAYMENT_REQUIRED' });
      await addCall(buyer, ds, {
        price: 9_000_000,
        at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      });
      await addCall(buyer, datasetB, { price: 9_000_000 }); // B's dataset

      const on = await bots(site, a.cookie);
      expect(on.body.earnedThisWeek).toEqual({
        micros: 1_360_000,
        simMicros: 400_000,
        simShare: 0.2941,
      });
      const off = await bots(site, a.cookie, { includeSim: 'false' });
      expect(off.body.earnedThisWeek).toEqual({ micros: 960_000, simMicros: 0, simShare: 0 });
    });

    it('prices the estimate from proposals before anything is LIVE, else the default', async () => {
      const bare = await newSite(a.id);
      await insertHits(bare, [
        {
          bucket: '2026-11-06T00:00:00Z',
          category: 'AI_TRAINING',
          botName: 'GPTBot',
          decision: 'QUOTE_402',
          hits: 10,
          bytes: 0,
          sim: false,
        },
      ]);
      const q = { from: FROM, to: TO };
      let res = await bots(bare, a.cookie, q);
      expect(res.body.totals.estimateBasis).toEqual({
        perGatedPageMicros: 1500,
        priceSource: 'DEFAULT',
      });
      expect(res.body.totals.ratio).toBe('Only bots, no human visits');

      // A list template: 50 pages carrying 1,000 records → 20 records per page at $2 / 1,000.
      await addDataset(bare, 'PROPOSED', 2000, 50, 1000);
      res = await bots(bare, a.cookie, q);
      expect(res.body.totals.estimateBasis).toEqual({
        perGatedPageMicros: 40_000,
        priceSource: 'PROPOSED',
      });
      expect(res.body.totals.wouldHaveEarnedMicros).toBe(400_000);
    });

    it('a 7-day range over 100k bot_hits rows answers in < 300 ms', async () => {
      const site = await newSite(a.id);
      await addDataset(site, 'LIVE', 1500, 100, 100);
      // 100,000 distinct rows over the last 7 days: 10,080 minutes × ~10 (bot, decision, SIM).
      await pool.query(
        `INSERT INTO bot_hits (site_id, bucket, category, bot_name, decision, hits, bytes, is_simulated)
         SELECT $1, date_trunc('minute', now()) - (m || ' minutes')::interval,
                (ARRAY['AI_TRAINING','SEARCH','SCRAPER_TOOL','AI_AGENT','HUMAN'])[1 + v % 5],
                (ARRAY['GPTBot','Googlebot','python-requests','ChatGPT-User','-'])[1 + v % 5],
                CASE WHEN v % 2 = 0 THEN 'QUOTE_402' ELSE 'PASS' END,
                1 + (m + v) % 9, 1000 * (1 + v % 3), v >= 5
           FROM generate_series(0, 9999) m, generate_series(0, 9) v`,
        [site],
      );
      await pool.query('ANALYZE bot_hits');
      const count = await pool.query('SELECT count(*)::int AS n FROM bot_hits WHERE site_id = $1', [
        site,
      ]);
      expect(count.rows[0].n).toBe(100_000);

      await bots(site, a.cookie); // warm the plan cache and the pool
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const res = await bots(site, a.cookie);
        best = Math.min(best, performance.now() - t0);
        expect(res.status).toBe(200);
        expect(res.body.series.length).toBeGreaterThan(100);
      }
      expect(best).toBeLessThan(300);
    }, 60_000); // seeding 100k rows takes a few seconds under parallel test load
  });

  describe('GET /api/publishers/me/activity', () => {
    it("returns only this publisher's events (and their buyers' top-ups), newest first, SIM-flagged", async () => {
      // Fresh publishers so the feed holds only this test's rows.
      const p = await newPublisher('Feed A');
      const q = await newPublisher('Feed B');
      const site = await newSite(p.id);
      const ds = await addDataset(site, 'LIVE', 1500, 2341, 2341);
      const otherSite = await newSite(q.id);
      const otherDs = await addDataset(otherSite, 'LIVE', 1500, 10, 10, 'Agent');

      const acme = await newBuyer('Acme Agents');
      const simBuyer = await newBuyer('Sim Buyer 7', true);
      const stranger = await newBuyer('Only buys from B');
      const call = await addCall(acme, ds, { price: 55_500, records: 37 });
      const simCall = await addCall(simBuyer, ds, { price: 15_000, records: 10, sim: true });
      const hiddenCall = await addCall(acme, ds, { price: 99_000, hidden: true });
      await addCall(stranger, otherDs, { price: 1500 });

      const topup = async (buyerId: string, cents: number, trigger = 'MANUAL') =>
        (
          await pool.query<{ id: string }>(
            `INSERT INTO topups (buyer_id, amount_cents, trigger, status) VALUES ($1, $2, $3, 'COMPLETED') RETURNING id`,
            [buyerId, cents, trigger],
          )
        ).rows[0]!.id;
      const acmeTopup = await topup(acme.id, 2000);
      const simTopup = await topup(simBuyer.id, 1000, 'SIM');
      const strangerTopup = await topup(stranger.id, 5000);

      const t = (min: number) => new Date(Date.UTC(2026, 10, 12, 8, min)).toISOString();
      await addAudit({
        at: t(1),
        action: 'CRAWL_RUN_DONE',
        publisherId: p.id,
        entity: 'crawl_runs',
        entityId: randomUUID(),
        actorType: 'WORKFLOW',
        data: {
          status: 'SUCCEEDED',
          pagesFetched: 2341,
          recordsAdded: 2341,
          recordsUpdated: 0,
          recordsRemoved: 0,
        },
      });
      await addAudit({
        at: t(2),
        action: 'SCHEMA_PROPOSED',
        publisherId: p.id,
        entity: 'dataset',
        entityId: ds,
        actorType: 'SCHEMA_AGENT',
        data: { records: 2341 },
      });
      await addAudit({
        at: t(3),
        action: 'DATASET_PUBLISHED',
        publisherId: p.id,
        entity: 'datasets',
        entityId: ds,
        actorType: 'PUBLISHER',
      });
      await addAudit({
        at: t(4),
        action: 'TOPUP_COMPLETED',
        publisherId: null,
        entity: 'topups',
        entityId: acmeTopup,
        actorType: 'BUYER',
        data: { amountCents: 2000 },
      });
      await addAudit({
        at: t(5),
        action: 'CALL_CHARGED',
        publisherId: p.id,
        entity: 'api_call',
        entityId: call,
        actorType: 'BUYER',
        data: { datasetId: ds, priceMicros: 55_500 },
      });
      await addAudit({
        at: t(6),
        action: 'CALL_CHARGED',
        publisherId: p.id,
        entity: 'api_call',
        entityId: simCall,
        actorType: 'SIM',
        data: { datasetId: ds, priceMicros: 15_000 },
      });
      await addAudit({
        at: t(7),
        action: 'CALL_CHARGED',
        publisherId: p.id,
        entity: 'api_call',
        entityId: hiddenCall,
        actorType: 'BUYER',
        data: { datasetId: ds, priceMicros: 99_000 },
      });
      await addAudit({
        at: t(8),
        action: 'TOPUP_COMPLETED',
        publisherId: null,
        entity: 'topups',
        entityId: simTopup,
        actorType: 'SIM',
      });
      await addAudit({
        at: t(9),
        action: 'PAYOUT_SENT',
        publisherId: p.id,
        entity: 'payout_item',
        entityId: randomUUID(),
        actorType: 'WORKFLOW',
        data: { netCents: 41_275 },
      });
      await addAudit({
        at: t(10),
        action: 'PAYOUT_SETTLED',
        publisherId: p.id,
        entity: 'payout_item',
        entityId: randomUUID(),
        actorType: 'WORKFLOW',
        data: { netCents: 41_275, status: 'SUCCESS' },
      });
      // Not in the feed: other actions, the other publisher's rows, a stranger's top-up.
      await addAudit({
        at: t(11),
        action: 'SITE_VERIFIED',
        publisherId: p.id,
        entity: 'sites',
        entityId: site,
      });
      await addAudit({
        at: t(12),
        action: 'CALL_CHARGED',
        publisherId: q.id,
        entity: 'api_call',
        entityId: randomUUID(),
        data: { priceMicros: 1500 },
      });
      await addAudit({
        at: t(13),
        action: 'PAYOUT_SENT',
        publisherId: q.id,
        entity: 'payout_item',
        entityId: randomUUID(),
        data: { netCents: 999 },
      });
      await addAudit({
        at: t(14),
        action: 'TOPUP_COMPLETED',
        publisherId: null,
        entity: 'topups',
        entityId: strangerTopup,
        actorType: 'BUYER',
        data: { amountCents: 5000 },
      });

      const res = await activity(p.cookie, { publisherId: q.id });
      expect(res.status).toBe(200);
      const events = res.body.events as {
        at: string;
        action: string;
        isSimulated: boolean;
        line: string;
      }[];
      expect(events.map((e) => [e.at, e.action, e.isSimulated, e.line])).toEqual([
        [t(10), 'PAYOUT_SETTLED', false, '$412.75 paid out via PayPal'],
        [t(9), 'PAYOUT_SENT', false, '$412.75 sent via PayPal'],
        [t(8), 'TOPUP_COMPLETED', true, 'Sim Buyer 7 added $10 via PayPal'],
        [t(6), 'CALL_CHARGED', true, 'Sim Buyer 7: $0.015 charged for 10 Listing records'],
        [t(5), 'CALL_CHARGED', false, 'Acme Agents: $0.0555 charged for 37 Listing records'],
        [t(4), 'TOPUP_COMPLETED', false, 'Acme Agents added $20 via PayPal'],
        [t(3), 'DATASET_PUBLISHED', false, 'Listing published · 2,341 records live'],
        [t(2), 'SCHEMA_PROPOSED', false, 'Proposal ready: Listing · 2,341 records'],
        [t(1), 'CRAWL_RUN_DONE', false, 'Crawl finished · 2,341 pages, 2,341 records changed'],
      ]);
      expect(JSON.stringify(res.body)).not.toContain(q.id);

      // B sees its own call and payout, not A's.
      const other = await activity(q.cookie);
      expect((other.body.events as { action: string }[]).map((e) => e.action)).toEqual([
        'TOPUP_COMPLETED',
        'PAYOUT_SENT',
        'CALL_CHARGED',
      ]);

      const limited = await activity(p.cookie, { limit: '2' });
      expect((limited.body.events as { action: string }[]).map((e) => e.action)).toEqual([
        'PAYOUT_SETTLED',
        'PAYOUT_SENT',
      ]);
    });

    it('defaults to 50, rejects a bad limit, and needs a session', async () => {
      expect(cases.map((c) => c.url)).toContain('/api/publishers/me/activity');
      expect((await activity(null)).status).toBe(401);
      const bad = await activity(a.cookie, { limit: '0' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
      expect((await activity(a.cookie, { limit: '201' })).status).toBe(400);

      for (let i = 0; i < 55; i++) {
        await addAudit({
          at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
          action: 'CRAWL_RUN_DONE',
          publisherId: a.id,
        });
      }
      const res = await activity(a.cookie);
      expect(res.body.events).toHaveLength(50);
      expect(res.body.events[0].at).toBe(new Date(Date.UTC(2026, 10, 1, 0, 54)).toISOString());
    });
  });
});
