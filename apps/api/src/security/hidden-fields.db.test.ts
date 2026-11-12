import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
import { REQUIRED_ENV } from '../test/env.js';
import { routeTable } from './routeTable.js';

/**
 * SP-042: "hidden fields never leave" (data-model rule 13; features/14 §Acceptance criteria) swept
 * across every `/v1` read in the route table and every MCP tool the server lists.
 *
 * The dataset's v1 schema had `agent_phone` visible; the owner hid it, and the active v2 schema
 * says `visible: false` (still marked filterable, to prove hidden wins over filterable). Every
 * stored record and every change patch still carries the phone number. No reply may contain the
 * field name or any of its values; filtering on it is a 400 (REST) / tool error (MCP).
 */

const HIDDEN = 'agent_phone';
const PHONE = '512-555-';
const visible = (v: boolean) => [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq', 'in'] },
  { name: 'bedrooms', type: 'integer', visible: true, filterable: ['eq', 'gte', 'lte'] },
  { name: HIDDEN, type: 'string', visible: v, filterable: ['eq'] },
];

/** MCP tools with no dataset data out (balance, top-up, claims): nothing to sweep. */
const MCP_NO_DATASET = ['get_balance', 'top_up', 'report_bad_record'];

describe.skipIf(!testDatabaseUrl)(
  'SP-042 hidden-field sweep (Postgres)',
  { timeout: 120_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let base: string;
    let site: string;
    let key: string;
    let client: Client;

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url }), {
        logger: false,
      });
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
       VALUES ($1, 'listings', 'Listing', 'LIVE', 30) RETURNING id`,
        [s!.id],
      );
      await q(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'SUPERSEDED', $2, '{}', '{"from":"url"}', 'AI')`,
        [ds!.id, JSON.stringify(visible(true))],
      );
      const [v2] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 2, 'APPROVED', $2, '{}', '{"from":"url"}', 'OWNER') RETURNING id`,
        [ds!.id, JSON.stringify(visible(false))],
      );
      await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, v2!.id]);
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
       SELECT $1::uuid, 'l-' || i,
              jsonb_build_object('title', 'Listing ' || i, 'city', (ARRAY['Austin','Dallas'])[i % 2 + 1],
                'bedrooms', i % 5, '${HIDDEN}', '${PHONE}' || lpad(i::text, 4, '0')),
              md5(i::text), 2, now(), now()
         FROM generate_series(1, 30) i`,
        [ds!.id],
      );
      // Each record: an `add` with the whole object, then an `update` replacing only the hidden field.
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
       SELECT $1, r.id, 1, 'add',
              jsonb_build_array(jsonb_build_object('op','add','path','','value', r.data)), r.hash
         FROM records r WHERE r.dataset_id = $1 ORDER BY r.record_key`,
        [ds!.id],
      );
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
       SELECT $1, r.id, 2, 'update',
              jsonb_build_array(jsonb_build_object('op','replace','path','/${HIDDEN}',
                'value', '${PHONE}9999')), r.hash
         FROM records r WHERE r.dataset_id = $1 ORDER BY r.record_key`,
        [ds!.id],
      );
      await q(
        `UPDATE datasets SET published_seq = (SELECT max(seq) FROM record_versions WHERE dataset_id = $1)
        WHERE id = $1`,
        [ds!.id],
      );

      const [buyer] = await q<{ id: string }>(
        `INSERT INTO buyers (name, per_call_max_micros) VALUES ('Sweeper', 100000000) RETURNING id`,
      );
      key = (await createKey(app.db.pool, buyer!.id, { scopes: ['read', 'topup'] })).key;
      await app.db.tx(async (tx) => {
        const acct = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyer!.id);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer: acct, paypalCash }, 50_000_000),
        });
      });

      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
      client = new Client({ name: 'sp042-sweep', version: '1.0.0' });
      await client.connect(transport);
    });
    afterAll(async () => {
      await client?.close().catch(() => {});
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => app.rateLimiter.reset());

    const get = async (path: string) => {
      const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
      return { status: res.status, text: await res.text() };
    };

    function expectClean(text: string, label: string) {
      expect(text.includes(HIDDEN), `${label} names the hidden field`).toBe(false);
      expect(text.includes(PHONE), `${label} carries a hidden value`).toBe(false);
    }

    /** Every request to make for a `/v1` GET route (unknown future routes: params filled, as-is). */
    function v1Requests(url: string): string[] {
      const p = url.replace(':site', site).replace(':dataset', 'listings').replace(':key', 'l-1');
      const variants: Record<string, string[]> = {
        '/v1/:site/datasets/:dataset/records': [
          `${p}?limit=30`,
          `${p}?city=Austin&limit=30`,
          `${p}?bedrooms[gte]=2&limit=30`,
        ],
        '/v1/:site/datasets/:dataset/changes': [
          `${p}?since=0&limit=1000`,
          `${p}?since=0&limit=1000&include=record`,
        ],
        '/v1/:site/datasets/:dataset/quote': [`${p}?limit=30`, `${p}?city=Austin`],
      };
      return variants[url] ?? [p];
    }

    it('every /v1 read in the route table: the hidden field and its values never appear', async () => {
      await app.ready();
      const reads = routeTable(app).filter((r) => r.method === 'GET' && r.url.startsWith('/v1/'));
      expect(reads.map((r) => r.url)).toEqual(
        expect.arrayContaining([
          '/v1/catalog',
          '/v1/:site/datasets/:dataset',
          '/v1/:site/datasets/:dataset/quote',
          '/v1/:site/datasets/:dataset/records',
          '/v1/:site/datasets/:dataset/records/:key',
          '/v1/:site/datasets/:dataset/changes',
        ]),
      );
      let swept = 0;
      for (const r of reads) {
        for (const path of v1Requests(r.url)) {
          const res = await get(path);
          expect(res.status, `${path}: ${res.text.slice(0, 200)}`).toBe(200);
          expectClean(res.text, path);
          swept++;
        }
      }
      expect(swept).toBeGreaterThanOrEqual(10);
    });

    it('records and changes still serve the visible fields (the sweep is not vacuous)', async () => {
      const rec = await get(`/v1/${site}/datasets/listings/records/l-1`);
      expect(rec.text).toContain('Listing 1');
      const all = await get(
        `/v1/${site}/datasets/listings/changes?since=0&limit=1000&include=record`,
      );
      expect(all.text).toContain('Listing 30');
      // In the store, the phone is there: the serializer is what keeps it out.
      const [row] = await q<{ data: Record<string, string> }>(
        `SELECT data FROM records WHERE record_key = 'l-1'`,
      );
      expect(row!.data[HIDDEN]).toBe(`${PHONE}0001`);
    });

    it.each([
      ['records', `${HIDDEN}=${PHONE}0001`],
      ['records', `${HIDDEN}[eq]=${PHONE}0001`],
      ['quote', `${HIDDEN}=${PHONE}0001`],
      ['quote', `${HIDDEN}[eq]=${PHONE}0001`],
    ])('/v1 %s filtered on the hidden field (%s) → 400 UNSUPPORTED_FILTER', async (route, qs) => {
      const res = await get(`/v1/${site}/datasets/listings/${route}?${qs}`);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text).error.code).toBe('UNSUPPORTED_FILTER');
      // The 400 lists the valid filters: the hidden field is not one of them.
      const listed = JSON.parse(res.text).error.details?.validFilters as { field: string }[];
      expect(listed.map((f) => f.field)).not.toContain(HIDDEN);
    });

    /** Arguments for every MCP tool that reads dataset data. A new tool must be added here. */
    const mcpCalls = (): Record<string, Record<string, unknown>[]> => ({
      list_datasets: [{ query: site }, {}],
      describe_dataset: [{ site, dataset: 'listings' }],
      quote: [
        { site, dataset: 'listings', limit: 30 },
        { site, dataset: 'listings', filters: [{ field: 'city', op: 'eq', value: 'Austin' }] },
      ],
      search_records: [
        { site, dataset: 'listings', limit: 30 },
        { site, dataset: 'listings', filters: [{ field: 'bedrooms', op: 'gte', value: 2 }] },
      ],
      get_changes: [
        { site, dataset: 'listings', since: '0', limit: 1000 },
        { site, dataset: 'listings', since: '0', limit: 1000, includeRecord: true },
      ],
    });

    it('every MCP tool the server lists: the hidden field and its values never appear', async () => {
      const { tools } = await client.listTools();
      const calls = mcpCalls();
      const unswept = tools
        .map((t) => t.name)
        .filter((n) => !(n in calls) && !MCP_NO_DATASET.includes(n));
      expect(unswept, 'new MCP tools must be added to the hidden-field sweep').toEqual([]);
      for (const t of tools) {
        expectClean(JSON.stringify(t), `tool definition ${t.name}`);
        for (const args of calls[t.name] ?? []) {
          const res = (await client.callTool({ name: t.name, arguments: args })) as CallToolResult;
          const label = `${t.name}(${JSON.stringify(args)})`;
          expect(res.isError, `${label}: ${JSON.stringify(res.content)}`).toBeFalsy();
          expectClean(JSON.stringify(res), label);
        }
      }
      const desc = (await client.callTool({
        name: 'describe_dataset',
        arguments: { site, dataset: 'listings' },
      })) as CallToolResult;
      expect(JSON.stringify(desc)).toContain('bedrooms');
    });

    it.each(['search_records', 'quote'])(
      'MCP %s filtered on the hidden field → UNSUPPORTED_FILTER tool error, nothing charged',
      async (tool) => {
        const before = await q(`SELECT count(*)::int AS n FROM api_calls WHERE status = 'CHARGED'`);
        // A client that never listed tools: the SDK client validates an error result against the
        // cached output schema (see the PR's follow-up note), which would mask the tool error.
        const fresh = new Client({ name: 'sp042-filter', version: '1.0.0' });
        await fresh.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${key}` } },
          }),
        );
        const res = (await fresh.callTool({
          name: tool,
          arguments: {
            site,
            dataset: 'listings',
            filters: [{ field: HIDDEN, op: 'eq', value: `${PHONE}0001` }],
          },
        })) as CallToolResult;
        expect(res.isError).toBe(true);
        expect((res.structuredContent as { error: { code: string } }).error.code).toBe(
          'UNSUPPORTED_FILTER',
        );
        expect(JSON.stringify(res)).not.toContain(PHONE);
        await fresh.close();
        expect(
          await q(`SELECT count(*)::int AS n FROM api_calls WHERE status = 'CHARGED'`),
        ).toEqual(before);
      },
    );
  },
);
