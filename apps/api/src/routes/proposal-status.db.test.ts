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
import { cases } from '../security/tenancy/proposal-status.cases.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';
import { demoSite } from '../test/schema-agent/demoPages.js';

/**
 * SP-028: W05's progress read through the real route. The proposal run is SP-012a's recorded
 * model on the demo site's snapshots, so "reading" → proposals + skipped templates is the real
 * sequence the screen shows.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface StatusBody {
  siteStatus: string;
  crawling: boolean;
  running: boolean;
  templates: { pattern: string; pageCount: number; state: string }[];
  message: string | null;
}

describe.skipIf(!testDatabaseUrl)('SP-028 GET /api/sites/:id/proposal-status (Postgres)', () => {
  let pools: TwoPools;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let a: { id: string; cookie: string };
  let b: { id: string; cookie: string };
  let site: { id: string; origin: string };

  const agent = () => request(app.server);
  const status = async (siteId: string, cookie: string | null) => {
    const r = agent().get(`/api/sites/${siteId}/proposal-status`);
    if (cookie) r.set('Cookie', cookie);
    return r;
  };

  async function newPublisher(name: string) {
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
    return { id: res.body.publisherId as string, cookie: cookiesOf(res) };
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
    return { id, origin: `https://${slug}.example.com` };
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
    site = await newSite(a.id, 'VERIFIED');
  });

  afterAll(async () => {
    await app?.close();
    await pools?.close();
  });

  it('lists the tenancy cases it runs', () => {
    expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/sites/:id/proposal-status',
    ]);
  });

  it("another publisher's site → 404; no session → 401", async () => {
    const r = await status(site.id, b.cookie);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(r.body)).not.toContain('pattern');
    expect((await status(site.id, null)).status).toBe(401);
  });

  it('discovery crawl → proposing (reading templates) → done with skipped templates', async () => {
    // 1. The discovery crawl is running.
    const run = await pool.query<{ id: string }>(
      `INSERT INTO crawl_runs (site_id, trigger, status, started_at)
       VALUES ($1, 'CONNECT', 'RUNNING', now()) RETURNING id`,
      [site.id],
    );
    let r = await status(site.id, a.cookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      siteStatus: 'VERIFIED',
      crawling: true,
      running: false,
      templates: [],
      message: null,
    } satisfies StatusBody);

    // 2. Crawl done, site PROPOSING, the agent hasn't written anything yet.
    const pages = (await demoSite(1)).pages;
    for (let i = 0; i < pages.length; i += 500) {
      const batch = pages.slice(i, i + 500);
      await pool.query(
        `WITH p AS (
           INSERT INTO pages (site_id, url, last_status, fetched_at)
           SELECT $1, u.url, 200, now() FROM unnest($2::text[]) AS u(url)
           RETURNING id, url)
         INSERT INTO snapshots (page_id, http_status, html_gz, bytes)
         SELECT p.id, 200, h.gz, length(h.gz) FROM p
           JOIN unnest($2::text[], $3::bytea[]) AS h(url, gz) ON h.url = p.url`,
        [site.id, batch.map((p) => site.origin + p.path), batch.map((p) => gzipSync(p.html))],
      );
    }
    await pool.query(
      `UPDATE crawl_runs SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1`,
      [run.rows[0]!.id],
    );
    await pool.query(`UPDATE sites SET status = 'PROPOSING' WHERE id = $1`, [site.id]);
    r = await status(site.id, a.cookie);
    expect(r.body).toMatchObject({ siteStatus: 'PROPOSING', crawling: false, running: true });

    // 3. The agent finishes: 3 proposals, the rest skipped (no repeated structure / no fields).
    const result = await proposeForSite(
      { db: createDb(pool), model: createRecordedModel() },
      site.id,
      { trigger: 'DISCOVERY' },
    );
    expect(result.templates.filter((t) => t.status === 'proposed')).toHaveLength(3);
    r = await status(site.id, a.cookie);
    const body = r.body as StatusBody;
    expect(body).toMatchObject({ siteStatus: 'READY', running: false, message: null });
    const unproductive = result.templates.filter((t) =>
      ['rejected', 'skipped', 'failed'].includes(t.status),
    );
    expect(body.templates).toEqual(
      unproductive.map((t) => ({
        pattern: t.pathPattern,
        pageCount: t.pageCount,
        state: t.status === 'failed' ? 'failed' : 'skipped',
      })),
    );
    // Display patterns, never the stored regex; no model error text leaks.
    for (const t of body.templates) expect(t.pattern.startsWith('^')).toBe(false);
    expect(Object.keys(body.templates[0] ?? {}).sort()).toEqual(
      body.templates.length ? ['pageCount', 'pattern', 'state'] : [],
    );

    // 4. A new run starts (resume): templates without a dataset are "reading" again.
    await pool.query(
      `INSERT INTO audit_events (actor_type, publisher_id, entity, entity_id, action, data)
       VALUES ('SCHEMA_AGENT', $1, 'sites', $2, 'SCHEMA_PROPOSAL_STARTED', '{}')`,
      [a.id, site.id],
    );
    r = await status(site.id, a.cookie);
    expect(r.body.running).toBe(true);
    const reading = (r.body as StatusBody).templates;
    expect(reading.every((t) => t.state === 'reading')).toBe(true);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM templates t WHERE t.site_id = $1
          AND NOT EXISTS (SELECT 1 FROM datasets d WHERE d.template_id = t.id)`,
      [site.id],
    );
    expect(reading).toHaveLength(Number(rows[0]!.n));

    // 5. A STARTED row older than 10 minutes with no DONE is a crashed run, not a running one.
    // (audit_events is append-only, so this is a newer row with an old `at`.)
    await pool.query(
      `INSERT INTO audit_events (at, actor_type, publisher_id, entity, entity_id, action, data)
       VALUES (now() - interval '11 minutes', 'SCHEMA_AGENT', $1, 'sites', $2,
               'SCHEMA_PROPOSAL_STARTED', '{}')`,
      [a.id, site.id],
    );
    r = await status(site.id, a.cookie);
    expect(r.body.running).toBe(false);
  }, 60_000);
});
