import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { FakePayPal } from '../paypal/index.js';
import { cases } from '../security/tenancy/v1-topups.cases.js';
import { buildServer } from '../server.js';
import { topupResponse } from '../routes/v1.schemas.js';
import { REQUIRED_ENV } from '../test/env.js';
import { balanceOf, setTopupPayPal, topupById } from '../topups/index.js';

/**
 * SP-022b: MCP `get_balance` + `top_up` (approval link) and `POST /v1/topups`, over real HTTP
 * with the MCP client SDK (as `mcp-remote` drives it for Claude Desktop) and, where the test pins
 * JSON-RPC and session ids, raw requests. PayPal is the FakePayPal stub.
 */

type Text = { type: 'text'; text: string };
const textOf = (r: CallToolResult) => (r.content[0] as Text).text;

interface Buyer {
  buyerId: string;
  key: string;
  keyId: string;
}

interface TopUpStructured {
  topupId: string;
  status: string;
  amountCents: number;
  orderId: string | null;
  approveUrl: string | null;
  balanceMicros?: number;
  error?: { code: string; message: string };
}

interface RpcJson {
  result?: CallToolResult & { structuredContent: TopUpStructured };
  error?: { code: number; message: string };
}

describe.skipIf(!testDatabaseUrl)(
  'SP-022b MCP get_balance + top_up, POST /v1/topups (Postgres, HTTP, FakePayPal)',
  { timeout: 120_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let url: string;
    let fake: FakePayPal;
    const clients: Client[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(
        loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
        { logger: false },
      );
      await app.listen({ port: 0, host: '127.0.0.1' });
      url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
      fake = new FakePayPal({ latencyMs: 5, jitterMs: 10 });
    }, 60_000);
    afterAll(async () => {
      setTopupPayPal(undefined);
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => {
      app.rateLimiter.reset();
      fake.clearFaults();
      setTopupPayPal(fake.client({ timeoutMs: 1_000 }));
    });

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    async function buyer(scopes: ('read' | 'topup')[] = ['read', 'topup']): Promise<Buyer> {
      const [b] = await q<{ id: string }>(`INSERT INTO buyers (name) VALUES ($1) RETURNING id`, [
        `Agent buyer ${randomUUID().slice(0, 8)}`,
      ]);
      const k = await createKey(app.db.pool, b!.id, { scopes });
      return { buyerId: b!.id, key: k.key, keyId: k.id };
    }

    const topups = (b: Buyer) =>
      q<{
        id: string;
        status: string;
        trigger: string;
        method: string;
        amount_cents: number;
        paypal_order_id: string | null;
      }>(
        `SELECT id, status, trigger, method, amount_cents, paypal_order_id FROM topups
          WHERE buyer_id = $1 ORDER BY created_at`,
        [b.buyerId],
      );
    const ordersFor = (topupId: string) => fake.orders().filter((o) => o.customId === topupId);
    const createsFor = (topupId: string) =>
      fake.calls.filter((c) => c.op === 'order_create' && c.requestId === topupId);
    const topupTxns = (topupId: string) =>
      q(`SELECT id FROM ledger_txns WHERE kind = 'TOPUP' AND idempotency_key = $1`, [
        `topup:${topupId}`,
      ]);

    async function connect(key: string): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
      const client = new Client({ name: 'sp-022b-test', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    }

    async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    }

    async function rpc(
      key: string,
      body: unknown,
      sessionId?: string,
    ): Promise<{ status: number; sessionId: string | null; json: RpcJson | null }> {
      const res = await fetch(url, {
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
      return {
        status: res.status,
        sessionId: res.headers.get('mcp-session-id'),
        json: text ? (JSON.parse(text) as RpcJson) : null,
      };
    }

    async function rawSession(key: string): Promise<string> {
      const init = await rpc(key, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      });
      expect(init.status).toBe(200);
      const ack = await rpc(
        key,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        init.sessionId!,
      );
      expect(ack.status).toBe(202);
      return init.sessionId!;
    }

    const toolCall = (id: number | string, name: string, args: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    it('lists get_balance and top_up; top_up says it returns a PayPal approval link', async () => {
      const b = await buyer();
      const client = await connect(b.key);
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.get_balance).toBeDefined();
      expect(byName.get_balance!.description).toMatch(/Free/);
      expect(byName.top_up!.description).toContain('PayPal approval link');
      expect(byName.top_up!.inputSchema.properties).toHaveProperty('amountCents');
    });

    it('get_balance: balance and auto top-up status, free, any scope', async () => {
      const b = await buyer(['read']);
      await q(
        `UPDATE buyers SET auto_topup_enabled = true, auto_topup_threshold_micros = 2000000,
                auto_topup_amount_cents = 2000, monthly_topup_cap_cents = 10000 WHERE id = $1`,
        [b.buyerId],
      );
      const client = await connect(b.key);
      const res = await call(client, 'get_balance');
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual({
        balanceMicros: 0,
        autoTopup: {
          enabled: true,
          thresholdMicros: 2_000_000,
          amountCents: 2000,
          remainingThisMonthCents: 10_000,
          hasSavedMethod: false,
        },
      });
      expect(textOf(res)).toBe(
        'Balance $0.00. Auto top-up is on: $20 when below $2.00 ($100 left this month). ' +
          'No PayPal method is saved yet, so it cannot run.',
      );

      const topupOnly = await buyer(['topup']);
      const r2 = await call(await connect(topupOnly.key), 'get_balance');
      expect(r2.isError).toBeFalsy();
      expect(textOf(r2)).toContain('Auto top-up is off');
    });

    it('top_up without the topup scope → tool error, no top-up, PayPal never called', async () => {
      const b = await buyer(['read']);
      const client = await connect(b.key);
      const calls = fake.calls.length;
      const res = await call(client, 'top_up', { amountCents: 2000 });
      expect(res.isError).toBe(true);
      expect((res.structuredContent as TopUpStructured).error!.code).toBe('FORBIDDEN');
      expect(textOf(res)).toContain('"topup" scope');
      expect(await topups(b)).toEqual([]);
      expect(fake.calls.length).toBe(calls);
    });

    it('top_up returns a sandbox approveUrl; approving + /topups/return credits once', async () => {
      const b = await buyer();
      const client = await connect(b.key);
      const res = await call(client, 'top_up', { amountCents: 2000 });
      expect(res.isError).toBeFalsy();
      const t = res.structuredContent as unknown as TopUpStructured;
      expect(t).toMatchObject({ status: 'AWAITING_APPROVAL', amountCents: 2000 });
      // PayPal's payer-action link (FakePayPal's host here; www.sandbox.paypal.com in sandbox).
      expect(t.approveUrl).toMatch(/\/checkoutnow\?token=/);
      expect(new URL(t.approveUrl!).searchParams.get('token')).toBe(t.orderId);
      expect(ordersFor(t.topupId)).toEqual([expect.objectContaining({ id: t.orderId })]);
      expect(textOf(res)).toContain(
        `Open this PayPal link to add $20 to your Spigot balance: ${t.approveUrl}`,
      );
      expect(await topups(b)).toEqual([
        expect.objectContaining({
          id: t.topupId,
          status: 'AWAITING_APPROVAL',
          trigger: 'MCP',
          method: 'PAYPAL_WALLET',
          amount_cents: 2000,
          paypal_order_id: t.orderId,
        }),
      ]);

      // The human approves at PayPal; the return URL is hit three times (refresh / double tab).
      fake.approve(t.orderId!);
      const returns = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(app.server).get(`/topups/return?token=${encodeURIComponent(t.orderId!)}`),
        ),
      );
      for (const r of returns) expect(r.status).toBe(302);
      expect(await topupTxns(t.topupId)).toHaveLength(1);
      expect(await balanceOf(app.db.pool, b.buyerId)).toBe(20_000_000);
      expect(await topupById(app.db, t.topupId)).toMatchObject({ status: 'COMPLETED' });

      const bal = await call(client, 'get_balance');
      expect((bal.structuredContent as { balanceMicros: number }).balanceMicros).toBe(20_000_000);
      expect(textOf(bal)).toMatch(/^Balance \$20\.00\./);
    });

    it('a replay by idempotencyKey after the top-up completed says so and adds nothing', async () => {
      const b = await buyer();
      const client = await connect(b.key);
      const first = await call(client, 'top_up', { amountCents: 500, idempotencyKey: 'k-done' });
      const t = first.structuredContent as unknown as TopUpStructured;
      fake.approve(t.orderId!);
      await request(app.server).get(`/topups/return?token=${encodeURIComponent(t.orderId!)}`);
      const creates = createsFor(t.topupId).length;

      const replay = await call(client, 'top_up', { amountCents: 500, idempotencyKey: 'k-done' });
      expect(replay.isError).toBeFalsy();
      expect(replay.structuredContent).toMatchObject({
        topupId: t.topupId,
        status: 'COMPLETED',
        approveUrl: null,
        balanceMicros: 5_000_000,
      });
      expect(textOf(replay)).toBe('This $5 top-up was already added via PayPal; balance $5.00.');
      expect(createsFor(t.topupId)).toHaveLength(creates);
      expect(await topupTxns(t.topupId)).toHaveLength(1);
      expect(await topups(b)).toHaveLength(1);

      // The same key with another amount is a mismatch, not a second top-up.
      const other = await call(client, 'top_up', { amountCents: 900, idempotencyKey: 'k-done' });
      expect(other.isError).toBe(true);
      expect((other.structuredContent as TopUpStructured).error!.code).toBe('IDEMPOTENCY_MISMATCH');
    });

    it('race: the same top_up JSON-RPC message retried → one top-up row, one order', async () => {
      const b = await buyer();
      const sid = await rawSession(b.key);
      const msg = toolCall(7, 'top_up', { amountCents: 2000 });

      // A client resending while the first copy is in flight, then once more after it answered.
      const racing = await Promise.all([rpc(b.key, msg, sid), rpc(b.key, msg, sid)]);
      const later = await rpc(b.key, msg, sid);
      const results = [...racing, later].map((r) => {
        expect(r.status).toBe(200);
        expect(r.json!.result!.isError).toBeFalsy();
        return r.json!.result!.structuredContent;
      });
      const ids = new Set(results.map((r) => r.topupId));
      expect(ids.size).toBe(1);
      expect(new Set(results.map((r) => r.approveUrl)).size).toBe(1);
      const [topupId] = [...ids];
      expect(await topups(b)).toHaveLength(1);
      expect(ordersFor(topupId!)).toHaveLength(1);

      // A new JSON-RPC id in the same session is a new top-up (the agent asked again).
      const next = await rpc(b.key, toolCall(8, 'top_up', { amountCents: 2000 }), sid);
      expect(next.json!.result!.structuredContent.topupId).not.toBe(topupId);
      expect(await topups(b)).toHaveLength(2);

      // Another session numbering its requests from 7 too never collides with this one.
      const sid2 = await rawSession(b.key);
      const other = await rpc(b.key, msg, sid2);
      expect(other.json!.result!.structuredContent.topupId).not.toBe(topupId);
      expect(await topups(b)).toHaveLength(3);
    });

    it('race: concurrent retries with the same idempotencyKey from separate sessions → one top-up', async () => {
      const b = await buyer();
      const [s1, s2] = await Promise.all([rawSession(b.key), rawSession(b.key)]);
      const args = { amountCents: 2500, idempotencyKey: 'agent-key-1' };
      const res = await Promise.all([
        rpc(b.key, toolCall(1, 'top_up', args), s1),
        rpc(b.key, toolCall(2, 'top_up', args), s2),
        rpc(b.key, toolCall(3, 'top_up', args), s1),
      ]);
      const ids = new Set(res.map((r) => r.json!.result!.structuredContent.topupId));
      expect(ids.size).toBe(1);
      expect(await topups(b)).toHaveLength(1);
      expect(ordersFor([...ids][0]!)).toHaveLength(1);
    });

    it('session-less resend of the same top_up within the minute → one top-up', async () => {
      const b = await buyer();
      const msg = toolCall(1, 'top_up', { amountCents: 2000 });
      const res = await Promise.all([rpc(b.key, msg), rpc(b.key, msg)]);
      const ids = new Set(res.map((r) => r.json!.result!.structuredContent.topupId));
      expect(ids.size).toBe(1);
      expect(await topups(b)).toHaveLength(1);
      expect(ordersFor([...ids][0]!)).toHaveLength(1);
    });

    it('an agent looping on top_up is stopped by the 30/min MCP limit', async () => {
      const b = await buyer();
      const sid = await rawSession(b.key); // 2 requests
      let ok = 0;
      let limited = 0;
      for (let i = 0; i < 35; i++) {
        const r = await rpc(b.key, toolCall(100 + i, 'top_up', { amountCents: 500 }), sid);
        if (r.status === 429) limited++;
        else {
          expect(r.status).toBe(200);
          ok++;
        }
      }
      // 30 a minute: 28 after the 2 session requests, plus a token or two refilled while the
      // loop runs (one every 2 s).
      expect(ok).toBeGreaterThanOrEqual(28);
      expect(ok).toBeLessThanOrEqual(30);
      expect(limited).toBe(35 - ok);
      expect(await topups(b)).toHaveLength(ok);
    });

    it('top_up out of range → tool error, nothing created', async () => {
      const b = await buyer();
      const client = await connect(b.key);
      for (const amountCents of [499, 50_001]) {
        const res = await call(client, 'top_up', { amountCents });
        expect(res.isError).toBe(true);
        expect((res.structuredContent as TopUpStructured).error!.code).toBe('VALIDATION_ERROR');
        expect(textOf(res)).toContain('$5–$500');
      }
      expect(await topups(b)).toEqual([]);
    });

    it('PayPal down on create → tool error the agent can retry; the retry reuses the row', async () => {
      const b = await buyer();
      const sid = await rawSession(b.key);
      fake.failNext('order_create', { kind: 'status', http: 503 }, 3);
      const msg = toolCall(5, 'top_up', { amountCents: 2000 });
      const first = await rpc(b.key, msg, sid);
      expect(first.json!.result!.isError).toBe(true);
      fake.clearFaults();
      const retry = await rpc(b.key, msg, sid);
      expect(retry.json!.result!.isError).toBeFalsy();
      expect(retry.json!.result!.structuredContent.status).toBe('AWAITING_APPROVAL');
      expect(await topups(b)).toHaveLength(1);
    });

    describe('POST /v1/topups', () => {
      const post = (key: string | null, body: unknown, idem?: string) => {
        let r = request(app.server).post('/v1/topups');
        if (key) r = r.set('Authorization', `Bearer ${key}`);
        if (idem) r = r.set('Idempotency-Key', idem);
        return r.send(body as object);
      };

      it('needs a key with the topup scope', async () => {
        expect((await post(null, { amountCents: 2000 })).status).toBe(401);
        const reader = await buyer(['read']);
        const res = await post(reader.key, { amountCents: 2000 });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(await topups(reader)).toEqual([]);
      });

      it('returns AWAITING_APPROVAL + approveUrl; approving credits once; Idempotency-Key replays', async () => {
        const b = await buyer(['topup']);
        const res = await post(b.key, { amountCents: 2000 }, 'rest-1');
        expect(res.status).toBe(200);
        topupResponse.strict().parse(res.body); // the openapi.yaml contract (SP-023)
        expect(res.body).toMatchObject({
          status: 'AWAITING_APPROVAL',
          amountCents: 2000,
          topupId: expect.any(String),
          approveUrl: expect.stringMatching(/\/checkoutnow\?token=/),
        });
        const again = await Promise.all([
          post(b.key, { amountCents: 2000 }, 'rest-1'),
          post(b.key, { amountCents: 2000 }, 'rest-1'),
        ]);
        for (const r of again) {
          expect(r.body.topupId).toBe(res.body.topupId);
          expect(r.body.approveUrl).toBe(res.body.approveUrl);
        }
        expect(await topups(b)).toEqual([expect.objectContaining({ trigger: 'MCP' })]);
        expect(ordersFor(res.body.topupId)).toHaveLength(1);

        fake.approve(res.body.orderId);
        await request(app.server).get(`/topups/return?token=${res.body.orderId}`);
        const done = await post(b.key, { amountCents: 2000 }, 'rest-1');
        expect(done.body).toMatchObject({ status: 'COMPLETED', balanceMicros: 20_000_000 });
        topupResponse.strict().parse(done.body);
        expect(await topupTxns(res.body.topupId)).toHaveLength(1);
      });

      it('validates the amount and the Idempotency-Key', async () => {
        const b = await buyer(['topup']);
        expect((await post(b.key, { amountCents: 499 })).status).toBe(400);
        expect((await post(b.key, { amountCents: 50_001 })).status).toBe(400);
        expect((await post(b.key, {})).status).toBe(400);
        expect((await post(b.key, { amountCents: 2000 }, ' bad key')).status).toBe(400);
        expect(await topups(b)).toEqual([]);
      });

      it("tenancy: B reusing A's Idempotency-Key gets B's own top-up; a buyerId in the body is ignored", async () => {
        const a = await buyer(['topup']);
        const b = await buyer(['topup']);
        const ra = await post(a.key, { amountCents: 2000 }, 'shared');
        const rb = await post(b.key, { amountCents: 2000, buyerId: a.buyerId }, 'shared');
        expect(rb.status).toBe(200);
        expect(rb.body.topupId).not.toBe(ra.body.topupId);
        expect(rb.body.approveUrl).not.toBe(ra.body.approveUrl);
        expect(await topups(a)).toHaveLength(1);
        expect(await topups(b)).toHaveLength(1);
      });

      it('declares its tenancy case', () => {
        expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /v1/topups']);
      });
    });
  },
);
