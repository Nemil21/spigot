import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { formatMicros } from '@spigot/shared';
import { createKey, revokeKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { cases } from '../security/tenancy/mcp.cases.js';
import { buildServer } from '../server.js';
import { balance } from '../services/balance.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-022a: the MCP server over real HTTP, driven by the MCP client SDK (as `mcp-remote` does for
 * Claude Desktop) and, where the test needs to pin JSON-RPC ids and session ids, by raw requests.
 */

const FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  {
    name: 'price_usd',
    type: 'integer',
    visible: true,
    filterable: ['eq', 'lt', 'lte', 'gt', 'gte'],
  },
  { name: 'bedrooms', type: 'integer', visible: true, filterable: ['eq', 'gte', 'lte'] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq', 'in'] },
  { name: 'agent_phone', type: 'string', visible: false, filterable: ['eq'] },
];

interface World {
  site: string;
  buyerId: string;
  key: string;
  keyId: string;
  unitMicros: number;
  changeUnitMicros: number;
}

type Text = { type: 'text'; text: string };

/** The parts of a raw JSON-RPC (or 4xx envelope) response these tests read. */
interface RpcJson {
  result: {
    isError?: boolean;
    content: Text[];
    structuredContent: { replay: boolean; records: { data: Record<string, unknown> }[] };
  };
  error: { code: string | number };
}
const textOf = (r: CallToolResult) => (r.content[0] as Text).text;

