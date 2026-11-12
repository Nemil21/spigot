import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  gatePolicySchema,
  parsePublisherEvent,
  PUBLISHER_EVENTS_CHANNEL,
  type GateHitBucket,
} from '@spigot/shared';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { drainNotifications, testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { cases } from '../security/tenancy/gate.cases.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';
import { authenticateGate } from './gateAuth.js';
import { recordHits } from './hits.js';
import { bumpPolicyVersion } from './policy.js';

/**
 * SP-008b integration (ticket §Test plan): policy shape (zod), hits upsert, rate limit and
 * cross-site isolation, through the real routes and Postgres. Datasets are fixture rows (SP-014a's
 * approve path isn't merged yet); unpublish is the status change plus `bumpPolicyVersion`, the
 * same pair SP-014a runs in one transaction.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

const bucket = (over: Partial<GateHitBucket> = {}): GateHitBucket => ({
  bucket: '2026-11-11T17:42:00Z',
  category: 'AI_TRAINING',
  botName: 'GPTBot',
  decision: 'QUOTE_402',
  hits: 41,
  bytes: 0,
  isSimulated: false,
  ...over,
});
const hitsBody = (buckets: GateHitBucket[]) => ({ sentAt: new Date().toISOString(), buckets });

interface Site {
  id: string;
  publisherId: string;
  slug: string;
  gateKey: string;
  crawlKeyHash: string;
  cookie: string;
}

describe.skipIf(!testDatabaseUrl)('SP-008b gate endpoints (Postgres)', () => {
  let pools: TwoPools;
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pools = await twoPools();
    pool = pools.a;
    app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: pools.db.url }), {
      logStream: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await pools?.close();
  });
  beforeEach(() => app.rateLimiter.reset());

  const agent = () => request(app.server);
  const policy = (key: string | null, etag?: string) => {
    const r = agent().get('/api/gate/policy');
    if (key) r.set('Authorization', `Bearer ${key}`);
    if (etag) r.set('If-None-Match', etag);
    return r;
  };
  const postHits = (key: string, body: unknown) =>
    agent()
      .post('/api/gate/hits')
      .set('Authorization', `Bearer ${key}`)
      .send(body as object);
  const gateStatus = (siteId: string, cookie: string) =>
    agent().get(`/api/sites/${siteId}/gate-status`).set('Cookie', cookie);

  /** A publisher (through signup) with one site; the site row is a fixture with fresh keys. */
  async function newSite(policyOverride?: Record<string, unknown>): Promise<Site> {
    const res = await agent()
      .post('/api/auth/signup')
      .set('Origin', APP_ORIGIN)
      .send({
        name: 'Bluebonnet',
        email: `p-${randomUUID()}@example.com`,
        password: 'correct horse',
        payoutEmail: 'payouts@example.com',
      });
    expect(res.status).toBe(201);
    const id = randomUUID();
    const slug = `site-${id.slice(0, 8)}`;
    const s = generateSiteSecrets(id, SECRET);
    await pool.query(
      `INSERT INTO sites (id, publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash,
                          status, policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY',
               COALESCE($8::jsonb, '{"SEARCH":"PASS","AI_TRAINING":"QUOTE","AI_AGENT":"QUOTE","SCRAPER_TOOL":"QUOTE","UNKNOWN":"PASS","gated_paths":[]}'))`,
      [
        id,
        res.body.publisherId,
        `https://${slug}.example.com`,
        slug,
        s.verifyToken,
        s.crawlKeyHash,
        s.gateKeyHash,
        policyOverride ? JSON.stringify(policyOverride) : null,
      ],
    );
    return {
      id,
      publisherId: res.body.publisherId,
      slug,
      gateKey: s.gateKey,
      crawlKeyHash: s.crawlKeyHash,
      cookie: cookiesOf(res),
    };
  }

  /** Fixture template + dataset rows (SP-010 pattern shape, SP-014a status). */
  async function addDataset(
    siteId: string,
    slug: string,
    urlPattern: string,
    status: string,
    priceMicros = 1500,
  ): Promise<string> {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO templates (site_id, url_pattern, page_count) VALUES ($1, $2, 100) RETURNING id`,
      [siteId, urlPattern],
    );
    const d = await pool.query<{ id: string }>(
      `INSERT INTO datasets (site_id, template_id, slug, type_name, status, price_per_record_micros)
       VALUES ($1, $2, $3, 'Listing', $4, $5) RETURNING id`,
      [siteId, t.rows[0]!.id, slug, status, priceMicros],
    );
    return d.rows[0]!.id;
  }

  const hitRows = async (siteId: string) =>
    (
      await pool.query(
        `SELECT category, bot_name, decision, is_simulated, hits, bytes::int AS bytes
           FROM bot_hits WHERE site_id = $1 ORDER BY is_simulated, bot_name, decision`,
        [siteId],
      )
    ).rows;
  const lastSeen = async (siteId: string) =>
    (await pool.query('SELECT last_gate_seen_at FROM sites WHERE id = $1', [siteId])).rows[0]!
      .last_gate_seen_at as Date | null;

  describe('GET /api/gate/policy', () => {
    it('returns the api.md shape (zod), with ETag = policyVersion and 304 on a match', async () => {
      const site = await newSite({
        SEARCH: 'PASS',
        AI_TRAINING: 'QUOTE',
        AI_AGENT: 'PASS',
        SCRAPER_TOOL: 'QUOTE',
        UNKNOWN: 'PASS',
        gated_paths: ['^/members/', '(bad'],
      });
      await addDataset(site.id, 'listings', '^/listings/[a-z0-9-]+$', 'LIVE', 1500);
      await addDataset(site.id, 'agents', '^/agents/[0-9]+$', 'LIVE_STALE', 2000);
      await addDataset(site.id, 'open-houses', '^/open-houses/[a-z0-9-]+$', 'PROPOSED');

      const res = await policy(site.gateKey);
      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe('"1"');
      const body = gatePolicySchema.parse(res.body);
      expect(body).toEqual({
        siteId: site.id,
        policyVersion: 1,
        apiBase: `${APP_ORIGIN}/v1/${site.slug}`,
        catalogUrl: `${APP_ORIGIN}/c/${site.slug}`,
        crawlKeySha256: site.crawlKeyHash,
        // Sold datasets' sections, then the site's own valid regexes; PROPOSED isn't gated.
        gatedPaths: ['^/agents/', '^/listings/', '^/members/'],
        decisions: {
          SEARCH: 'PASS',
          AI_TRAINING: 'QUOTE',
          AI_AGENT: 'PASS',
          SCRAPER_TOOL: 'QUOTE',
          UNKNOWN: 'PASS',
        },
        prices: [
          { dataset: 'agents', perRecordMicros: 2000, display: '$2.00 / 1,000 records' },
          { dataset: 'listings', perRecordMicros: 1500, display: '$1.50 / 1,000 records' },
        ],
      });

      const cached = await policy(site.gateKey, '"1"');
      expect(cached.status).toBe(304);
      expect(cached.text).toBe('');
    });

    it('refuses a missing, malformed or unknown gate key with 401', async () => {
      const site = await newSite();
      const crawlKey = 'ck_' + 'a'.repeat(43);
      for (const auth of [null, 'gk_short', `gk_${'x'.repeat(43)}`, crawlKey]) {
        const res = await policy(auth);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
      const raw = await agent().get('/api/gate/policy').set('Authorization', site.gateKey);
      expect(raw.status).toBe(401);
    });

    it("site A's gate key can't read site B's policy", async () => {
      const a = await newSite();
      const b = await newSite();
      await addDataset(b.id, 'listings', '^/listings/[a-z0-9-]+$', 'LIVE', 9999);

      const res = await policy(a.gateKey).query({ siteId: b.id });
      expect(res.status).toBe(200);
      expect(res.body.siteId).toBe(a.id);
      expect(res.body.crawlKeySha256).toBe(a.crawlKeyHash);
      expect(res.body.gatedPaths).toEqual([]);
      expect(res.body.prices).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(b.id);

      const resB = await policy(b.gateKey);
      expect(resB.body.siteId).toBe(b.id);
      expect(resB.body.gatedPaths).toEqual(['^/listings/']);
    });

    it('bumpPolicyVersion changes the version and the response; unpublish removes ^/listings/', async () => {
      const site = await newSite();
      const datasetId = await addDataset(site.id, 'listings', '^/listings/[a-z0-9-]+$', 'PROPOSED');

      const before = await policy(site.gateKey);
      expect(before.body.gatedPaths).toEqual([]);

      // Approve (SP-014a's pair: status + bump in one transaction).
      const v2 = await app.db.tx(async (tx) => {
        await tx.query(`UPDATE datasets SET status = 'LIVE' WHERE id = $1`, [datasetId]);
        return bumpPolicyVersion(tx, site.id);
      });
      expect(v2).toBe(2);
      expect((await policy(site.gateKey, '"1"')).status).toBe(200);
      const live = await policy(site.gateKey);
      expect(live.headers.etag).toBe('"2"');
      expect(live.body.policyVersion).toBe(2);
      expect(live.body.gatedPaths).toContain('^/listings/');
      expect(live.body.prices).toEqual([expect.objectContaining({ dataset: 'listings' })]);
      expect((await policy(site.gateKey, '"2"')).status).toBe(304);

      // Unpublish.
      const v3 = await app.db.tx(async (tx) => {
        await tx.query(`UPDATE datasets SET status = 'UNPUBLISHED' WHERE id = $1`, [datasetId]);
        return bumpPolicyVersion(tx, site.id);
      });
      expect(v3).toBe(3);
      expect((await policy(site.gateKey, '"2"')).status).toBe(200);
      const after = await policy(site.gateKey);
      expect(after.body.policyVersion).toBe(3);
      expect(after.body.gatedPaths).not.toContain('^/listings/');
      expect(after.body.prices).toEqual([]);

      // A bump rolled back with its transaction doesn't change the version.
      await expect(
        app.db.tx(async (tx) => {
          await bumpPolicyVersion(tx, site.id);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await policy(site.gateKey)).body.policyVersion).toBe(3);
      await expect(app.db.tx((tx) => bumpPolicyVersion(tx, randomUUID()))).rejects.toThrow(
        /no site/,
      );
    });
  });

  describe('POST /api/gate/hits', () => {
    it('upserts and sums the same bucket/key across posts; SIM never merges with real', async () => {
      const site = await newSite();
      expect(await lastSeen(site.id)).toBeNull();

      const first = await postHits(
        site.gateKey,
        hitsBody([
          bucket({ hits: 41 }),
          bucket({ hits: 7, isSimulated: true }),
          bucket({ category: 'HUMAN', botName: '-', decision: 'PASS', hits: 300, bytes: 9000 }),
        ]),
      );
      expect(first.status).toBe(204);
      expect(first.text).toBe('');
      expect(await lastSeen(site.id)).toBeInstanceOf(Date);

      app.rateLimiter.reset();
      const second = await postHits(
        site.gateKey,
        hitsBody([
          bucket({ hits: 9 }),
          bucket({ hits: 1 }), // repeated key within one post
          bucket({ category: 'HUMAN', botName: '-', decision: 'PASS', hits: 20, bytes: 1000 }),
        ]),
      );
      expect(second.status).toBe(204);

      expect(await hitRows(site.id)).toEqual([
        {
          category: 'HUMAN',
          bot_name: '-',
          decision: 'PASS',
          is_simulated: false,
          hits: 320,
          bytes: 10000,
        },
        {
          category: 'AI_TRAINING',
          bot_name: 'GPTBot',
          decision: 'QUOTE_402',
          is_simulated: false,
          hits: 51,
          bytes: 0,
        },
        {
          category: 'AI_TRAINING',
          bot_name: 'GPTBot',
          decision: 'QUOTE_402',
          is_simulated: true,
          hits: 7,
          bytes: 0,
        },
      ]);
    });

    it('a post within 5 s of the previous one → 429 with Retry-After; nothing is written', async () => {
      const site = await newSite();
      const other = await newSite();
      expect((await postHits(site.gateKey, hitsBody([bucket({ hits: 1 })]))).status).toBe(204);

      const again = await postHits(site.gateKey, hitsBody([bucket({ hits: 100 })]));
      expect(again.status).toBe(429);
      expect(again.body.error.code).toBe('RATE_LIMITED');
      expect(Number(again.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(5);
      expect((await hitRows(site.id))[0]).toMatchObject({ hits: 1 });

      // The limit is per site.
      expect((await postHits(other.gateKey, hitsBody([bucket()]))).status).toBe(204);
    });

    it("site A's gate key only writes site A", async () => {
      const a = await newSite();
      const b = await newSite();
      const res = await postHits(a.gateKey, { ...hitsBody([bucket()]), siteId: b.id });
      expect(res.status).toBe(204);
      expect(await hitRows(a.id)).toHaveLength(1);
      expect(await hitRows(b.id)).toEqual([]);
      expect(await lastSeen(b.id)).toBeNull();
    });

    it('validates with the shared schema: isSimulated required, minute buckets, known enums', async () => {
      const site = await newSite();
      const { isSimulated: _drop, ...noSim } = bucket();
      for (const bad of [
        { sentAt: new Date().toISOString(), buckets: [noSim] },
        hitsBody([bucket({ bucket: '2026-11-11T17:42:30Z' })]),
        hitsBody([bucket({ category: 'ROBOT' as never })]),
        hitsBody([bucket({ hits: 0 })]),
        { buckets: [bucket()] },
      ]) {
        app.rateLimiter.reset();
        const res = await postHits(site.gateKey, bad);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await hitRows(site.id)).toEqual([]);
      expect(await lastSeen(site.id)).toBeNull();
    });

    it('refuses a body over 1 MB, and posts without a gate key', async () => {
      const site = await newSite();
      const big = hitsBody(
        Array.from({ length: 9_000 }, (_, i) => bucket({ botName: `bot-${'x'.repeat(60)}-${i}` })),
      );
      expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(1_048_576);
      const res = await postHits(site.gateKey, big);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await hitRows(site.id)).toEqual([]);

      const anon = await agent()
        .post('/api/gate/hits')
        .send(hitsBody([bucket()]));
      expect(anon.status).toBe(401);
    });

    it('accepts a 7-day backfill page of several thousand buckets in one post', async () => {
      const site = await newSite();
      const start = Date.UTC(2026, 10, 4, 0, 0);
      const buckets = Array.from({ length: 5_000 }, (_, i) =>
        bucket({ bucket: new Date(start + i * 60_000).toISOString(), hits: 2, isSimulated: true }),
      );
      expect((await postHits(site.gateKey, hitsBody(buckets))).status).toBe(204);
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n, sum(hits)::int AS hits FROM bot_hits WHERE site_id = $1',
        [site.id],
      );
      expect(rows[0]).toEqual({ n: 5_000, hits: 10_000 });
    });

    it("notifies publisher_events { type: 'hits' } for the site's publisher", async () => {
      const site = await newSite();
      const listener = new pg.Client({ connectionString: pools.db.url });
      await listener.connect();
      const events: unknown[] = [];
      listener.on('notification', (n) => {
        const e =
          n.channel === PUBLISHER_EVENTS_CHANNEL ? parsePublisherEvent(n.payload ?? '') : null;
        if (e?.publisherId === site.publisherId) events.push(e);
      });
      await listener.query(`LISTEN ${PUBLISHER_EVENTS_CHANNEL}`);
      try {
        expect((await postHits(site.gateKey, hitsBody([bucket()]))).status).toBe(204);
        await drainNotifications(listener, pool);
        expect(events).toEqual([
          expect.objectContaining({ type: 'hits', publisherId: site.publisherId, ids: [site.id] }),
        ]);
      } finally {
        await listener.end();
      }
    });

    it('concurrent posts from two API processes to the same key sum exactly', async () => {
      const site = await newSite();
      const gate = await authenticateGate(pools.a, `Bearer ${site.gateKey}`);
      const dbs = [createDb(pools.a), createDb(pools.b)];
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          recordHits(dbs[i % 2]!, gate, hitsBody([bucket({ hits: 3, bytes: 2 })])),
        ),
      );
      expect(await hitRows(site.id)).toEqual([
        expect.objectContaining({ is_simulated: false, hits: 60, bytes: 40 }),
      ]);
    });
  });

  describe('GET /api/sites/:id/gate-status', () => {
    it('installed = a hit post in the last 10 minutes', async () => {
      const site = await newSite();
      const none = await gateStatus(site.id, site.cookie);
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ installed: false, lastSeenAt: null, policyVersion: 1 });

      // A policy fetch alone isn't a hit post (data-model: last_gate_seen_at = last hit-count post).
      await policy(site.gateKey);
      expect((await gateStatus(site.id, site.cookie)).body.installed).toBe(false);

      await postHits(site.gateKey, hitsBody([bucket()]));
      const seen = await gateStatus(site.id, site.cookie);
      expect(seen.body.installed).toBe(true);
      expect(new Date(seen.body.lastSeenAt).getTime()).toBe((await lastSeen(site.id))!.getTime());

      await pool.query(
        `UPDATE sites SET last_gate_seen_at = now() - interval '11 minutes' WHERE id = $1`,
        [site.id],
      );
      const stale = await gateStatus(site.id, site.cookie);
      expect(stale.body.installed).toBe(false);
      expect(stale.body.lastSeenAt).not.toBeNull();
    });

    it("tenancy: B's site id → 404; no session → 401", async () => {
      const a = await newSite();
      const b = await newSite();
      const res = await gateStatus(b.id, a.cookie);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect((await gateStatus('not-a-uuid', a.cookie)).status).toBe(404);
      expect((await agent().get(`/api/sites/${a.id}/gate-status`)).status).toBe(401);
    });
  });

  it('declares a tenancy case for every gate route', () => {
    const routes = cases.map((c) => `${c.method} ${c.url}`).sort();
    expect(routes).toEqual([
      'GET /api/gate/policy',
      'GET /api/sites/:id/gate-status',
      'POST /api/gate/hits',
    ]);
  });
});
