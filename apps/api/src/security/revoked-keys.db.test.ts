import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { routeTable, type RegisteredRoute } from './routeTable.js';

/**
 * SP-042 (features/14 §Acceptance criteria): a revoked API key → 401 on REST and MCP, checked on
 * every request, including an MCP session the key opened before it was revoked. The buyer revokes
 * it the real way (`DELETE /api/buyer/keys/:id` from the portal). Every key-gated `/v1` route is
 * found from the route table (a route that doesn't serve an anonymous caller), so a later route is
 * swept too. Bad webhook signature → 401: stubbed until SP-059 registers `POST /webhooks/paypal`.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const FIELDS = [{ name: 'title', type: 'string', visible: true, filterable: [] }];

describe.skipIf(!testDatabaseUrl)('SP-042 revoked keys (Postgres)', { timeout: 120_000 }, () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let base: string;
  let site: string;
  let buyerCookie: string;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await app.db.pool.query(sql, params)).rows as T[];

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logger: false },
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const tag = randomUUID().slice(0, 8);
    site = `s-${tag}`;
    const [pub] = await q<{ id: string }>(
      `INSERT INTO publishers (name, email, payout_email) VALUES ($1, $2, $2) RETURNING id`,
      [`Pub ${tag}`, `pub-${tag}@example.com`],
    );
    const [s] = await q<{ id: string }>(
      `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, 'v', 'c', 'g', 'READY') RETURNING id`,
      [pub!.id, `https://${tag}.example.com`, site],
    );
    const [ds] = await q<{ id: string }>(
      `INSERT INTO datasets (site_id, slug, type_name, status, record_count)
       VALUES ($1, 'listings', 'Listing', 'LIVE', 1) RETURNING id`,
      [s!.id],
    );
    const [sv] = await q<{ id: string }>(
      `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
      [ds!.id, JSON.stringify(FIELDS)],
    );
    await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
    await q(
      `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
       VALUES ($1, 'r-1', '{"title":"One"}', 'h', 1, now(), now())`,
      [ds!.id],
    );

    const res = await fetch(`${base}/api/buyer/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({
        name: 'Revoker',
        email: `buyer-${tag}@example.com`,
        password: 'correct horse battery',
      }),
    });
    expect(res.status).toBe(201);
    const { buyerId } = (await res.json()) as { buyerId: string };
    buyerCookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';', 1)[0])
      .join('; ');
    await app.db.tx(async (tx) => {
      const acct = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyerId);
      const { paypalCash } = await platformAccounts(tx);
      await post(tx, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer: acct, paypalCash }, 10_000_000),
      });
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => app.rateLimiter.reset());

  const portal = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Cookie: buyerCookie,
        Origin: APP_ORIGIN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function newKey(): Promise<{ id: string; key: string }> {
    const res = await portal('POST', '/api/buyer/keys', {
      name: 'sp042',
      scopes: ['read', 'topup'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; key: string };
    expect(body.key).toMatch(/^sk_spg_/);
    return body;
  }

  /** Concrete request for a `/v1` route (params filled; bodies for POSTs). */
  function v1Request(r: RegisteredRoute): { path: string; body?: unknown } {
    const path = r.url
      .replace(':site', site)
      .replace(':dataset', 'listings')
      .replace(':key', 'r-1');
    if (r.method === 'POST') return { path, body: { amountCents: 500 } };
    return { path: path.endsWith('/changes') ? `${path}?since=0` : path };
  }

  const rest = (r: RegisteredRoute, key?: string) => {
    const { path, body } = v1Request(r);
    return fetch(`${base}${path}`, {
      method: r.method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };

  async function mcp(key: string, body: unknown, sessionId?: string) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, sessionId: res.headers.get('mcp-session-id'), text };
  }
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sp042-revoked', version: '1' },
    },
  };
  const search = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'search_records', arguments: { site: 'x', dataset: 'listings' } },
  };

  it('REST: every key-gated /v1 route answers a live key, then 401 once the key is revoked', async () => {
    await app.ready();
    const v1 = routeTable(app).filter((r) => r.url.startsWith('/v1/'));
    const gated: RegisteredRoute[] = [];
    // Public reads (catalog, describe, openapi) serve anyone; every other route needs a key (401,
    // or 402 with payment instructions for the paid reads).
    for (const r of v1) if ((await rest(r)).status !== 200) gated.push(r);
    expect(gated.map((r) => `${r.method} ${r.url}`)).toEqual(
      expect.arrayContaining([
        'GET /v1/balance',
        'POST /v1/topups',
        'GET /v1/:site/datasets/:dataset/quote',
        'GET /v1/:site/datasets/:dataset/records',
        'GET /v1/:site/datasets/:dataset/records/:key',
        'GET /v1/:site/datasets/:dataset/changes',
      ]),
    );

    const { id, key } = await newKey();
    for (const r of gated) {
      const res = await rest(r, key);
      expect(res.status, `${r.method} ${r.url} with a live key`).not.toBe(401);
      expect(res.status).toBeLessThan(500);
    }
    expect((await portal('DELETE', `/api/buyer/keys/${id}`)).status).toBe(200);
    const charged = await q(`SELECT count(*)::int AS n FROM api_calls`);
    for (const r of gated) {
      const res = await rest(r, key);
      expect(res.status, `${r.method} ${r.url} with a revoked key`).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('KEY_REVOKED');
    }
    // Nothing was charged or created for the revoked key.
    expect(await q(`SELECT count(*)::int AS n FROM api_calls`)).toEqual(charged);
  });

  it('REST: an unknown or malformed key is the same 401', async () => {
    const balance: RegisteredRoute = { method: 'GET', url: '/v1/balance' };
    for (const k of [`sk_spg_${'0'.repeat(40)}`, 'sk_spg_', 'not-a-key', 'gk_wrong']) {
      expect((await rest(balance, k)).status, k).toBe(401);
    }
  });

  it('MCP: a revoked key can open no session, and its open session stops on the next request', async () => {
    const { id, key } = await newKey();
    const init = await mcp(key, initialize);
    expect(init.status).toBe(200);
    const sid = init.sessionId!;
    expect(
      (await mcp(key, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid)).status,
    ).toBe(202);
    expect((await mcp(key, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, sid)).status).toBe(200);

    expect((await portal('DELETE', `/api/buyer/keys/${id}`)).status).toBe(200);
    const calls = await q(`SELECT count(*)::int AS n FROM api_calls`);

    const open = await mcp(key, search, sid);
    expect(open.status, 'open session after revoke').toBe(401);
    expect((await mcp(key, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, sid)).status).toBe(401);
    expect((await mcp(key, initialize)).status, 'new session after revoke').toBe(401);
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Mcp-Session-Id': sid },
      });
      expect(res.status, `${method} /mcp after revoke`).toBe(401);
      await res.body?.cancel();
    }
    expect(await q(`SELECT count(*)::int AS n FROM api_calls`)).toEqual(calls);
  });

  it('PayPal webhook with a bad signature → 401, nothing processed (SP-059)', async (ctx) => {
    await app.ready();
    if (!app.hasRoute({ method: 'POST', url: '/webhooks/paypal' })) {
      ctx.skip('POST /webhooks/paypal is SP-059; this case runs once that route merges');
    }
    const before = await q(`SELECT count(*)::int AS n FROM webhook_events`);
    const res = await fetch(`${base}/webhooks/paypal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYPAL-TRANSMISSION-ID': randomUUID(),
        'PAYPAL-TRANSMISSION-TIME': new Date().toISOString(),
        'PAYPAL-TRANSMISSION-SIG': 'bad-signature',
        'PAYPAL-CERT-URL': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-bad',
        'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
      },
      body: JSON.stringify({
        id: `WH-${randomUUID()}`,
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: { id: 'CAPTURE-bad' },
      }),
    });
    expect(res.status).toBe(401);
    expect(await q(`SELECT count(*)::int AS n FROM webhook_events`)).toEqual(before);
  });
});
