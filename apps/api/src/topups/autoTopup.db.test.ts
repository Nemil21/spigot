import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { autoTopupCapReachedMessage, autoTopupDeclinedMessage } from '@spigot/shared';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { FakePayPal, type PayPalOrdersClient } from '../paypal/index.js';
import { buildServer } from '../server.js';
import { paidRead, type PaidReadResult } from '../services/paidRead.js';
import { REQUIRED_ENV } from '../test/env.js';
import { handle as handleDeniedWebhook } from '../webhooks/handlers/auto-topup.js';
import { chargeVaultTopup, reserveVaultTopup, type Reservation } from './autoTopup.js';
import { setTopupPayPal } from './deps.js';
import { topupView, type TopupRow, TOPUP_COLUMNS } from './row.js';

const FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq'] },
];

/** 40 records × $0.0015 = $0.06. */
const LIMIT = 40;
const PRICE = 60_000;
const ONE_CENT = 10_000;
const TWENTY_DOLLARS = 20_000_000;

/** Keeps every order-create body, to check the MIT `payment_source`. */
function recordingFetch(fake: FakePayPal, bodies: Record<string, unknown>[]): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === '/v2/checkout/orders' && typeof init?.body === 'string') {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return fake.fetch(input, init);
  };
}

describe.skipIf(!testDatabaseUrl)(
  'SP-047a auto top-up (Postgres, FakePayPal)',
  { timeout: 120_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let url: string;
    let fake: FakePayPal;
    let pp: PayPalOrdersClient;
    /** A second "API process": its own pool on the same database. */
    let poolB: pg.Pool;
    let dbB: Db;
    const bodies: Record<string, unknown>[] = [];
    let callsBefore = 0;
    let ordersBefore = 0;
    const clients: Client[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(
        loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
        { logger: false },
      );
      await app.listen({ port: 0, host: '127.0.0.1' });
      url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
      poolB = createPool(db.url, { max: 8, applicationName: 'test-b' });
      dbB = createDb(poolB);
      // One fake for the suite: its order ids must stay unique (`topups.paypal_order_id`).
      fake = new FakePayPal({ latencyMs: 5, jitterMs: 10 });
    }, 60_000);
    afterAll(async () => {
      setTopupPayPal(undefined);
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      await app?.close();
      await poolB?.end();
      await db?.drop();
    });
    beforeEach(() => {
      app.rateLimiter.reset();
      fake.clearFaults();
      fake.latencyMs = 5;
      callsBefore = fake.calls.length;
      ordersBefore = fake.orders().length;
      pp = fake.client({ timeoutMs: 1_000, fetch: recordingFetch(fake, bodies) });
      setTopupPayPal(pp);
    });

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    interface World {
      site: string;
      buyerId: string;
      apiKeyId: string;
      key: string;
      vaultId: string;
    }

    /** A LIVE `listings` dataset of 120 records and a buyer with auto top-up on and a saved card. */
    async function world(
      opts: { balanceMicros?: number; capCents?: number; enabled?: boolean } = {},
    ): Promise<World> {
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
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count)
         VALUES ($1, 'listings', 'Listing', 'LIVE', 120) RETURNING id`,
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
         SELECT $1, 'l-' || i, jsonb_build_object('title', 'Listing ' || i, 'city', 'Austin'),
                md5(i::text), 1, now(), timestamptz '2026-11-11T00:00:00Z' + i * interval '1 second'
           FROM generate_series(1, 120) i`,
        [ds!.id],
      );
      const vaultId = fake.seedVault('card');
      const [buyer] = await q<{ id: string }>(
        `INSERT INTO buyers (name, auto_topup_enabled, auto_topup_amount_cents, monthly_topup_cap_cents,
                             vault_id, vault_kind)
         VALUES ($1, $2, 2000, $3, $4, 'CARD') RETURNING id`,
        [`Buyer ${tag}`, opts.enabled ?? true, opts.capCents ?? 10_000, vaultId],
      );
      const k = await createKey(app.db.pool, buyer!.id, { scopes: ['read', 'topup'] });
      const balanceMicros = opts.balanceMicros ?? ONE_CENT;
      if (balanceMicros > 0) {
        await app.db.tx(async (tx) => {
          const b = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyer!.id);
          const { paypalCash } = await platformAccounts(tx);
          await post(tx, {
            kind: 'TOPUP',
            idempotencyKey: `topup:${randomUUID()}`,
            entries: topupEntries({ buyer: b, paypalCash }, balanceMicros),
          });
        });
      }
      return { site, buyerId: buyer!.id, apiKeyId: k.id, key: k.key, vaultId };
    }

    const balance = async (w: World) =>
      Number(
        (
          await q<{ b: string }>(
            `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
            [w.buyerId],
          )
        )[0]?.b ?? 0,
      );
    const topups = (w: World) =>
      q<TopupRow>(`SELECT ${TOPUP_COLUMNS} FROM topups WHERE buyer_id = $1 ORDER BY created_at`, [
        w.buyerId,
      ]);
    const enabled = async (w: World) =>
      (
        await q<{ on: boolean }>(`SELECT auto_topup_enabled AS on FROM buyers WHERE id = $1`, [
          w.buyerId,
        ])
      )[0]!.on;
    /** This test's order creates and orders. */
    const creates = () => fake.calls.slice(callsBefore).filter((c) => c.op === 'order_create');
    const orders = () => fake.orders().slice(ordersBefore);
    const topupTxns = (topupId: string) =>
      q(`SELECT id FROM ledger_txns WHERE kind = 'TOPUP' AND idempotency_key = $1`, [
        `topup:${topupId}`,
      ]);

    /** A vault top-up already on the books this month (e.g. the agent's MCP `top_up`). */
    async function priorVaultTopup(
      w: World,
      cents: number,
      opts: { trigger?: 'AUTO' | 'MCP'; status?: string; createdAt?: string } = {},
    ) {
      await q(
        `INSERT INTO topups (buyer_id, amount_cents, method, trigger, status, created_at)
         VALUES ($1, $2, 'VAULT_MIT', $3, $4, coalesce($5::timestamptz, now()))`,
        [
          w.buyerId,
          cents,
          opts.trigger ?? 'MCP',
          opts.status ?? 'COMPLETED',
          opts.createdAt ?? null,
        ],
      );
    }

    const get = (w: World, idempotencyKey = randomUUID()) =>
      fetch(`${url.replace(/\/mcp$/, '')}/v1/${w.site}/datasets/listings/records?limit=${LIMIT}`, {
        headers: { Authorization: `Bearer ${w.key}`, 'Idempotency-Key': idempotencyKey },
      });

    /** A paid read straight through `paidRead`, on either "process". */
    const read = (w: World, on: Db = app.db, timeoutMs?: number): Promise<PaidReadResult> =>
      paidRead(
        {
          db: on,
          buyerId: w.buyerId,
          apiKeyId: w.apiKeyId,
          channel: 'REST',
          baseUrl: REQUIRED_ENV.APP_BASE_URL!,
          autoTopup: {
            pp,
            config: app.config,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        },
        {
          site: w.site,
          dataset: 'listings',
          kind: 'records',
          limit: LIMIT,
          idempotencyKey: randomUUID(),
        },
      );

    it('$0.01 left + a $0.06 call → one $20 MIT top-up, then the call succeeds (REST)', async () => {
      const w = await world();
      bodies.length = 0;
      const res = await get(w);
      expect(res.status).toBe(200);
      expect(res.headers.get('spigot-auto-topup')).toBe('2000');
      expect(res.headers.get('spigot-charged-micros')).toBe(String(PRICE));
      expect(res.headers.get('spigot-balance-micros')).toBe(
        String(ONE_CENT + TWENTY_DOLLARS - PRICE),
      );

      const rows = await topups(w);
      expect(rows).toHaveLength(1);
      const t = rows[0]!;
      expect(t).toMatchObject({
        method: 'VAULT_MIT',
        trigger: 'AUTO',
        status: 'COMPLETED',
        amountCents: 2000,
      });
      // W11's top-ups table (`GET /api/buyer/topups` → `topupView`) shows trigger AUTO.
      expect(topupView(t).trigger).toBe('AUTO');
      expect(await topupTxns(t.id)).toHaveLength(1);

      // One merchant-initiated order on the saved card, request id = topup id.
      expect(creates()).toHaveLength(1);
      expect(creates()[0]!.requestId).toBe(t.id);
      expect(bodies.at(-1)).toMatchObject({
        intent: 'CAPTURE',
        purchase_units: [{ custom_id: t.id, amount: { value: '20.00', currency_code: 'USD' } }],
        payment_source: {
          card: {
            vault_id: w.vaultId,
            stored_credential: {
              payment_initiator: 'MERCHANT',
              payment_type: 'UNSCHEDULED',
              usage: 'SUBSEQUENT',
            },
          },
        },
      });

      const [call] = await q<{ status: string }>(
        `SELECT status FROM api_calls WHERE buyer_id = $1`,
        [w.buyerId],
      );
      expect(call!.status).toBe('CHARGED');
    });

    it('MCP search_records says "Topped up $20 from your saved PayPal method"', async () => {
      const w = await world();
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${w.key}` } },
      });
      const client = new Client({ name: 'sp-047a-test', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      const r = (await client.callTool({
        name: 'search_records',
        arguments: { site: w.site, dataset: 'listings', limit: LIMIT },
      })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      const text = (r.content[0] as { text: string }).text;
      expect(text).toMatch(/^Topped up \$20 from your saved PayPal method\. /);
      expect((await topups(w))[0]).toMatchObject({ trigger: 'AUTO', status: 'COMPLETED' });
    });

    it('an injected decline fails the top-up, turns auto top-up off and returns 402', async () => {
      const w = await world();
      fake.failNext('order_create', { kind: 'decline' });
      const res = await get(w);
      expect(res.status).toBe(402);
      expect(res.headers.get('spigot-auto-topup')).toBeNull();
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error).toEqual({ code: 'TOPUP_FAILED', message: autoTopupDeclinedMessage() });

      const [t] = await topups(w);
      expect(t).toMatchObject({ status: 'FAILED', trigger: 'AUTO', method: 'VAULT_MIT' });
      expect(t!.errorCode).toBeTruthy();
      expect(await enabled(w)).toBe(false);
      expect(await balance(w)).toBe(ONE_CENT);
      const [audit] = await q<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'TOPUP_FAILED'`,
        [t!.id],
      );
      expect(audit!.data).toMatchObject({ autoTopupDisabled: true, trigger: 'AUTO' });

      // Auto top-up is off now: the next short call is a plain 402 with no PayPal call.
      const before = creates().length;
      const again = await get(w);
      expect(again.status).toBe(402);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
        'INSUFFICIENT_BALANCE',
      );
      expect(creates()).toHaveLength(before);
    });

    it('MCP vault top-ups count toward the cap: an AUTO top-up past it → 402 AUTO_TOPUP_CAP_REACHED, no PayPal call', async () => {
      const w = await world({ capCents: 10_000 });
      await priorVaultTopup(w, 5_000, { trigger: 'MCP' });
      await priorVaultTopup(w, 4_000, { trigger: 'MCP' });
      // $90 used + $20 > $100.
      const res = await get(w);
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error).toEqual({
        code: 'AUTO_TOPUP_CAP_REACHED',
        message: autoTopupCapReachedMessage({ monthlyCapCents: 10_000 }),
      });
      expect(creates()).toHaveLength(0);
      expect((await topups(w)).filter((t) => t.trigger === 'AUTO')).toHaveLength(0);
    });

    it('the cap is inclusive: $80 used + $20 = $100 still tops up', async () => {
      const w = await world({ capCents: 10_000 });
      await priorVaultTopup(w, 8_000, { trigger: 'MCP' });
      const res = await get(w);
      expect(res.status).toBe(200);
      expect(res.headers.get('spigot-auto-topup')).toBe('2000');
    });

    it('cap math across a month boundary (UTC): last month does not count', async () => {
      const w = await world({ capCents: 10_000, balanceMicros: 0 });
      // $100 of vault top-ups in the last second of October (UTC).
      await priorVaultTopup(w, 10_000, { createdAt: '2026-10-31T23:59:59.999Z' });
      // A FAILED one this month never counts.
      await priorVaultTopup(w, 5_000, { status: 'FAILED', createdAt: '2026-11-01T00:00:00Z' });

      const october = await reserveVaultTopup(app.db, {
        buyerId: w.buyerId,
        trigger: 'AUTO',
        now: new Date('2026-10-31T23:59:59.999Z'),
      });
      expect(october).toMatchObject({
        kind: 'CAP_REACHED',
        usedCents: 10_000,
        monthlyCapCents: 10_000,
      });

      const november = await reserveVaultTopup(app.db, {
        buyerId: w.buyerId,
        trigger: 'AUTO',
        now: new Date('2026-11-01T00:00:00.000Z'),
      });
      expect(november.kind).toBe('RESERVED');
    });

    it('20 parallel short calls on two processes → exactly one $20 auto top-up, all charged', async () => {
      const w = await world();
      fake.latencyMs = 30;
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => read(w, i % 2 ? dbB : app.db)),
      );
      for (const r of results) expect([200, 402]).toContain(r.status);
      // Calls queued behind the first top-up wait for it and then see the new balance.
      expect(results.filter((r) => r.status === 200)).toHaveLength(20);
      expect(results.filter((r) => r.autoTopupCents === 2000)).toHaveLength(1);

      const rows = await topups(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        method: 'VAULT_MIT',
        status: 'COMPLETED',
        amountCents: 2000,
      });
      expect(creates()).toHaveLength(1);
      expect(orders()).toHaveLength(1);
      expect(await topupTxns(rows[0]!.id)).toHaveLength(1);
      expect(await balance(w)).toBe(ONE_CENT + TWENTY_DOLLARS - 20 * PRICE);
    });

    it('one VAULT_MIT in flight: 10 racing reservations (AUTO and MCP) → one row', async () => {
      const w = await world();
      const results: Reservation[] = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          reserveVaultTopup(i % 2 ? dbB : app.db, {
            buyerId: w.buyerId,
            trigger: i % 3 ? 'AUTO' : 'MCP',
          }),
        ),
      );
      expect(results.filter((r) => r.kind === 'RESERVED')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'IN_FLIGHT')).toHaveLength(9);
      expect(await topups(w)).toHaveLength(1);
    });

    it('an orphaned CREATED vault top-up (older than the budget) → prompt plain 402, no PayPal call', async () => {
      const w = await world();
      // A top-up whose call timed out a minute ago, still waiting for SP-047c's sweep.
      await priorVaultTopup(w, 2_000, {
        trigger: 'AUTO',
        status: 'CREATED',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const started = Date.now();
      const r = await read(w);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(r.status).toBe(402);
      expect((r.body as { error: { code: string } }).error.code).toBe('INSUFFICIENT_BALANCE');
      expect(creates()).toHaveLength(0);
      expect(await topups(w)).toHaveLength(1);
    });

    it('MCP top_up from the vault racing an AUTO top-up → one VAULT_MIT order; the cap counts it', async () => {
      const w = await world({ capCents: 3_000 });
      fake.latencyMs = 40;
      const mcp = (async () => {
        const r = await reserveVaultTopup(dbB, { buyerId: w.buyerId, trigger: 'MCP' });
        if (r.kind !== 'RESERVED') return r.kind;
        const out = await chargeVaultTopup({ db: dbB, pp, config: app.config }, r);
        return out.status;
      })();
      const [mcpResult, auto] = await Promise.all([mcp, read(w)]);

      const rows = await topups(w);
      expect(rows).toHaveLength(1);
      expect(creates()).toHaveLength(1);
      expect(rows[0]!.status).toBe('COMPLETED');
      // Whichever reserved first charged; the other waited (AUTO) or saw it in flight (MCP).
      expect(auto.status).toBe(200);
      expect(['COMPLETED', 'IN_FLIGHT']).toContain(mcpResult);

      // $20 used of a $30 cap: the next vault top-up of either kind is refused.
      const next = await reserveVaultTopup(app.db, { buyerId: w.buyerId, trigger: 'MCP' });
      expect(next).toMatchObject({ kind: 'CAP_REACHED', usedCents: 2_000 });
    });

    it('MIT create response lost → the retry with the same request id gets the same order → credited once', async () => {
      const w = await world();
      pp = fake.client({ timeoutMs: 200 });
      fake.failNext('order_create', { kind: 'drop_response' });
      const r = await read(w);
      expect(r.status).toBe(200);
      expect(r.autoTopupCents).toBe(2000);

      const [t] = await topups(w);
      expect(t!.status).toBe('COMPLETED');
      const mine = creates().filter((c) => c.requestId === t!.id);
      expect(mine.length).toBe(2);
      expect(orders().filter((o) => o.customId === t!.id)).toHaveLength(1);
      expect(await topupTxns(t!.id)).toHaveLength(1);
      expect(await balance(w)).toBe(ONE_CENT + TWENTY_DOLLARS - PRICE);
    });

    it('PayPal slower than the budget → 402 now; the top-up credits in the background, once', async () => {
      const w = await world();
      pp = fake.client({ timeoutMs: 300 });
      fake.failNext('order_create', { kind: 'timeout' });
      const r = await read(w, app.db, 100);
      expect(r.status).toBe(402);
      expect((r.body as { error: { code: string } }).error.code).toBe('INSUFFICIENT_BALANCE');
      expect(r.autoTopupCents).toBeUndefined();
      const [pending] = await topups(w);
      expect(pending!.status).toBe('CREATED');

      // The client's retry (same request id) lands and credits.
      for (let i = 0; i < 50 && (await topups(w))[0]!.status !== 'COMPLETED'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const [t] = await topups(w);
      expect(t!.status).toBe('COMPLETED');
      expect(await topupTxns(t!.id)).toHaveLength(1);
      expect(await balance(w)).toBe(ONE_CENT + TWENTY_DOLLARS);
    });

    it('no auto top-up when it is off, when there is no vault, or when $20 would not cover the call', async () => {
      const off = await world({ enabled: false });
      expect((await read(off)).status).toBe(402);

      const noVault = await world();
      await q(`UPDATE buyers SET vault_id = NULL, vault_kind = NULL WHERE id = $1`, [
        noVault.buyerId,
      ]);
      expect((await read(noVault)).status).toBe(402);

      const w = await world();
      expect(
        await reserveVaultTopup(app.db, {
          buyerId: w.buyerId,
          trigger: 'AUTO',
          priceMicros: ONE_CENT + TWENTY_DOLLARS + 1,
        }),
      ).toMatchObject({ kind: 'WOULD_NOT_HELP' });
      expect(creates()).toHaveLength(0);
      expect(await topups(off)).toHaveLength(0);
      expect(await topups(noVault)).toHaveLength(0);
      expect(await topups(w)).toHaveLength(0);
    });

    it('PAYMENT.CAPTURE.DENIED for a held vault top-up → FAILED and auto top-up off (SP-059 handler)', async () => {
      const w = await world();
      await priorVaultTopup(w, 2_000, { trigger: 'AUTO', status: 'AWAITING_APPROVAL' });
      const [t] = await topups(w);
      const event = {
        id: `WH-${randomUUID()}`,
        event_type: 'PAYMENT.CAPTURE.DENIED',
        resource: { id: 'CAP-1', custom_id: t!.id },
      };
      expect(await app.db.tx((tx) => handleDeniedWebhook(tx, event))).toBe('HANDLED');
      expect((await topups(w))[0]).toMatchObject({ status: 'FAILED', errorCode: 'CAPTURE_DENIED' });
      expect(await enabled(w)).toBe(false);
      // Replayed delivery: nothing more to do.
      expect(await app.db.tx((tx) => handleDeniedWebhook(tx, event))).toBe('SKIPPED');

      // A wallet top-up is not this handler's business.
      const [wallet] = await q<{ id: string }>(
        `INSERT INTO topups (buyer_id, amount_cents, method, trigger, status)
         VALUES ($1, 2000, 'PAYPAL_WALLET', 'MANUAL', 'AWAITING_APPROVAL') RETURNING id`,
        [w.buyerId],
      );
      expect(
        await app.db.tx((tx) =>
          handleDeniedWebhook(tx, { ...event, resource: { custom_id: wallet!.id } }),
        ),
      ).toBe('SKIPPED');
    });
  },
);
