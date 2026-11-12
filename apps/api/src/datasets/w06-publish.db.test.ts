import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { createDb, createPool, type Db } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { createRecordedModel } from '../schema-agent/claude.js';
import { proposeForSite } from '../schema-agent/propose.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { demoSite } from '../test/schema-agent/demoPages.js';

/**
 * SP-029 (W06) against the merged SP-014a / SP-014b: the exact request sequence the dataset editor
 * sends on Publish, over HTTP with a publisher session. Load → PATCH (hide a field, odd price) →
 * approve the version the PATCH returned → poll the site's crawl runs until the APPROVE run ends
 * (the editor's progress card) → a buyer's records call no longer contains the hidden field and is
 * charged at the new price.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const ORIGIN = 'https://bluebonnet-w06.example';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!testDatabaseUrl)('SP-029 W06 publish sequence (Postgres)', () => {
  let tdb: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let app: FastifyInstance;
  let cookie: string;
  let siteId: string;
  let listings: string;

  const send = (method: 'get' | 'post' | 'patch', url: string, body?: object) => {
    const r = request(app.server)[method](url).set('Origin', APP_ORIGIN).set('Cookie', cookie);
    return body === undefined ? r : r.send(body);
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    pool = createPool(tdb.url, { max: 4, applicationName: 'w06-test' });
    db = createDb(pool);
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: tdb.url, SCHEMA_AGENT_MODE: 'recorded' }),
      { logStream: new Writable({ write: (_c, _e, cb) => cb() }) },
    );
    await app.ready();

    const signup = await request(app.server)
      .post('/api/auth/signup')
      .set('Origin', APP_ORIGIN)
      .send({
        name: 'Bluebonnet',
        email: `w06-${randomUUID()}@example.com`,
        password: 'correct horse',
        payoutEmail: 'payouts@example.com',
      });
    expect(signup.status).toBe(201);
    const set = signup.headers['set-cookie'] as unknown as string[];
    cookie = set.map((c) => c.split(';', 1)[0]).join('; ');
    const publisherId = signup.body.publisherId as string;

    // A crawled site: the demo pages' snapshots, then the recorded (no model call) proposal.
    const pages = (await demoSite(0.05)).pages;
    siteId = (
      await pool.query<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
         VALUES ($1, $2, 'bluebonnet', 'v', 'c', 'g', 'PROPOSING') RETURNING id`,
        [publisherId, ORIGIN],
      )
    ).rows[0]!.id;
    const run = (
      await pool.query<{ id: string }>(
        `INSERT INTO crawl_runs (site_id, trigger, status, started_at, finished_at)
         VALUES ($1, 'CONNECT', 'SUCCEEDED', now(), now()) RETURNING id`,
        [siteId],
      )
    ).rows[0]!;
    await pool.query(
      `WITH p AS (
         INSERT INTO pages (site_id, url, last_status, fetched_at)
         SELECT $1, u.url, 200, now() FROM unnest($2::text[]) AS u(url)
         RETURNING id, url)
       INSERT INTO snapshots (page_id, http_status, html_gz, bytes)
       SELECT p.id, 200, h.gz, length(h.gz) FROM p
         JOIN unnest($2::text[], $3::bytea[]) AS h(url, gz) ON h.url = p.url`,
      [siteId, pages.map((p) => ORIGIN + p.path), pages.map((p) => gzipSync(p.html))],
    );
    const proposed = await proposeForSite({ db, model: createRecordedModel() }, siteId, {
      trigger: 'DISCOVERY',
      runId: run.id,
    });
    expect(proposed.status).toBe('done');
    listings = (
      await pool.query<{ id: string }>(
        `SELECT id FROM datasets WHERE site_id = $1 AND slug = 'listings'`,
        [siteId],
      )
    ).rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await tdb?.drop();
  });

  it('hide a field + odd price → Publish → APPROVE run ends → the buyer API omits the field', async () => {
    // 1. W06 loads the proposal.
    const loaded = await send('get', `/api/datasets/${listings}`);
    expect(loaded.status).toBe(200);
    expect(loaded.body.status).toBe('PROPOSED');
    const fields = loaded.body.fields as { name: string; visible: boolean }[];
    const hide =
      fields.find((f) => f.visible && f.name === 'agent_name') ??
      fields.find((f) => f.visible && f.name !== 'title')!;
    expect(hide).toBeDefined();
    expect(loaded.body.sampleRows.length).toBeGreaterThan(0);

    // 2. Publish: PATCH only what changed.
    const patched = await send('patch', `/api/datasets/${listings}`, {
      fields: [{ name: hide.name, visible: false }],
      perRecordMicros: 1537,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.dataset.perRecordMicros).toBe(1537);
    const versionId = patched.body.schemaVersion.id as string;
    expect(patched.body.schemaVersion.proposedBy).toBe('OWNER');

    // A retry of the same PATCH (W06 re-diffs against its moved baseline, but a stale client
    // might resend) makes no further version.
    const again = await send('patch', `/api/datasets/${listings}`, {
      fields: [{ name: hide.name, visible: false }],
    });
    expect(again.status).toBe(200);
    expect(again.body.schemaVersion).toBeNull();

    // 3. Approve the version the PATCH returned; rights unticked is a 400 first.
    const noRights = await send('post', `/api/datasets/${listings}/approve`, {
      schemaVersionId: versionId,
    });
    expect(noRights.status).toBe(400);
    const approved = await send('post', `/api/datasets/${listings}/approve`, {
      schemaVersionId: versionId,
      rightsAttested: true,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'LIVE',
      endpoint: `${APP_ORIGIN}/v1/bluebonnet/datasets/listings/records`,
    });
    const runId = approved.body.crawlRunId as string;

    // A double-click's second approve is refused, not applied twice.
    const twice = await send('post', `/api/datasets/${listings}/approve`, {
      schemaVersionId: versionId,
      rightsAttested: true,
    });
    expect(twice.status).toBe(409);

    // 4. W06's progress card: the run, read from the site's crawl runs, until it ends.
    let run:
      | { id: string; status: string; trigger: string; pagesTotal: number; pagesFetched: number }
      | undefined;
    const t0 = Date.now();
    for (;;) {
      const runs = await send('get', `/api/sites/${siteId}/crawl-runs?limit=20`);
      expect(runs.status).toBe(200);
      run = (runs.body.runs as NonNullable<typeof run>[]).find((r) => r.id === runId);
      expect(run).toBeDefined();
      if (run!.status === 'SUCCEEDED' || run!.status === 'FAILED') break;
      if (Date.now() - t0 > 60_000) throw new Error('APPROVE run did not end');
      await sleep(50);
    }
    expect(run!.status).toBe('SUCCEEDED');
    expect(run!.trigger).toBe('APPROVE');
    expect(run!.pagesFetched).toBe(run!.pagesTotal);

    // 5. W06 reloads: LIVE, the field still hidden.
    const live = await send('get', `/api/datasets/${listings}`);
    expect(live.body.status).toBe('LIVE');
    expect(
      (live.body.fields as { name: string; visible: boolean }[]).find((f) => f.name === hide.name),
    ).toMatchObject({ visible: false });

    // 6. A buyer: the hidden field is gone from the schema and every record; the new price applies.
    const buyerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO buyers (name, per_call_max_micros) VALUES ('W06 buyer', 1000000) RETURNING id`,
      )
    ).rows[0]!.id;
    const { key } = await createKey(app.db.pool, buyerId, { scopes: ['read'] });
    await app.db.tx(async (tx) => {
      const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyerId);
      const { paypalCash } = await platformAccounts(tx);
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer, paypalCash }, 5_000_000),
      });
    });
    const auth = { Authorization: `Bearer ${key}` };

    const schema = await request(app.server).get('/v1/bluebonnet/datasets/listings').set(auth);
    expect(schema.status, JSON.stringify(schema.body)).toBe(200);
    expect(JSON.stringify(schema.body)).not.toContain(`"${hide.name}"`);

    const recs = await request(app.server)
      .get('/v1/bluebonnet/datasets/listings/records?limit=5')
      .set(auth);
    expect(recs.status, JSON.stringify(recs.body)).toBe(200);
    const records = recs.body.records as { data: Record<string, unknown> }[];
    expect(records.length).toBe(5);
    for (const r of records) expect(r.data).not.toHaveProperty(hide.name);
    expect(recs.body.charged).toMatchObject({ records: 5, priceMicros: 5 * 1537 });
  }, 120_000);
});
