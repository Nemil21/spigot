import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp } from '../../../demo-site/src/app.js';
import { openStore, type Store } from '../../../demo-site/src/data/store.js';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { resetHostQueues } from '../crawl/queue.js';
import { createPool } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-048c acceptance through the real API, crawler and demo site (DEMO_SEED_SCALE=0.05, the
 * recorded Listing proposal):
 * - fetch listings → `demo:mutate` leases one (no crawl) → claim STALE → the targeted re-fetch
 *   sees it → AUTO_CREDITED, CREDIT posted, publisher payable reduced, `status` in the feed;
 * - a STALE claim on an unchanged listing stays OPEN and writes no version; a second claim on
 *   it within 10 minutes reuses the re-fetch;
 * - `report_bad_record` over MCP returns the claim status and credit;
 * - race: the same STALE claim from MCP and REST at once → one re-fetch, one claim, one CREDIT.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'PAUSED'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Text = { type: 'text'; text: string };
interface ClaimStructured {
  claimId: string;
  status: string;
  creditMicros: number;
}

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)(
  'SP-048c STALE / REMOVED claims re-fetch + MCP report_bad_record (Postgres + demo site)',
  { timeout: 180_000 },
  () => {
    let tdb: TestDatabase;
    let pool: pg.Pool;
    let app: FastifyInstance;
    let dataDir: string;
    let store: Store;
    let origin: string;
    let originServer: Server;
    let verifyToken: string | undefined;
    let mcpUrl: string;
    const clients: Client[] = [];
    const prevGap = process.env.CRAWL_MIN_GAP_MS;
    let world: { siteSlug: string; datasetId: string; publisherId: string; path: string };

    beforeAll(async () => {
      tdb = await createTestDatabase();
      pool = createPool(tdb.url, { max: 4, applicationName: 'claims-refetch-test' });
      dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp048c-'));
      store = await openStore({ dataDir, scale: 0.05 });
      const quiet = createAccessLog(() => {});
      originServer = createServer((req, res) =>
        createApp({ store, accessLog: quiet, verifyToken })(req, res),
      );
      origin = await new Promise((resolve) =>
        originServer.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(originServer.address() as AddressInfo).port}`),
        ),
      );
      process.env.CRAWL_MIN_GAP_MS = '0';
      app = await buildServer(
        loadConfig({
          ...REQUIRED_ENV,
          DATABASE_URL: tdb.url,
          ALLOW_LOCAL_ORIGINS: 'true',
          CRAWL_MIN_GAP_MS: '0',
          SCHEMA_AGENT_MODE: 'recorded',
        }),
        { logStream: new Writable({ write: (_c, _e, cb) => cb() }) },
      );
      await app.listen({ port: 0, host: '127.0.0.1' });
      mcpUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
      world = await liveListingDataset();
    }, 120_000);
    afterAll(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await app?.close();
      if (prevGap === undefined) delete process.env.CRAWL_MIN_GAP_MS;
      else process.env.CRAWL_MIN_GAP_MS = prevGap;
      if (originServer) await new Promise<void>((r) => originServer.close(() => r()));
      await pool?.end();
      await tdb?.drop();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    });
    beforeEach(() => {
      app.rateLimiter.reset();
      resetHostQueues();
    });

    const send = (url: string, cookie: string, body?: object) => {
      const r = request(app.server).post(url).set('Origin', APP_ORIGIN).set('Cookie', cookie);
      return body === undefined ? r : r.send(body);
    };
    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows as T[];
    const one = async <T>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0]!;

    async function waitForRun(runId: string, timeoutMs = 120_000) {
      const t0 = Date.now();
      for (;;) {
        const r = await one<{ status: string }>('SELECT status FROM crawl_runs WHERE id = $1', [
          runId,
        ]);
        if (TERMINAL.includes(r.status)) return r;
        if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} did not end`);
        await sleep(25);
      }
    }

    /** Sign up, connect + verify the demo site, approve the recorded Listing proposal. */
    async function liveListingDataset() {
      const res = await send('/api/auth/signup', '', {
        name: 'Bluebonnet',
        email: `p-${randomUUID()}@example.com`,
        password: 'correct horse',
        payoutEmail: 'payouts@example.com',
      });
      expect(res.status).toBe(201);
      const cookie = cookiesOf(res);
      const created = await send('/api/sites', cookie, { origin });
      expect(created.status).toBe(201);
      const siteId = created.body.siteId as string;
      verifyToken = created.body.verify.content;
      expect((await send(`/api/sites/${siteId}/verify`, cookie)).status).toBe(200);
      let datasetId: string | undefined;
      const t0 = Date.now();
      while (!datasetId) {
        const ds = (
          await q<{ id: string }>(
            `SELECT d.id FROM datasets d JOIN sites s ON s.id = d.site_id
              WHERE d.site_id = $1 AND d.slug = 'listings' AND d.status = 'PROPOSED' AND s.status = 'READY'`,
            [siteId],
          )
        )[0];
        datasetId = ds?.id;
        if (Date.now() - t0 > 60_000) throw new Error('no Listing proposal');
        if (!datasetId) await sleep(50);
      }
      const sv = await one<{ id: string }>(
        'SELECT id FROM schema_versions WHERE dataset_id = $1 ORDER BY version DESC LIMIT 1',
        [datasetId],
      );
      const approved = await send(`/api/datasets/${datasetId}/approve`, cookie, {
        schemaVersionId: sv.id,
        rightsAttested: true,
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await waitForRun(approved.body.crawlRunId)).status).toBe('SUCCEEDED');
      const site = await one<{ slug: string; publisherId: string }>(
        'SELECT slug, publisher_id AS "publisherId" FROM sites WHERE id = $1',
        [siteId],
      );
      return {
        siteSlug: site.slug,
        datasetId,
        publisherId: site.publisherId,
        path: `/v1/${site.slug}/datasets/listings`,
      };
    }

    async function newBuyer(micros = 5_000_000) {
      const [b] = await q<{ id: string }>(`INSERT INTO buyers (name) VALUES ($1) RETURNING id`, [
        `Buyer ${randomUUID().slice(0, 8)}`,
      ]);
      const k = await createKey(pool, b!.id, { scopes: ['read'] });
      await app.db.tx(async (tx) => {
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', b!.id);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash }, micros),
        });
      });
      return { buyerId: b!.id, key: k.key };
    }

    const get = (path: string, key: string) =>
      request(app.server).get(path).set('Authorization', `Bearer ${key}`);
    const claim = (key: string, body: Record<string, unknown>) =>
      request(app.server).post('/v1/claims').set('Authorization', `Bearer ${key}`).send(body);

    /** Paid calls paging through every listing (100 a page): each call's id and served keys. */
    async function fetchAll(key: string) {
      const calls: { callId: string; keys: string[] }[] = [];
      let cursor: string | null = null;
      do {
        const qs: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const res = await get(`${world.path}/records?limit=100${qs}`, key);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        calls.push({
          callId: res.headers['spigot-call-id'] as string,
          keys: (res.body.records as { key: string }[]).map((r) => r.key),
        });
        cursor = res.body.next as string | null;
      } while (cursor);
      const callFor = (k: string) => {
        const c = calls.find((x) => x.keys.includes(k));
        expect(c, `${k} was served`).toBeDefined();
        return c!.callId;
      };
      return { calls, callFor, callId: calls[0]!.callId, keys: calls[0]!.keys };
    }

    /** The served key (`listings/<record_key>`) of the demo listing `slug`. */
    async function keyOfSlug(slug: string) {
      const r = await one<{ key: string; recordId: string }>(
        `SELECT 'listings/' || r.record_key AS key, r.id AS "recordId"
           FROM records r JOIN pages p ON p.id = r.page_id
          WHERE r.dataset_id = $1 AND p.url LIKE '%/listings/' || $2`,
        [world.datasetId, slug],
      );
      return r;
    }

    const bal = async (kind: 'BUYER_BALANCE' | 'PUBLISHER_PAYABLE', owner: string) =>
      (
        await q<{ b: number }>(
          `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = $1 AND owner_id = $2`,
          [kind, owner],
        )
      )[0]?.b ?? 0;
    const claimRuns = async () =>
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM crawl_runs WHERE trigger = 'CLAIM'`,
        )
      ).n;
    const creditTxns = (callId: string) =>
      q<{ id: string }>(
        `SELECT t.id FROM claims c JOIN ledger_txns t ON t.ref_id = c.id
          WHERE c.api_call_id = $1 AND t.kind = 'CREDIT'`,
        [callId],
      );
    const expectLedgerClean = async () => {
      const r = await ledgerCheck(pool);
      expect(r.mismatches).toEqual([]);
      expect(r.sumMicros).toBe(0);
    };

    async function mcp(key: string): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
      const client = new Client({ name: 'sp-048c-test', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    }
    async function report(client: Client, args: Record<string, unknown>) {
      const r = (await client.callTool({
        name: 'report_bad_record',
        arguments: args,
      })) as CallToolResult & { structuredContent: ClaimStructured };
      return r;
    }

    it('fetch → demo:mutate leases it (no crawl) → claim STALE → AUTO_CREDITED, CREDIT, payable down, status in the feed', async () => {
      const b = await newBuyer();
      const served = await fetchAll(b.key);
      // The feed cursor before anything changes (free).
      const head = await get(`${world.path}/changes`, b.key);
      expect(head.status).toBe(200);
      const since = head.body.next as string;

      const m = await store.mutate({ prices: 0, leased: 1, new: 0, seed: 4801, ping: false });
      const leased = await keyOfSlug(m.leased[0]!);
      const callId = served.callFor(leased.key);
      const versionsBefore = await q(`SELECT seq FROM record_versions WHERE record_id = $1`, [
        leased.recordId,
      ]);

      const buyerBefore = await bal('BUYER_BALANCE', b.buyerId);
      const payableBefore = await bal('PUBLISHER_PAYABLE', world.publisherId);
      const res = await claim(b.key, { callId, recordKey: leased.key, reason: 'STALE' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'AUTO_CREDITED' });
      const unit = res.body.creditMicros as number;
      expect(unit).toBeGreaterThan(0);

      expect(await bal('BUYER_BALANCE', b.buyerId)).toBe(buyerBefore + unit);
      expect(await bal('PUBLISHER_PAYABLE', world.publisherId)).toBeLessThan(payableBefore);
      expect(await creditTxns(callId)).toHaveLength(1);
      expect(
        await one('SELECT status, decided_by FROM claims WHERE id = $1', [res.body.claimId]),
      ).toEqual({ status: 'AUTO_CREDITED', decided_by: 'AUTO' });

      // The re-fetch wrote a version in a CLAIM run, and it is published to the feed.
      const runs = await q<{ id: string; status: string }>(
        `SELECT r.id, r.status FROM record_refetches f JOIN crawl_runs r ON r.id = f.crawl_run_id
          WHERE f.record_id = $1`,
        [leased.recordId],
      );
      expect(runs).toEqual([{ id: expect.any(String), status: 'SUCCEEDED' }]);
      const versionsAfter = await q<{ crawl_run_id: string }>(
        `SELECT crawl_run_id FROM record_versions WHERE record_id = $1 ORDER BY seq`,
        [leased.recordId],
      );
      expect(versionsAfter).toHaveLength(versionsBefore.length + 1);
      expect(versionsAfter.at(-1)!.crawl_run_id).toBe(runs[0]!.id);

      const feed = await get(`${world.path}/changes?since=${encodeURIComponent(since)}`, b.key);
      expect(feed.status).toBe(200);
      const change = (
        feed.body.changes as {
          key: string;
          op: string;
          patch: { path: string; value: unknown }[];
        }[]
      ).find((c) => c.key === leased.key);
      expect(change?.op).toBe('update');
      expect(change?.patch).toContainEqual(
        expect.objectContaining({ path: '/status', value: expect.stringMatching(/leased/i) }),
      );
      await expectLedgerClean();
    });

    it('race: the same STALE claim from MCP and REST at once → one re-fetch, one claim, one CREDIT; MCP returns status and credit', async () => {
      const b = await newBuyer();
      const served = await fetchAll(b.key);
      const m = await store.mutate({ prices: 0, leased: 1, new: 0, seed: 4802, ping: false });
      const leased = await keyOfSlug(m.leased[0]!);
      const callId = served.callFor(leased.key);
      const client = await mcp(b.key);
      const runsBefore = await claimRuns();
      const buyerBefore = await bal('BUYER_BALANCE', b.buyerId);

      const args = { callId, recordKey: leased.key, reason: 'STALE' };
      const [viaMcp, viaRest, viaMcp2] = await Promise.all([
        report(client, args),
        claim(b.key, args),
        report(client, args),
      ]);

      expect(viaMcp.isError).toBeFalsy();
      expect(viaRest.status).toBe(200);
      const id = viaRest.body.claimId as string;
      for (const r of [viaMcp.structuredContent, viaMcp2.structuredContent, viaRest.body]) {
        expect(r).toMatchObject({ claimId: id, status: 'AUTO_CREDITED' });
        expect(r.creditMicros).toBeGreaterThan(0);
      }
      expect((viaMcp.content[0] as Text).text).toMatch(/credited back to your balance/);

      expect(await claimRuns()).toBe(runsBefore + 1);
      expect(await q('SELECT id FROM claims WHERE api_call_id = $1', [callId])).toHaveLength(1);
      expect(await creditTxns(callId)).toHaveLength(1);
      expect(await bal('BUYER_BALANCE', b.buyerId)).toBe(
        buyerBefore + (viaRest.body.creditMicros as number),
      );
      const audits = await q<{ actor_type: string }>(
        `SELECT actor_type FROM audit_events WHERE action = 'CLAIM_DECIDED' AND entity_id = $1`,
        [id],
      );
      expect(audits).toHaveLength(1);
      await expectLedgerClean();
    });

    it('a STALE claim on an unchanged listing stays OPEN and writes no version; a repeat within 10 min reuses the re-fetch', async () => {
      const b = await newBuyer();
      const { callId, keys } = await fetchAll(b.key);
      // A listing no earlier test re-fetched (their results are reused for 10 minutes).
      const fresh = await one<{ key: string; id: string }>(
        `SELECT 'listings/' || r.record_key AS key, r.id FROM records r
          WHERE r.dataset_id = $1 AND 'listings/' || r.record_key = ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM record_refetches f WHERE f.record_id = r.id)
          LIMIT 1`,
        [world.datasetId, keys],
      );
      const key = fresh.key;
      const recordId = fresh.id;
      const seqBefore = await one<{ n: number }>(
        'SELECT count(*)::int AS n FROM record_versions WHERE dataset_id = $1',
        [world.datasetId],
      );
      const runsBefore = await claimRuns();

      const res = await claim(b.key, { callId, recordKey: key, reason: 'STALE' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'OPEN', creditMicros: 0 });
      expect(await claimRuns()).toBe(runsBefore + 1);
      expect(
        await one('SELECT outcome FROM record_refetches WHERE record_id = $1', [recordId]),
      ).toEqual({ outcome: 'FETCHED' });
      expect(
        await one<{ n: number }>(
          'SELECT count(*)::int AS n FROM record_versions WHERE dataset_id = $1',
          [world.datasetId],
        ),
      ).toEqual(seqBefore);
      expect(await creditTxns(callId)).toEqual([]);

      // Another buyer's claim on the same record within 10 minutes: no second fetch.
      const b2 = await newBuyer();
      const c2 = await fetchAll(b2.key);
      const again = await claim(b2.key, { callId: c2.callId, recordKey: key, reason: 'REMOVED' });
      expect(again.body).toMatchObject({ status: 'OPEN' });
      expect(await claimRuns()).toBe(runsBefore + 1);
      await expectLedgerClean();
    });
  },
);
