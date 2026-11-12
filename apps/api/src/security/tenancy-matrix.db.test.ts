import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';
import { routeTable } from './routeTable.js';
import {
  loadTenancyCases,
  routeKey,
  tenantUrls,
  uncoveredRoutes,
  type LoadedCase,
  type TenantB,
} from './tenancyCases.js';

/**
 * SP-042: the cross-tenant matrix (features/14 §Tenancy rules, §Acceptance criteria).
 *
 * Generated, not hand-listed: every route in Fastify's route table that is tenant-scoped must have
 * a case in `tenancy/*.cases.ts` (glob-loaded), and every case is *run* here against two tenants
 * of each kind. Probes are picked from the route's shape, so a case file added by a later ticket
 * is executed without editing this file. An `/api/…/:param` route gets B's real ids from its case's
 * `ids(b)` or the built-in map (`tenantUrls`); with neither, it fails rather than being probed with
 * ids that exist for nobody:
 *
 * - `/api/…/:id` routes: tenant A's session with tenant B's id → 404, the same error as an id that
 *   doesn't exist (B's ids are never confirmed); no session → 401.
 * - `/admin/…`: a non-admin publisher → 403; no session → 401.
 * - Id-less session routes: A's session with B's ids smuggled into the query / body → never a
 *   5xx, and none of B's identifiers in the reply; no session → 401.
 * - `/v1/…` (API key), gate (gate key), public pages: A's credential (or none) → none of B's
 *   private identifiers in the reply.
 * - `/mcp`: A's key with B's `Mcp-Session-Id` → 404; B's session still works.
 *
 * Finally B's rows (publisher, sites, datasets, schemas, runs, keys, top-ups, balance, calls) are
 * byte-for-byte what they were before A ran every route against B's ids.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;
const PASSWORD = 'correct horse battery';
const FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq'] },
  { name: 'agent_phone', type: 'string', visible: false, filterable: ['eq'] },
];

const CASES = await loadTenancyCases();

interface Publisher {
  id: string;
  name: string;
  email: string;
  payoutEmail: string;
  cookie: string;
  siteId: string;
  slug: string;
  gateKey: string;
  liveDatasetId: string;
  proposedDatasetId: string;
  proposedSchemaId: string;
  runId: string;
}

interface Buyer {
  id: string;
  name: string;
  email: string;
  cookie: string;
  key: string;
  keyId: string;
  topupId: string;
  orderId: string;
  callId: string;
}

interface Reply {
  status: number;
  text: string;
  json: { error?: { code?: string } } | null;
  headers: Headers;
}

interface CallOpts {
  cookie?: string;
  bearer?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ');
}

describe.skipIf(!testDatabaseUrl)(
  'SP-042 cross-tenant matrix (Postgres)',
  { timeout: 180_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let base: string;
    let A: Publisher;
    let B: Publisher;
    let bA: Buyer;
    let bB: Buyer;
    let before: unknown;
    const ran = new Set<string>();

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    /** One request over real HTTP. An event stream is read for 300 ms, then dropped. */
    async function call(method: string, path: string, opts: CallOpts = {}): Promise<Reply> {
      const headers: Record<string, string> = { ...opts.headers };
      // A browser on the app sends Origin, so the CSRF check passes and auth decides (401 vs 404).
      if (!opts.bearer) headers.Origin = APP_ORIGIN;
      if (opts.cookie) headers.Cookie = opts.cookie;
      if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const ac = new AbortController();
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        redirect: 'manual',
        signal: ac.signal,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      let text = '';
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        const deadline = Date.now() + 300;
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((r) => setTimeout(() => r(null), left)),
          ]);
          if (!chunk || chunk.done) break;
          text += dec.decode(chunk.value, { stream: true });
        }
        ac.abort();
      } else {
        text = await res.text();
      }
      let json: Reply['json'] = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, text, json, headers: res.headers };
    }

    // -------------------------------------------------------------------------------------------
    // The two tenants of each kind

    async function topUp(buyerId: string, micros: number) {
      await app.db.tx(async (tx) => {
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyerId);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash }, micros),
        });
      });
    }

    async function newPublisher(label: string): Promise<Publisher> {
      const tag = `${label}-${randomUUID().slice(0, 8)}`.toLowerCase();
      const name = `Pub ${tag}`;
      const email = `pub-${tag}@example.com`;
      const payoutEmail = `payout-${tag}@example.com`;
      const res = await fetch(`${base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
        body: JSON.stringify({ name, email, password: PASSWORD, payoutEmail }),
      });
      expect(res.status).toBe(201);
      const { publisherId: id } = (await res.json()) as { publisherId: string };
      const cookie = cookiesOf(res);

      const siteId = randomUUID();
      const slug = `s-${tag}`;
      const s = generateSiteSecrets(siteId, SECRET);
      await q(
        `INSERT INTO sites (id, publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY')`,
        [
          siteId,
          id,
          `https://${tag}.example.com`,
          slug,
          s.verifyToken,
          s.crawlKeyHash,
          s.gateKeyHash,
        ],
      );
      const [live] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count)
       VALUES ($1, 'listings', 'Listing', 'LIVE', 3) RETURNING id`,
        [siteId],
      );
      const [sv] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
        [live!.id, JSON.stringify(FIELDS)],
      );
      await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [live!.id, sv!.id]);
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
       SELECT $1::uuid, 'r-' || i, jsonb_build_object('title', 'Item ' || i, 'city', 'Austin',
                'agent_phone', '512-555-' || i), md5($1::uuid::text || i), 1, now(), now()
         FROM generate_series(1, 3) i`,
        [live!.id],
      );
      const [proposed] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status) VALUES ($1, 'proposed', 'Thing', 'PROPOSED')
       RETURNING id`,
        [siteId],
      );
      const [psv] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'PROPOSED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
        [proposed!.id, JSON.stringify(FIELDS)],
      );
      const [run] = await q<{ id: string }>(
        `INSERT INTO crawl_runs (site_id, trigger, status, started_at, finished_at)
       VALUES ($1, 'MANUAL', 'SUCCEEDED', now(), now()) RETURNING id`,
        [siteId],
      );
      return {
        id,
        name,
        email,
        payoutEmail,
        cookie,
        siteId,
        slug,
        gateKey: s.gateKey,
        liveDatasetId: live!.id,
        proposedDatasetId: proposed!.id,
        proposedSchemaId: psv!.id,
        runId: run!.id,
      };
    }

    /** A portal buyer with a key, a balance, an open top-up and one charged `/v1` call on `site`. */
    async function newBuyer(label: string, site: Publisher): Promise<Buyer> {
      const tag = `${label}-${randomUUID().slice(0, 8)}`.toLowerCase();
      const name = `Buyer ${tag}`;
      const email = `buyer-${tag}@example.com`;
      const res = await fetch(`${base}/api/buyer/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
        body: JSON.stringify({ name, email, password: PASSWORD }),
      });
      expect(res.status).toBe(201);
      const { buyerId: id } = (await res.json()) as { buyerId: string };
      const cookie = cookiesOf(res);
      const k = await createKey(app.db.pool, id, { scopes: ['read', 'topup'] });
      await topUp(id, 5_000_000);
      const orderId = `ORDER-${tag}`;
      const [t] = await q<{ id: string }>(
        `INSERT INTO topups (buyer_id, amount_cents, method, status, paypal_order_id)
       VALUES ($1, 1000, 'PAYPAL_WALLET', 'CREATED', $2) RETURNING id`,
        [id, orderId],
      );
      const r = await call('GET', `/v1/${site.slug}/datasets/listings/records?limit=1`, {
        bearer: k.key,
      });
      expect(r.status).toBe(200);
      const [c] = await q<{ id: string }>(
        `SELECT id FROM api_calls WHERE buyer_id = $1 AND status = 'CHARGED'`,
        [id],
      );
      expect(c).toBeDefined();
      return {
        id,
        name,
        email,
        cookie,
        key: k.key,
        keyId: k.id,
        topupId: t!.id,
        orderId,
        callId: c!.id,
      };
    }

    /** Everything tenant B owns, as stored. Must be identical before and after the matrix. */
    async function stateOfB(): Promise<unknown> {
      const rows = async (sql: string, params: unknown[]) =>
        (await q<{ j: unknown }>(sql, params)).map((r) => r.j);
      return {
        publisher: await rows(`SELECT to_jsonb(p) j FROM publishers p WHERE id = $1`, [B.id]),
        sites: await rows(`SELECT to_jsonb(s) j FROM sites s WHERE publisher_id = $1 ORDER BY id`, [
          B.id,
        ]),
        datasets: await rows(
          `SELECT to_jsonb(d) j FROM datasets d JOIN sites s ON s.id = d.site_id
          WHERE s.publisher_id = $1 ORDER BY d.id`,
          [B.id],
        ),
        schemas: await rows(
          `SELECT to_jsonb(v) j FROM schema_versions v JOIN datasets d ON d.id = v.dataset_id
           JOIN sites s ON s.id = d.site_id WHERE s.publisher_id = $1 ORDER BY v.id`,
          [B.id],
        ),
        runs: await rows(
          `SELECT to_jsonb(r) j FROM crawl_runs r JOIN sites s ON s.id = r.site_id
          WHERE s.publisher_id = $1 ORDER BY r.id`,
          [B.id],
        ),
        records: await rows(
          `SELECT to_jsonb(r) j FROM records r JOIN datasets d ON d.id = r.dataset_id
           JOIN sites s ON s.id = d.site_id WHERE s.publisher_id = $1 ORDER BY r.id`,
          [B.id],
        ),
        buyer: await rows(`SELECT to_jsonb(b) j FROM buyers b WHERE id = $1`, [bB.id]),
        keys: await rows(`SELECT to_jsonb(k) j FROM api_keys k WHERE buyer_id = $1 ORDER BY id`, [
          bB.id,
        ]),
        topups: await rows(`SELECT to_jsonb(t) j FROM topups t WHERE buyer_id = $1 ORDER BY id`, [
          bB.id,
        ]),
        calls: await rows(`SELECT to_jsonb(c) j FROM api_calls c WHERE buyer_id = $1 ORDER BY id`, [
          bB.id,
        ]),
        // Buyer B's balance only: B's PUBLISHER_PAYABLE rightly grows when buyer A buys B's public
        // `/v1` records (that's B getting paid, not a tenancy leak).
        balance: await rows(
          `SELECT to_jsonb(a) j FROM ledger_accounts a WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
          [bB.id],
        ),
      };
    }

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(
        loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
        { logger: false },
      );
      await app.listen({ port: 0, host: '127.0.0.1' });
      base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      A = await newPublisher('a');
      B = await newPublisher('b');
      bA = await newBuyer('a', A);
      bB = await newBuyer('b', B);
      before = await stateOfB();
    });
    afterAll(async () => {
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => app.rateLimiter.reset());

    // -------------------------------------------------------------------------------------------
    // What tenant B's data looks like in a reply

    /** Never in any reply to A or to an anonymous caller. */
    const privateMarkers = () => [
      B.id,
      B.email,
      B.payoutEmail,
      bB.id,
      bB.email,
      bB.name,
      bB.keyId,
      bB.topupId,
      bB.orderId,
      bB.callId,
    ];
    /** Also never in a reply to A on a session (tenant) route: B's catalog is public, not A's. */
    const tenantMarkers = () => [
      ...privateMarkers(),
      B.name,
      B.siteId,
      B.slug,
      B.liveDatasetId,
      B.proposedDatasetId,
      B.proposedSchemaId,
      B.runId,
    ];

    function expectNoMarkers(r: Reply, markers: string[], label: string) {
      for (const m of markers) {
        expect(r.text.includes(m), `${label}: reply leaks "${m}"`).toBe(false);
        expect(r.headers.get('location') ?? '', `${label}: Location leaks "${m}"`).not.toContain(m);
      }
    }

    const tenantB = (): TenantB => ({
      publisherId: B.id,
      siteId: B.siteId,
      siteSlug: B.slug,
      liveDatasetId: B.liveDatasetId,
      proposedDatasetId: B.proposedDatasetId,
      proposedSchemaId: B.proposedSchemaId,
      crawlRunId: B.runId,
      buyerId: bB.id,
      apiKeyId: bB.keyId,
      topupId: bB.topupId,
      callId: bB.callId,
    });
    /** B's real ids in the case's `:param`s (throws for an `/api` param with no known id). */
    const fillVariants = (c: LoadedCase) => tenantUrls(c, tenantB(), randomUUID);
    const withRandomIds = (url: string) => url.replace(/:[A-Za-z_]+/g, () => randomUUID());

    /** Bodies that get past validation to the ownership check, with B's ids smuggled in. */
    function bodyFor(c: LoadedCase): unknown {
      const smuggle = { publisherId: B.id, buyerId: bB.id };
      const bodies: Record<string, unknown> = {
        // A loopback origin is refused before any fetch (no DNS, no network in the test).
        'POST /api/sites': { origin: 'http://127.0.0.1:9', ...smuggle },
        'PATCH /api/publishers/me': { name: 'A renamed' },
        'PATCH /api/datasets/:id': { perRecordMicros: 2_000 },
        'POST /api/datasets/:id/approve': {
          schemaVersionId: B.proposedSchemaId,
          rightsAttested: true,
        },
        'PATCH /api/sites/:id/policy': { decisions: { SEARCH: 'PASS' } },
        'POST /api/sites/:id/keys/rotate': { kind: 'gate' },
        'POST /api/buyer/keys': { name: 'sp042', ...smuggle },
        'POST /api/buyer/topups': { amountCents: 500, method: 'PAYPAL_WALLET', ...smuggle },
        'POST /v1/topups': { amountCents: 500, ...smuggle },
        'POST /api/auth/signup': {
          name: 'New pub',
          email: `new-${randomUUID()}@example.com`,
          password: PASSWORD,
          payoutEmail: 'new-payout@example.com',
          ...smuggle,
        },
        'POST /api/auth/login': { email: A.email, password: PASSWORD, ...smuggle },
        'POST /api/buyer/signup': {
          name: 'New buyer',
          email: `new-${randomUUID()}@example.com`,
          password: PASSWORD,
          ...smuggle,
        },
        'POST /api/buyer/login': { email: bA.email, password: PASSWORD, ...smuggle },
        'POST /api/gate/hits': { sentAt: new Date().toISOString(), buckets: [], siteId: B.siteId },
      };
      const body = bodies[routeKey(c)];
      if (body !== undefined || c.method === 'GET' || c.method === 'DELETE') return body;
      // Id routes take their id from the path only; strict bodies would 400 on smuggled keys.
      return c.url.includes('/:') ? {} : smuggle;
    }

    /** A fresh session (logout cases must not end the session the other probes use). */
    async function freshLogin(kind: 'publisher' | 'buyer'): Promise<string> {
      const path = kind === 'publisher' ? '/api/auth/login' : '/api/buyer/login';
      const email = kind === 'publisher' ? A.email : bA.email;
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      return cookiesOf(res);
    }

    const isLogout = (c: LoadedCase) => c.url.endsWith('/logout');
    const isApiKeyRoute = (c: LoadedCase) => c.url.startsWith('/v1') || c.url === '/mcp';

    /** A's credential for this case. */
    async function credOf(c: LoadedCase): Promise<CallOpts> {
      if (c.url.startsWith('/api/gate/')) return { bearer: A.gateKey };
      if (c.as === 'none') return {};
      if (isApiKeyRoute(c)) return { bearer: bA.key };
      if (isLogout(c)) return { cookie: await freshLogin(c.as) };
      return { cookie: c.as === 'publisher' ? A.cookie : bA.cookie };
    }

    async function mcpRpc(key: string, body: unknown, sessionId?: string, method = 'POST') {
      const res = await fetch(`${base}/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
      const text = method === 'GET' && res.status === 200 ? '' : await res.text();
      if (method === 'GET' && res.status === 200) await res.body?.cancel();
      return { status: res.status, sessionId: res.headers.get('mcp-session-id'), text };
    }

    async function probeMcp(c: LoadedCase) {
      const init = await mcpRpc(bB.key, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'sp042-b', version: '1' },
        },
      });
      expect(init.status).toBe(200);
      const sid = init.sessionId!;
      expect(
        (await mcpRpc(bB.key, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid)).status,
      ).toBe(202);

      const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
      const stolen = await mcpRpc(bA.key, list, sid, c.method);
      expect(stolen.status, `${routeKey(c)} with B's session id`).toBe(404);
      expectNoMarkers(
        { status: stolen.status, text: stolen.text, json: null, headers: new Headers() },
        privateMarkers(),
        routeKey(c),
      );
      // B's session is untouched by A's attempt (DELETE included).
      expect((await mcpRpc(bB.key, list, sid)).status).toBe(200);
      // No key at all → 401.
      const anon = await fetch(`${base}/mcp`, { method: c.method });
      expect(anon.status).toBe(401);
    }

    async function probe(c: LoadedCase) {
      const label = `${c.file}: ${routeKey(c)}`;
      if (c.url === '/mcp') return probeMcp(c);

      const cred = await credOf(c);
      const sessionRoute = c.as !== 'none' && !isApiKeyRoute(c);

      if (c.url.startsWith('/admin/')) {
        // Deliberately cross-tenant: admins only (ADMIN_EMAILS is empty here).
        for (const url of fillVariants(c)) {
          const r = await call(c.method, url, { ...cred, body: bodyFor(c) });
          expect(r.status, `${label} as a non-admin publisher`).toBe(403);
          expectNoMarkers(r, tenantMarkers(), label);
          expect(
            (await call(c.method, url, { body: bodyFor(c) })).status,
            `${label} no session`,
          ).toBe(401);
        }
        return;
      }

      if (c.url.startsWith('/api/') && c.url.includes('/:')) {
        // Tenant A's session against tenant B's ids: 404, indistinguishable from a missing id.
        const missing = await call(c.method, withRandomIds(c.url), { ...cred, body: bodyFor(c) });
        expect(missing.status, `${label} with a random id`).toBe(404);
        for (const url of fillVariants(c)) {
          const r = await call(c.method, url, { ...cred, body: bodyFor(c) });
          expect(r.status, `${label} with B's id (${url})`).toBe(404);
          expect(r.json?.error?.code, label).toBe(missing.json?.error?.code);
          expectNoMarkers(r, tenantMarkers(), label);
        }
        if (sessionRoute) {
          const anon = await call(c.method, fillVariants(c)[0]!, { body: bodyFor(c) });
          expect(anon.status, `${label} no session`).toBe(401);
        }
        return;
      }

      // Id-less routes, API-key routes and public pages: A's credential (or none), B's ids
      // smuggled into the query and body. Never a 5xx; never B's data.
      const smuggle = `publisherId=${B.id}&buyerId=${bB.id}`;
      const urls = c.url.startsWith('/topups/return')
        ? [`${c.url}?token=ORDER-${randomUUID()}`] // a token isn't a session; an unknown one credits nobody
        : fillVariants(c).map((u) =>
            c.method === 'GET' && !c.url.startsWith('/v1/') ? `${u}?${smuggle}` : u,
          );
      const markers = sessionRoute ? tenantMarkers() : privateMarkers();
      for (const url of urls) {
        const r = await call(c.method, url, { ...cred, body: bodyFor(c) });
        expect(r.status, `${label} (${url}): ${r.text.slice(0, 200)}`).toBeLessThan(500);
        expectNoMarkers(r, markers, label);
      }
      if (sessionRoute && !isLogout(c)) {
        const anon = await call(c.method, urls[0]!, { body: bodyFor(c) });
        expect(anon.status, `${label} no session`).toBe(401);
      }
    }

    it('the route table has no tenant-scoped route without a case', async () => {
      await app.ready();
      expect(uncoveredRoutes(routeTable(app), CASES).map(routeKey)).toEqual([]);
    });

    for (const c of CASES) {
      it(`${c.file}: ${routeKey(c)} (as ${c.as})`, async () => {
        await probe(c);
        ran.add(routeKey(c));
      });
    }

    it("tenant B's rows are unchanged after A ran every route against B's ids", async () => {
      expect(ran.size).toBe(CASES.length);
      expect(await stateOfB()).toEqual(before);
    });
  },
);
