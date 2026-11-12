import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { autoTopupCapReachedMessage, autoTopupDeclinedMessage } from '@spigot/shared';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { demoDecline } from '../cli/demoDecline.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { FakePayPal, type PayPalOrdersClient } from '../paypal/index.js';
import { topupResponse } from '../routes/v1.schemas.js';
import { cases } from '../security/tenancy/buyer-auto-topup.cases.js';
import { buildServer } from '../server.js';
import { agentTopUp } from '../services/agentTopUp.js';
import { ApiError } from '../http/errors.js';
import { REQUIRED_ENV } from '../test/env.js';
import { balanceOf, setTopupPayPal } from './index.js';

/**
 * SP-047b against real HTTP (Fastify + the MCP client SDK, as `mcp-remote` drives it for Claude
 * Desktop) and Postgres, FakePayPal for PayPal: `PUT /api/buyer/auto-topup`, MCP `top_up` /
 * `POST /v1/topups` charging the saved method within the cap, and `demo:decline` → W11's
 * declined banner.
 */
const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const TWENTY = 20_000_000;
const ONE_CENT = 10_000;
/** 40 records × $0.0015 = $0.06. */
const LIMIT = 40;

type Text = { type: 'text'; text: string };
const textOf = (r: CallToolResult) => (r.content[0] as Text).text;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface Buyer {
  id: string;
  email: string;
  cookie: string;
  key: string;
  keyId: string;
  site: string;
}