describe.skipIf(!testDatabaseUrl)(
  'SP-022a MCP server (Postgres, HTTP)',
  { timeout: 120_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let url: string;
    const clients: Client[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(
        loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, APP_BASE_URL: 'https://spigot.test' }),
        { logger: false },
      );
      await app.listen({ port: 0, host: '127.0.0.1' });
      url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
    });
    afterAll(async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => app.rateLimiter.reset());

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    /** A site `s-<tag>` with one LIVE `listings` dataset of `n` records and changes; a buyer + key. */
    async function world(
      opts: { n?: number; balanceMicros?: number; scopes?: ('read' | 'topup')[] } = {},
    ): Promise<World> {
      const n = opts.n ?? 60;
      const tag = randomUUID().slice(0, 8);
      const site = `s-${tag}`;
      const [pub] = await q<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email) VALUES ($1, $2, $2) RETURNING id`,
        [`Pub ${tag}`, `pub-${tag}@example.com`],
      );
      const [s] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, 'v', 'c', 'g', 'READY') RETURNING id`,
        [pub!.id, `https://${tag}.example.com`, site],
      );
      const [ds] = await q<{ id: string; unit: number; change_unit: number }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count)
       VALUES ($1, 'listings', 'Listing', 'LIVE', $2)
       RETURNING id, price_per_record_micros AS unit, price_per_change_micros AS change_unit`,
        [s!.id, n],
      );
      const [sv] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
        [ds!.id, JSON.stringify(FIELDS)],
      );
      await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
       SELECT $1, 'l-' || i,
              jsonb_build_object('title', 'Listing ' || i, 'price_usd', 1000 + i,
                'bedrooms', i % 5, 'city', (ARRAY['Austin','Dallas','Waco'])[i % 3 + 1],
                'agent_phone', '512-555-' || lpad(i::text, 4, '0')),
              md5(i::text), 1, now(), timestamptz '2026-11-11T00:00:00Z' + i * interval '1 second'
         FROM generate_series(1, $2) i`,
        [ds!.id, n],
      );
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
       SELECT $1, r.id, 1, 'add', jsonb_build_array(jsonb_build_object('op','add','path','','value', r.data)), r.hash
         FROM records r WHERE r.dataset_id = $1 ORDER BY r.updated_at`,
        [ds!.id],
      );
      await q(
        `UPDATE datasets SET published_seq = (SELECT max(seq) FROM record_versions WHERE dataset_id = $1) WHERE id = $1`,
        [ds!.id],
      );
      const [buyer] = await q<{ id: string }>(
        `INSERT INTO buyers (name, per_call_max_micros) VALUES ($1, 1000000) RETURNING id`,
        [`Buyer ${tag}`],
      );
      const k = await createKey(app.db.pool, buyer!.id, { scopes: opts.scopes ?? ['read'] });
      if (opts.balanceMicros) {
        await app.db.tx(async (tx) => {
          const acct = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyer!.id);
          const { paypalCash } = await platformAccounts(tx);
          await post(tx, {
            kind: 'TOPUP',
            idempotencyKey: `topup:${randomUUID()}`,
            entries: topupEntries({ buyer: acct, paypalCash }, opts.balanceMicros!),
          });
        });
      }
      return {
        site,
        buyerId: buyer!.id,
        key: k.key,
        keyId: k.id,
        unitMicros: Number(ds!.unit),
        changeUnitMicros: Number(ds!.change_unit),
      };
    }

    const bal = async (w: World) => (await balance({ db: app.db.pool }, w.buyerId)).balanceMicros;
    const calls = (w: World) =>
      q<{
        id: string;
        status: string;
        channel: string;
        price_micros: number;
        idempotency_key: string;
      }>(
        `SELECT id, status, channel, price_micros::int, idempotency_key FROM api_calls
        WHERE buyer_id = $1 ORDER BY created_at`,
        [w.buyerId],
      );
    const charged = async (w: World) => (await calls(w)).filter((c) => c.status === 'CHARGED');

    async function connect(key: string): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
      const client = new Client({ name: 'sp-022a-test', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    }

    /** One raw JSON-RPC POST to /mcp. */
    async function rpc(
      key: string,
      body: unknown,
      sessionId?: string,
    ): Promise<{ status: number; sessionId: string | null; json: RpcJson }> {
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
        json: text ? JSON.parse(text) : null,
      };
    }

    /** A raw session: initialize + initialized, as any client does. */
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
      expect(init.sessionId).toMatch(/^[0-9a-f-]{36}$/);
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

    it('lists every read tool, with plain cost wording that suggests quote first', async () => {
      const w = await world();
      const client = await connect(w.key);
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName)).toEqual(
        expect.arrayContaining([
          'list_datasets',
          'describe_dataset',
          'quote',
          'search_records',
          'get_changes',
        ]),
      );
      expect(byName.search_records!.description).toContain('Charges your Spigot balance');
      expect(byName.search_records!.description).toContain('Call `quote` first if unsure.');
      expect(byName.search_records!.description).toContain(
        'Nothing is charged if no records match.',
      );
      expect(byName.quote!.description).toMatch(/Free/);
      expect(byName.search_records!.outputSchema).toBeDefined();
    });

    it('free tools: list_datasets, describe_dataset and quote charge nothing and store no call', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const client = await connect(w.key);

      const list = (await client.callTool({
        name: 'list_datasets',
        arguments: { query: w.site },
      })) as CallToolResult;
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toContain(`${w.site}/listings: Listing`);
      const sites = (list.structuredContent as { sites: { slug: string }[] }).sites;
      expect(sites.map((s) => s.slug)).toEqual([w.site]);

      const none = (await client.callTool({
        name: 'list_datasets',
        arguments: { query: 'no-such-thing-anywhere' },
      })) as CallToolResult;
      expect(textOf(none)).toContain('No datasets match');

      const desc = (await client.callTool({
        name: 'describe_dataset',
        arguments: { site: w.site, dataset: 'listings' },
      })) as CallToolResult;
      expect(desc.isError).toBeFalsy();
      expect(textOf(desc)).toContain('bedrooms: integer [eq, gte, lte]');
      expect(textOf(desc)).not.toContain('agent_phone');
      const fields = (desc.structuredContent as { fields: { name: string }[] }).fields.map(
        (f) => f.name,
      );
      expect(fields).not.toContain('agent_phone');

      const quote = (await client.callTool({
        name: 'quote',
        arguments: {
          site: w.site,
          dataset: 'listings',
          filters: [{ field: 'bedrooms', op: 'gte', value: 3 }],
          limit: 50,
        },
      })) as CallToolResult;
      expect(quote.isError).toBeFalsy();
      const qs = quote.structuredContent as {
        records: number;
        priceMicros: number;
        balanceMicros: number;
      };
      // i % 5 ∈ {3, 4} for i in 1..60: 24 records.
      expect(qs.records).toBe(24);
      expect(qs.priceMicros).toBe(24 * w.unitMicros);
      expect(qs.balanceMicros).toBe(1_000_000);
      expect(textOf(quote)).toContain('Nothing charged');

      expect(await bal(w)).toBe(1_000_000);
      expect(await calls(w)).toEqual([]);
    });

    it('search_records debits exactly records × unit, via channel MCP, audited as MCP_CLIENT', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const client = await connect(w.key);
      const res = (await client.callTool({
        name: 'search_records',
        arguments: {
          site: w.site,
          dataset: 'listings',
          filters: [
            { field: 'bedrooms', op: 'gte', value: 3 },
            { field: 'city', op: 'eq', value: 'Austin' },
          ],
          limit: 50,
        },
      })) as CallToolResult;
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as {
        records: Record<string, unknown>[];
        charged: { records: number; priceMicros: number };
        balanceMicros: number;
        callId: string;
        replay: boolean;
      };
      const n = sc.records.length;
      expect(n).toBeGreaterThan(0);
      for (const r of sc.records as { data: Record<string, unknown> }[]) {
        expect(r.data.city).toBe('Austin');
        expect(r.data.bedrooms as number).toBeGreaterThanOrEqual(3);
        expect(r.data).not.toHaveProperty('agent_phone');
      }
      expect(sc.charged).toEqual({ records: n, priceMicros: n * w.unitMicros });
      expect(sc.replay).toBe(false);
      expect(await bal(w)).toBe(1_000_000 - n * w.unitMicros);
      expect(sc.balanceMicros).toBe(1_000_000 - n * w.unitMicros);

      const [call] = await charged(w);
      expect(call).toMatchObject({ channel: 'MCP', price_micros: n * w.unitMicros, id: sc.callId });
      // Session + JSON-RPC id is the automatic key.
      expect(call!.idempotency_key).toMatch(/^mcp:[0-9a-f-]{36}:\d+$/);
      const audit = await q<{ actor_type: string }>(
        `SELECT actor_type FROM audit_events WHERE entity_id = $1`,
        [sc.callId],
      );
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every((a) => a.actor_type === 'MCP_CLIENT')).toBe(true);

      expect(textOf(res)).toBe(
        `${n} listings, charged ${formatMicros(n * w.unitMicros)}, balance ${formatMicros(1_000_000 - n * w.unitMicros)}.`,
      );
    });

    it('get_changes charges per change and returns the next cursor; nothing new → nothing charged', async () => {
      const w = await world({ n: 12, balanceMicros: 1_000_000 });
      const client = await connect(w.key);
      const first = (await client.callTool({
        name: 'get_changes',
        arguments: { site: w.site, dataset: 'listings', since: '0', limit: 5 },
      })) as CallToolResult;
      expect(first.isError).toBeFalsy();
      const sc = first.structuredContent as {
        changes: unknown[];
        next: string;
        hasMore: boolean;
        charged: { changes: number; priceMicros: number };
      };
      expect(sc.changes).toHaveLength(5);
      expect(sc.hasMore).toBe(true);
      expect(sc.charged).toEqual({ changes: 5, priceMicros: 5 * w.changeUnitMicros });
      expect(textOf(first)).toContain(`More changes: call again with since "${sc.next}".`);
      expect(await bal(w)).toBe(1_000_000 - 5 * w.changeUnitMicros);

      // From now: no changes, no charge.
      const empty = (await client.callTool({
        name: 'get_changes',
        arguments: { site: w.site, dataset: 'listings' },
      })) as CallToolResult;
      expect(empty.isError).toBeFalsy();
      expect(textOf(empty)).toMatch(/^0 changes, nothing charged/);
      expect(await bal(w)).toBe(1_000_000 - 5 * w.changeUnitMicros);
    });

    it('replaying the same JSON-RPC request (same session, same id) is not charged twice', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const sid = await rawSession(w.key);
      const msg = toolCall(7, 'search_records', { site: w.site, dataset: 'listings', limit: 10 });

      const a = await rpc(w.key, msg, sid);
      const b = await rpc(w.key, msg, sid);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.json.result.isError).toBeFalsy();
      expect(b.json.result.isError).toBeFalsy();
      expect(a.json.result.structuredContent.replay).toBe(false);
      expect(b.json.result.structuredContent.replay).toBe(true);
      expect(b.json.result.structuredContent.records).toEqual(
        a.json.result.structuredContent.records,
      );
      expect(b.json.result.content[0].text).toContain('not charged again');

      expect(await charged(w)).toHaveLength(1);
      expect(await bal(w)).toBe(1_000_000 - 10 * w.unitMicros);
    });

    it('two concurrent copies of one JSON-RPC request charge once', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const sid = await rawSession(w.key);
      const msg = toolCall(11, 'search_records', { site: w.site, dataset: 'listings', limit: 10 });
      const results = await Promise.all([rpc(w.key, msg, sid), rpc(w.key, msg, sid)]);
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.json.result.isError).toBeFalsy();
      }
      expect(results.filter((r) => r.json.result.structuredContent.replay === false)).toHaveLength(
        1,
      );
      expect(await charged(w)).toHaveLength(1);
      expect(await bal(w)).toBe(1_000_000 - 10 * w.unitMicros);
    });

    it('an explicit idempotencyKey is honoured across sessions', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const args = { site: w.site, dataset: 'listings', limit: 4, idempotencyKey: 'agent-key-1' };
      const c1 = await connect(w.key);
      const c2 = await connect(w.key);
      const r1 = (await c1.callTool({ name: 'search_records', arguments: args })) as CallToolResult;
      const r2 = (await c2.callTool({ name: 'search_records', arguments: args })) as CallToolResult;
      expect((r1.structuredContent as { replay: boolean }).replay).toBe(false);
      expect((r2.structuredContent as { replay: boolean }).replay).toBe(true);
      expect(await charged(w)).toHaveLength(1);
      expect((await charged(w))[0]!.idempotency_key).toBe('agent-key-1');
    });

    it('two sessions reusing one JSON-RPC id for different calls are two independent charges', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const s1 = await rawSession(w.key);
      const s2 = await rawSession(w.key);
      expect(s1).not.toBe(s2);
      const a = await rpc(
        w.key,
        toolCall(2, 'search_records', { site: w.site, dataset: 'listings', limit: 3 }),
        s1,
      );
      const b = await rpc(
        w.key,
        toolCall(2, 'search_records', {
          site: w.site,
          dataset: 'listings',
          limit: 5,
          filters: [{ field: 'city', value: 'Waco' }],
        }),
        s2,
      );
      for (const r of [a, b]) {
        expect(r.status).toBe(200);
        expect(r.json.result.isError).toBeFalsy();
        expect(r.json.result.structuredContent.replay).toBe(false);
      }
      expect(b.json.result.structuredContent.records.every((r) => r.data.city === 'Waco')).toBe(
        true,
      );
      const rows = await charged(w);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.idempotency_key))).toEqual(
        new Set([`mcp:${s1}:2`, `mcp:${s2}:2`]),
      );
      expect(await bal(w)).toBe(1_000_000 - 8 * w.unitMicros);
    });

    it('a session-less tool call falls back to the auto key (request hash + minute bucket)', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const msg = toolCall(1, 'search_records', { site: w.site, dataset: 'listings', limit: 2 });
      const a = await rpc(w.key, msg);
      expect(a.status).toBe(200);
      expect(a.sessionId).toBeNull();
      expect(a.json.result.isError).toBeFalsy();
      // A reconnecting client whose ids restart at 1, asking something else: a fresh charge.
      const b = await rpc(
        w.key,
        toolCall(1, 'search_records', { site: w.site, dataset: 'listings', limit: 3 }),
      );
      expect(b.json.result.isError).toBeFalsy();
      expect(b.json.result.structuredContent.replay).toBe(false);
      const rows = await charged(w);
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.idempotency_key).toMatch(/^auto:[0-9a-f]{64}$/);
    });

    it('an empty balance is a tool result with the top-up link, not a transport error', async () => {
      const w = await world({ balanceMicros: 0 });
      const client = await connect(w.key);
      const res = (await client.callTool({
        name: 'search_records',
        arguments: { site: w.site, dataset: 'listings', limit: 37 },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      const price = 37 * w.unitMicros;
      expect(textOf(res)).toBe(
        `This call costs ${formatMicros(price)}; balance $0.00. Ask me to top up, or open https://spigot.test/buyers/topup.`,
      );
      const sc = res.structuredContent as {
        error: { code: string };
        topUpUrl: string;
        top_up: { tool: string; amountCents: number };
      };
      expect(sc.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(sc.topUpUrl).toBe('https://spigot.test/buyers/topup');
      expect(sc.top_up).toEqual({ tool: 'top_up', amountCents: 500 });
      expect(await charged(w)).toEqual([]);
      expect(await bal(w)).toBe(0);
    });

    it('a call above maxPriceMicros is a PRICE_ABOVE_MAX tool error and charges nothing', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const client = await connect(w.key);
      const res = (await client.callTool({
        name: 'search_records',
        arguments: { site: w.site, dataset: 'listings', limit: 10, maxPriceMicros: 1 },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect((res.structuredContent as { error: { code: string } }).error.code).toBe(
        'PRICE_ABOVE_MAX',
      );
      expect(textOf(res)).toContain('raise `maxPriceMicros`');
      expect(await calls(w)).toEqual([]);
      expect(await bal(w)).toBe(1_000_000);
    });

    it('an invented field is a tool error listing the valid fields', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const client = await connect(w.key);
      for (const name of ['search_records', 'quote']) {
        const res = (await client.callTool({
          name,
          arguments: {
            site: w.site,
            dataset: 'listings',
            filters: [{ field: 'square_feet', op: 'gte', value: 900 }],
          },
        })) as CallToolResult;
        expect(res.isError).toBe(true);
        const text = textOf(res);
        expect(text).toContain(
          'Valid filters: price_usd (eq, lt, lte, gt, gte); bedrooms (eq, gte, lte); city (eq, in); updated_at',
        );
        expect(text).not.toContain('agent_phone');
        expect((res.structuredContent as { error: { code: string } }).error.code).toBe(
          'UNSUPPORTED_FILTER',
        );
      }
      expect(await calls(w)).toEqual([]);
    });

    it('an unknown dataset is a tool error pointing at list_datasets', async () => {
      const w = await world();
      const client = await connect(w.key);
      const res = (await client.callTool({
        name: 'describe_dataset',
        arguments: { site: w.site, dataset: 'nope' },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Call list_datasets');
    });

    it('auth: no key or a bad key → 401; a revoked key → 401 on its very next request, mid-session', async () => {
      const w = await world({ balanceMicros: 1_000_000 });
      const noKey = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(noKey.status).toBe(401);
      const bad = await rpc('sk_spg_nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(bad.status).toBe(401);
      expect(bad.json.error.code).toBe('UNAUTHENTICATED');

      const sid = await rawSession(w.key);
      expect((await rpc(w.key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid)).status).toBe(
        200,
      );
      await revokeKey(app.db.pool, w.buyerId, w.keyId);
      const after = await rpc(
        w.key,
        toolCall(3, 'search_records', { site: w.site, dataset: 'listings' }),
        sid,
      );
      expect(after.status).toBe(401);
      expect(after.json.error.code).toBe('KEY_REVOKED');
      expect(await calls(w)).toEqual([]);
    });

    it("a session is bound to the key that opened it: another key gets 404, the owner's still works", async () => {
      const a = await world();
      const b = await world();
      const sid = await rawSession(a.key);
      const stolen = await rpc(b.key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
      expect(stolen.status).toBe(404);
      const unknown = await rpc(
        a.key,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        randomUUID(),
      );
      expect(unknown.status).toBe(404);
      expect((await rpc(a.key, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, sid)).status).toBe(
        200,
      );
    });

    it('a key without the read scope cannot use the data tools', async () => {
      const w = await world({ scopes: ['topup'] });
      const client = await connect(w.key);
      const res = (await client.callTool({
        name: 'list_datasets',
        arguments: {},
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect((res.structuredContent as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    });

    it('rate limit: 30 requests a minute per key, then 429 with Retry-After', async () => {
      const w = await world();
      const other = await world();
      const sid = await rawSession(w.key); // 2 requests
      for (let i = 0; i < 28; i++) {
        const r = await rpc(w.key, { jsonrpc: '2.0', id: 10 + i, method: 'tools/list' }, sid);
        expect(r.status).toBe(200);
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${w.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sid,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
      });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      // Per key: another buyer's key is unaffected.
      expect((await rpc(other.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(
        200,
      );
    });

    it('DELETE closes the session', async () => {
      const w = await world();
      const sid = await rawSession(w.key);
      const del = await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${w.key}`,
          'Mcp-Session-Id': sid,
          'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
        },
      });
      expect(del.status).toBe(200);
      expect((await rpc(w.key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid)).status).toBe(
        404,
      );
    });

    it('declares a tenancy case for /mcp', () => {
      expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual(
        expect.arrayContaining(['POST /mcp', 'GET /mcp', 'DELETE /mcp']),
      );
    });
  },
);