describe.skipIf(!testDatabaseUrl)(
  'SP-047b auto top-up settings, MCP top_up from the vault, demo:decline (Postgres, FakePayPal)',
  { timeout: 120_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let base: string;
    let fake: FakePayPal;
    let pp: PayPalOrdersClient;
    let callsBefore = 0;
    const clients: Client[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(
        loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
        { logger: false },
      );
      await app.listen({ port: 0, host: '127.0.0.1' });
      base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
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
      callsBefore = fake.calls.length;
      pp = fake.client({ timeoutMs: 1_000 });
      setTopupPayPal(pp);
    });

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];
    const http = () => request(app.server);
    const creates = () => fake.calls.slice(callsBefore).filter((c) => c.op === 'order_create');

    /**
     * A signed-up buyer (session cookie), an API key and a LIVE dataset to buy from. `vault` saves
     * a card as a top-up with "Save for auto top-up" would; `enabled` turns auto top-up on.
     */
    async function buyer(
      opts: { vault?: boolean; enabled?: boolean; capCents?: number; balanceMicros?: number } = {},
    ): Promise<Buyer> {
      const tag = randomUUID().slice(0, 8);
      const email = `b-${tag}@example.com`;
      const res = await http()
        .post('/api/buyer/signup')
        .set('Origin', ORIGIN)
        .send({ name: `Agent ${tag}`, email, password: 'correct horse' });
      expect(res.status).toBe(201);
      const id = res.body.buyerId as string;
      if (opts.vault) {
        await q(
          `UPDATE buyers SET vault_id = $2, vault_kind = 'CARD', vault_label = 'Visa ••1111',
                  auto_topup_enabled = $3, monthly_topup_cap_cents = $4 WHERE id = $1`,
          [id, fake.seedVault('card'), opts.enabled ?? false, opts.capCents ?? 10_000],
        );
      }
      const balanceMicros = opts.balanceMicros ?? 0;
      if (balanceMicros > 0) {
        await app.db.tx(async (tx) => {
          const b = await getOrCreateAccount(tx, 'BUYER_BALANCE', id);
          const { paypalCash } = await platformAccounts(tx);
          await post(tx, {
            kind: 'TOPUP',
            idempotencyKey: `topup:${randomUUID()}`,
            entries: topupEntries({ buyer: b, paypalCash }, balanceMicros),
          });
        });
      }
      const k = await createKey(app.db.pool, id, { scopes: ['read', 'topup'] });
      return { id, email, cookie: cookiesOf(res), key: k.key, keyId: k.id, site: await site(tag) };
    }

    async function site(tag: string): Promise<string> {
      const slug = `s-${tag}`;
      const [pub] = await q<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email) VALUES ($1, $2, $2) RETURNING id`,
        [`Pub ${tag}`, `pub-${tag}@example.com`],
      );
      const [s] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
         VALUES ($1, $2, $3, 'v', 'c', 'g', 'READY') RETURNING id`,
        [pub!.id, `https://${tag}.example.com`, slug],
      );
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count)
         VALUES ($1, 'listings', 'Listing', 'LIVE', 120) RETURNING id`,
        [s!.id],
      );
      const fields = [{ name: 'title', type: 'string', visible: true, filterable: [] }];
      const [sv] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
         VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
        [ds!.id, JSON.stringify(fields)],
      );
      await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
         SELECT $1, 'l-' || i, jsonb_build_object('title', 'Listing ' || i), md5(i::text), 1, now(),
                timestamptz '2026-11-11T00:00:00Z' + i * interval '1 second'
           FROM generate_series(1, 120) i`,
        [ds!.id],
      );
      return slug;
    }

    const getSettings = (b: Pick<Buyer, 'cookie'>, query = '') =>
      http().get(`/api/buyer/auto-topup${query}`).set('Cookie', b.cookie);
    const putSettings = (b: Pick<Buyer, 'cookie'>, body: Record<string, unknown>) =>
      http().put('/api/buyer/auto-topup').set('Origin', ORIGIN).set('Cookie', b.cookie).send(body);
    const ON = {
      enabled: true,
      amountCents: 2000,
      thresholdMicros: 2_000_000,
      monthlyCapCents: 10_000,
    };

    /** A paid read the balance may not cover (REST, the same `chargeAndRecord` path as MCP). */
    const shortCall = (b: Buyer) =>
      fetch(`${base}/v1/${b.site}/datasets/listings/records?limit=${LIMIT}`, {
        headers: { Authorization: `Bearer ${b.key}`, 'Idempotency-Key': randomUUID() },
      });

    const vaultTopups = (b: Buyer) =>
      q<{ id: string; status: string; trigger: string; amount_cents: number }>(
        `SELECT id, status, trigger, amount_cents FROM topups
          WHERE buyer_id = $1 AND method = 'VAULT_MIT' ORDER BY created_at`,
        [b.id],
      );

    async function connect(key: string): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
      const client = new Client({ name: 'sp-047b-test', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    }
    const topUp = async (client: Client, args: Record<string, unknown>) =>
      (await client.callTool({ name: 'top_up', arguments: args })) as CallToolResult;

    // ------------------------------------------------------------------------------------------
    // PUT / GET /api/buyer/auto-topup

    it('reads the defaults; needs a session', async () => {
      expect((await http().get('/api/buyer/auto-topup')).status).toBe(401);
      expect(
        (await http().put('/api/buyer/auto-topup').set('Origin', ORIGIN).send(ON)).status,
      ).toBe(401);
      const b = await buyer();
      const res = await getSettings(b);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        enabled: false,
        amountCents: 2000,
        thresholdMicros: 2_000_000,
        monthlyCapCents: 10_000,
        usedThisMonthCents: 0,
        remainingThisMonthCents: 10_000,
        savedMethod: null,
        capReached: false,
        declinedAt: null,
      });
    });

    it('enabling without a saved method → 422 NO_SAVED_METHOD with an explanation, nothing saved', async () => {
      const b = await buyer();
      const res = await putSettings(b, { ...ON, amountCents: 5000, monthlyCapCents: 20_000 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('NO_SAVED_METHOD');
      expect(res.body.error.message).toMatch(/needs a saved payment method/);
      expect(res.body.error.message).toMatch(/Save for auto top-up/);
      const [row] = await q<{ enabled: boolean; amount: number }>(
        `SELECT auto_topup_enabled AS enabled, auto_topup_amount_cents AS amount FROM buyers WHERE id = $1`,
        [b.id],
      );
      expect(row).toEqual({ enabled: false, amount: 2000 });

      // Off is fine without a method: the numbers are kept for later.
      const off = await putSettings(b, {
        ...ON,
        enabled: false,
        amountCents: 5000,
        monthlyCapCents: 20_000,
      });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({
        enabled: false,
        amountCents: 5000,
        monthlyCapCents: 20_000,
      });
    });

    it('validates: amount $5–$500, cap ≥ amount, no unknown fields', async () => {
      const b = await buyer({ vault: true });
      for (const bad of [
        { ...ON, amountCents: 499 },
        { ...ON, amountCents: 50_001, monthlyCapCents: 60_000 },
        { ...ON, amountCents: 2000.5 },
        { ...ON, amountCents: 3000, monthlyCapCents: 2500 },
        { ...ON, thresholdMicros: -1 },
        { ...ON, buyerId: randomUUID() },
        { enabled: true },
      ]) {
        const res = await putSettings(b, bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      // Boundaries pass.
      expect((await putSettings(b, { ...ON, amountCents: 500, monthlyCapCents: 500 })).status).toBe(
        200,
      );
      expect(
        (await putSettings(b, { ...ON, amountCents: 50_000, monthlyCapCents: 50_000 })).status,
      ).toBe(200);
    });

    it('with a saved method: "$20 when below $2, max $100/month", label shown, vault id never sent, audited', async () => {
      const b = await buyer({ vault: true });
      const res = await putSettings(b, ON);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ...ON,
        savedMethod: { kind: 'CARD', label: 'Visa ••1111' },
        remainingThisMonthCents: 10_000,
        capReached: false,
        declinedAt: null,
      });
      const [{ vault_id: vaultId }] = await q<{ vault_id: string }>(
        `SELECT vault_id FROM buyers WHERE id = $1`,
        [b.id],
      );
      expect(JSON.stringify(res.body)).not.toContain(vaultId);
      const audits = await q<{ data: { autoTopup: { to: unknown } } }>(
        `SELECT data FROM audit_events WHERE action = 'SETTINGS_CHANGED' AND entity = 'buyers' AND entity_id = $1`,
        [b.id],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]!.data.autoTopup.to).toEqual(ON);
    });

    it(`tenancy: ${cases.map((c) => `${c.method} ${c.url}`).join(', ')}`, async () => {
      const a = await buyer({ vault: true });
      const bb = await buyer({ vault: true });
      await putSettings(bb, { ...ON, amountCents: 700, monthlyCapCents: 700 });
      const read = await getSettings(a, `?buyerId=${bb.id}`);
      expect(read.body.amountCents).toBe(2000);
      expect((await putSettings(a, { ...ON, buyerId: bb.id })).status).toBe(400);
      await putSettings(a, { ...ON, amountCents: 3000 });
      expect((await getSettings(bb)).body).toMatchObject({ enabled: true, amountCents: 700 });
    });

    // ------------------------------------------------------------------------------------------
    // MCP `top_up` / POST /v1/topups from the vault

    it('Claude Desktop top_up with a saved method → COMPLETED and the balance rises (trigger MCP)', async () => {
      const b = await buyer({ vault: true, balanceMicros: ONE_CENT });
      const client = await connect(b.key);
      const r = await topUp(client, { amountCents: 2000 });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe('Topped up $20 from your saved PayPal method. Balance $20.01.');
      expect(r.structuredContent).toMatchObject({
        status: 'COMPLETED',
        method: 'VAULT_MIT',
        amountCents: 2000,
        approveUrl: null,
        balanceMicros: ONE_CENT + TWENTY,
      });
      expect(await balanceOf(app.db.pool, b.id)).toBe(ONE_CENT + TWENTY);
      expect(await vaultTopups(b)).toEqual([
        expect.objectContaining({ status: 'COMPLETED', trigger: 'MCP', amount_cents: 2000 }),
      ]);
      // One vault create (no approval link), counted against the cap.
      expect(creates()).toHaveLength(1);
      expect((await getSettings(b)).body.remainingThisMonthCents).toBe(8_000);
    });

    it('an agent looping on top_up stops at the monthly cap, not at the 30/min rate limit', async () => {
      const b = await buyer({ vault: true, capCents: 10_000 });
      const client = await connect(b.key);
      const results: CallToolResult[] = [];
      for (let i = 0; i < 8; i++) results.push(await topUp(client, { amountCents: 2000 }));

      const done = results.filter((r) => !r.isError);
      const refused = results.filter((r) => r.isError);
      expect(done).toHaveLength(5);
      expect(refused).toHaveLength(3);
      for (const r of refused) {
        expect(textOf(r)).toBe(autoTopupCapReachedMessage({ monthlyCapCents: 10_000 }));
        expect(r.structuredContent).toMatchObject({ error: { code: 'AUTO_TOPUP_CAP_REACHED' } });
      }
      // Past the cap there is no PayPal call at all.
      expect(creates()).toHaveLength(5);
      expect(await balanceOf(app.db.pool, b.id)).toBe(5 * TWENTY);
      expect((await getSettings(b)).body).toMatchObject({
        usedThisMonthCents: 10_000,
        remainingThisMonthCents: 0,
      });
      // A smaller top-up that still fits under a raised cap goes through again.
      await putSettings(b, { ...ON, enabled: false, monthlyCapCents: 10_500 });
      const small = await topUp(client, { amountCents: 500 });
      expect(small.structuredContent).toMatchObject({ status: 'COMPLETED' });
    });

    it('a retried top_up (same idempotencyKey) charges once; the replay says so', async () => {
      const b = await buyer({ vault: true });
      const client = await connect(b.key);
      const key = randomUUID();
      const first = await topUp(client, { amountCents: 2000, idempotencyKey: key });
      const again = await topUp(client, { amountCents: 2000, idempotencyKey: key });
      expect(again.structuredContent).toMatchObject({
        topupId: (first.structuredContent as { topupId: string }).topupId,
        status: 'COMPLETED',
        replay: true,
      });
      expect(textOf(again)).toMatch(/already added from your saved PayPal method/);
      const other = await topUp(client, { amountCents: 5000, idempotencyKey: key });
      expect(other.structuredContent).toMatchObject({ error: { code: 'IDEMPOTENCY_MISMATCH' } });
      expect(creates()).toHaveLength(1);
      expect(await balanceOf(app.db.pool, b.id)).toBe(TWENTY);
    });

    it('race: 10 parallel top_up with one key → one top-up, one PayPal order', async () => {
      const b = await buyer({ vault: true });
      const deps = { db: app.db, pp, config: app.config };
      const key = randomUUID();
      const out = await Promise.all(
        Array.from({ length: 10 }, () =>
          agentTopUp(deps, {
            buyerId: b.id,
            apiKeyId: b.keyId,
            amountCents: 2000,
            idempotencyKey: key,
          }),
        ),
      );
      expect(new Set(out.map((o) => o.topupId)).size).toBe(1);
      expect(out.every((o) => o.status === 'COMPLETED')).toBe(true);
      expect(creates()).toHaveLength(1);
      expect(await vaultTopups(b)).toHaveLength(1);
      expect(await balanceOf(app.db.pool, b.id)).toBe(TWENTY);
    });

    it('race: 12 parallel top_up with distinct keys → never two in flight, exactly the cap charged', async () => {
      const b = await buyer({ vault: true, capCents: 10_000 });
      let inFlight = 0;
      let maxInFlight = 0;
      const counting: PayPalOrdersClient = Object.create(pp);
      counting.createTopupOrder = async (input) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        try {
          return await pp.createTopupOrder(input);
        } finally {
          inFlight--;
        }
      };
      const deps = { db: app.db, pp: counting, config: app.config };
      const out = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          agentTopUp(deps, {
            buyerId: b.id,
            apiKeyId: b.keyId,
            amountCents: 2000,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      const ok = out.filter((o) => o.status === 'fulfilled');
      const capped = out.filter(
        (o) =>
          o.status === 'rejected' &&
          o.reason instanceof ApiError &&
          o.reason.code === 'AUTO_TOPUP_CAP_REACHED',
      );
      expect(ok).toHaveLength(5);
      expect(capped).toHaveLength(7);
      expect(maxInFlight).toBe(1);
      expect(creates()).toHaveLength(5);
      expect(await balanceOf(app.db.pool, b.id)).toBe(5 * TWENTY);
    });

    it('race: MCP top_up and AUTO top-ups from short calls → one VAULT_MIT in flight; the cap counts both', async () => {
      // Cap $40: room for exactly two $20 vault top-ups, whoever triggers them.
      const b = await buyer({
        vault: true,
        enabled: true,
        capCents: 4_000,
        balanceMicros: ONE_CENT,
      });
      let inFlight = 0;
      let maxInFlight = 0;
      const counting: PayPalOrdersClient = Object.create(pp);
      counting.createTopupOrder = async (input) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        try {
          return await pp.createTopupOrder(input);
        } finally {
          inFlight--;
        }
      };
      setTopupPayPal(counting);
      const deps = { db: app.db, pp: counting, config: app.config };
      const [mcp, ...reads] = await Promise.all([
        agentTopUp(deps, {
          buyerId: b.id,
          apiKeyId: b.keyId,
          amountCents: 2000,
          idempotencyKey: randomUUID(),
        }).then(
          (r) => r.status,
          (e: unknown) => (e instanceof ApiError ? e.code : 'THREW'),
        ),
        ...Array.from({ length: 10 }, () => shortCall(b).then((r) => r.status)),
      ]);
      expect(maxInFlight).toBe(1);
      expect(['COMPLETED', 'AUTO_TOPUP_CAP_REACHED']).toContain(mcp);
      for (const s of reads) expect([200, 402]).toContain(s);
      const rows = await vaultTopups(b);
      const charged = rows.filter((r) => r.status === 'COMPLETED');
      expect(charged.reduce((s, r) => s + r.amount_cents, 0)).toBeLessThanOrEqual(4_000);
      expect(rows.some((r) => r.status === 'CREATED')).toBe(false);
      if (mcp === 'COMPLETED') expect(rows.map((r) => r.trigger)).toContain('MCP');
    });

    it('POST /v1/topups with a saved method → 200 COMPLETED (contract), then 422 at the cap', async () => {
      const b = await buyer({ vault: true, capCents: 2_000 });
      const post1 = await fetch(`${base}/v1/topups`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${b.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCents: 2000 }),
      });
      expect(post1.status).toBe(200);
      const body = await post1.json();
      topupResponse.strict().parse(body); // the openapi.yaml contract (SP-023)
      expect(body).toMatchObject({
        status: 'COMPLETED',
        method: 'VAULT_MIT',
        balanceMicros: TWENTY,
      });

      const post2 = await fetch(`${base}/v1/topups`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${b.key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ amountCents: 2000 }),
      });
      expect(post2.status).toBe(422);
      expect((await post2.json()).error).toMatchObject({
        code: 'AUTO_TOPUP_CAP_REACHED',
        message: autoTopupCapReachedMessage({ monthlyCapCents: 2_000 }),
      });
      expect(creates()).toHaveLength(1);
    });

    it('no saved method → top_up still returns the approval link (SP-022b)', async () => {
      const b = await buyer();
      const client = await connect(b.key);
      const r = await topUp(client, { amountCents: 2000 });
      expect(r.structuredContent).toMatchObject({
        status: 'AWAITING_APPROVAL',
        method: 'PAYPAL_WALLET',
      });
      expect((r.structuredContent as { approveUrl: string }).approveUrl).toMatch(/checkoutnow/);
    });

    it('a declined vault charge from top_up → tool error with the W15 copy, auto top-up off', async () => {
      const b = await buyer({ vault: true, enabled: true });
      const declining: PayPalOrdersClient = Object.create(pp);
      declining.createTopupOrder = (input) =>
        pp.createTopupOrder({ ...input, mockResponse: 'INSTRUMENT_DECLINED' });
      setTopupPayPal(declining);
      const client = await connect(b.key);
      const r = await topUp(client, { amountCents: 2000 });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe(autoTopupDeclinedMessage({ method: 'CARD' }));
      expect(r.structuredContent).toMatchObject({ error: { code: 'TOPUP_FAILED' } });
      expect((await getSettings(b)).body).toMatchObject({ enabled: false });
      expect((await getSettings(b)).body.declinedAt).toEqual(expect.any(String));
      expect(await balanceOf(app.db.pool, b.id)).toBe(0);
    });

    // ------------------------------------------------------------------------------------------
    // demo:decline → W11 declined banner

    it('demo:decline then a short call → 402, auto top-up off, W11 shows the declined banner; re-enabling clears it', async () => {
      const b = await buyer({ vault: true, enabled: true, balanceMicros: ONE_CENT });
      const armed = await demoDecline(app.db.pool, { buyerEmail: b.email });
      expect(armed).toMatchObject({ buyerId: b.id, armed: true, autoTopupReady: true });

      const res = await shortCall(b);
      expect(res.status).toBe(402);
      expect((await res.json()).error).toMatchObject({
        code: 'TOPUP_FAILED',
        message: autoTopupDeclinedMessage({ method: 'CARD' }),
      });
      // The mock header went with the vault create; the flag is spent.
      const [create] = creates();
      expect(create?.mockResponse).toMatch(/INSTRUMENT_DECLINED/);
      const [flag] = await q<{ next: boolean }>(
        `SELECT mock_decline_next AS next FROM buyers WHERE id = $1`,
        [b.id],
      );
      expect(flag!.next).toBe(false);
      expect(await vaultTopups(b)).toEqual([
        expect.objectContaining({ status: 'FAILED', trigger: 'AUTO' }),
      ]);

      const banner = (await getSettings(b)).body;
      expect(banner).toMatchObject({ enabled: false, savedMethod: { kind: 'CARD' } });
      expect(banner.declinedAt).toEqual(expect.any(String));

      // The buyer turns it back on: banner gone, and the next short call tops up normally.
      const back = await putSettings(b, ON);
      expect(back.body).toMatchObject({ enabled: true, declinedAt: null });
      const ok = await shortCall(b);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('spigot-auto-topup')).toBe('2000');
    });

    it('demo:decline only for a foreground buyer that exists; --clear disarms', async () => {
      await expect(demoDecline(app.db.pool, { buyerEmail: 'nobody@example.com' })).rejects.toThrow(
        /run seed:demo first/,
      );
      const b = await buyer();
      expect(await demoDecline(app.db.pool, { buyerEmail: b.email })).toMatchObject({
        armed: true,
        autoTopupReady: false,
      });
      expect(await demoDecline(app.db.pool, { buyerEmail: b.email, clear: true })).toMatchObject({
        armed: false,
      });
      const [flag] = await q<{ next: boolean }>(
        `SELECT mock_decline_next AS next FROM buyers WHERE id = $1`,
        [b.id],
      );
      expect(flag!.next).toBe(false);
    });

    it('the flag is not spent by an MCP vault top-up (AUTO only)', async () => {
      const b = await buyer({ vault: true, enabled: true });
      await demoDecline(app.db.pool, { buyerEmail: b.email });
      const client = await connect(b.key);
      const r = await topUp(client, { amountCents: 2000 });
      expect(r.structuredContent).toMatchObject({ status: 'COMPLETED' });
      const [flag] = await q<{ next: boolean }>(
        `SELECT mock_decline_next AS next FROM buyers WHERE id = $1`,
        [b.id],
      );
      expect(flag!.next).toBe(true);
    });
  },
);
