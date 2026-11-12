import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { audit } from '../audit/audit.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { chargeAndRecord, type ChargeInput } from '../meter/charge.js';
import { adminHealth } from '../ops/health.js';
import { payoutRun } from '../payouts/payoutRun.js';
import { createPayPalClient, PayPalAuthError, type PayPalRestClient } from '../paypal/index.js';
import { cases } from '../security/tenancy/admin.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-043 admin ops endpoints against Postgres, with PayPal on the FakePayPal stub
 * (`PAYPAL_MODE=stub`). The money flow below is the demo's shape (SP-035 seed + SP-038 demo
 * script are not merged yet): a card top-up captured by PayPal, metered charges, a payout run.
 */

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const ADMIN = 'ops@spigot.test';

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)(
  'SP-043 admin ops endpoints (Postgres)',
  { timeout: 60_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let pp: PayPalRestClient;
    let adminCookie: string;
    let publisherCookie: string;
    let buyerCookie: string;

    beforeAll(async () => {
      db = await createTestDatabase();
      const config = loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: db.url,
        PAYPAL_MODE: 'stub',
        ADMIN_EMAILS: `someone@else.io, ${ADMIN.toUpperCase()}`,
      });
      app = await buildServer(config);
      await app.ready();
      pp = createPayPalClient(config);

      adminCookie = await signup('/api/auth/signup', ADMIN);
      publisherCookie = await signup('/api/auth/signup', `p-${randomUUID()}@example.com`);
      buyerCookie = await signup('/api/buyer/signup', `b-${randomUUID()}@example.com`);
    });
    afterAll(async () => {
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => app.rateLimiter.reset());

    const agent = () => request(app.server);
    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    async function signup(path: string, email: string): Promise<string> {
      const body =
        path === '/api/auth/signup'
          ? { name: 'Pub', email, password: 'correct horse', payoutEmail: 'pay@example.com' }
          : { name: 'Buyer', email, password: 'battery staple' };
      const res = await agent().post(path).set('Origin', ORIGIN).send(body);
      expect(res.status).toBe(201);
      return cookiesOf(res);
    }

    const call = (method: 'GET' | 'POST', url: string, cookie: string) => {
      const req = method === 'GET' ? agent().get(url) : agent().post(url).set('Origin', ORIGIN);
      return req.set('Cookie', cookie);
    };

    /** Publisher + site + dataset + buyer + API key, as the seed creates them. */
    async function world() {
      const tag = randomUUID().slice(0, 8);
      const [pub] = await q<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email, commission_bps)
       VALUES ($1, $2, $3, 2000) RETURNING id`,
        [`Pub ${tag}`, `pub-${tag}@example.com`, `payee-${tag}@publisher.example`],
      );
      const [site] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
       VALUES ($1, $2, 'v', 'c', 'g') RETURNING id`,
        [pub!.id, `https://${tag}.example.com`],
      );
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'listings', 'Listing') RETURNING id`,
        [site!.id],
      );
      const [buyer] = await q<{ id: string }>(
        `INSERT INTO buyers (name) VALUES ($1) RETURNING id`,
        [`Buyer ${tag}`],
      );
      const [key] = await q<{ id: string }>(
        `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, $2, $3) RETURNING id`,
        [buyer!.id, tag, `hash-${randomUUID()}`],
      );
      return {
        publisherId: pub!.id,
        siteId: site!.id,
        datasetId: ds!.id,
        buyerId: buyer!.id,
        apiKeyId: key!.id,
      };
    }
    type World = Awaited<ReturnType<typeof world>>;

    /**
     * A card top-up captured on FakePayPal, credited and audited in one transaction (the shape of
     * SP-018b's SIM top-up: deterministic id inserted before the PayPal call).
     */
    async function cardTopup(w: World, amountCents: number) {
      const topupId = randomUUID();
      await q(
        `INSERT INTO topups (id, buyer_id, amount_cents, method, trigger) VALUES ($1, $2, $3, 'CARD', 'SIM')`,
        [topupId, w.buyerId, amountCents],
      );
      const r = await pp.createTopupOrder({
        topupId,
        amountCents,
        source: {
          kind: 'card',
          vault: false,
          card: {
            number: '4111111111111111',
            expiry: '2030-12',
            security_code: '123',
            name: 'Visa',
          },
        },
      });
      if (r.status !== 'COMPLETED') throw new Error(`top-up did not complete: ${r.status}`);
      await app.db.tx(async (tx) => {
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', w.buyerId);
        const { paypalCash } = await platformAccounts(tx);
        const posted = await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${topupId}`,
          refType: 'topup',
          refId: topupId,
          entries: topupEntries({ buyer, paypalCash }, amountCents * 10_000),
        });
        await tx.query(
          `UPDATE topups SET status = 'COMPLETED', paypal_order_id = $2, paypal_capture_id = $3,
                           ledger_txn_id = $4, updated_at = now()
         WHERE id = $1`,
          [topupId, r.orderId, r.captureId, posted.txn.id],
        );
        await audit(tx, {
          actorType: 'SIM',
          actorId: w.buyerId,
          entity: 'topups',
          entityId: topupId,
          action: 'TOPUP_COMPLETED',
          paypalId: r.captureId,
          data: { amountCents, orderId: r.orderId },
        });
      });
      return { topupId, captureId: r.captureId, orderId: r.orderId };
    }

    /** One metered `records.search` call of `count` records at 1,500 micros each. */
    function charge(w: World, count: number) {
      const records = Array.from({ length: count }, (_, i) => ({
        key: `listings/${i}`,
        data: { i },
      }));
      const input: ChargeInput = {
        dataset: { id: w.datasetId },
        endpoint: 'records.search',
        idempotencyKey: randomUUID(),
        request: { limit: count },
        body: { records },
        servedKeys: records.map((r) => ({ key: r.key, hash: `h${r.key}` })),
        unitPriceMicros: 1500,
        count,
        isSimulated: false,
      };
      return chargeAndRecord(
        { db: app.db, buyerId: w.buyerId, apiKeyId: w.apiKeyId, channel: 'REST' },
        input,
      );
    }

    describe('requireAdmin', () => {
      it.each(cases)('$method $url: non-admin → 403, buyer / none → 401', async (c) => {
        const asPublisher = await call(c.method as 'GET' | 'POST', c.url, publisherCookie);
        expect(asPublisher.status).toBe(403);
        expect(asPublisher.body.error.code).toBe('FORBIDDEN');
        expect((await call(c.method as 'GET' | 'POST', c.url, buyerCookie)).status).toBe(401);
        expect((await call(c.method as 'GET' | 'POST', c.url, '')).status).toBe(401);
        expect((await call(c.method as 'GET' | 'POST', c.url, adminCookie)).status).toBe(200);
      });
    });

    describe('demo money flow', () => {
      let w: World;
      let captureId: string;

      beforeAll(async () => {
        w = await world();
        ({ captureId } = await cardTopup(w, 2000));
        await cardTopup(w, 1000);
        for (const count of [400, 400, 400]) {
          const res = await charge(w, count);
          expect(res.status).toBe(200);
        }
        const run = await payoutRun(
          { trigger: 'MANUAL_DEMO', thresholdCentsOverride: 100 },
          { pool: app.db.pool, pp, retryDelayMs: 0 },
        );
        expect(run.outcome).toBe('PENDING');
      });

      it('ledger check returns sumMicros: 0 and no mismatches after top-ups, charges and a payout', async () => {
        const res = await call('POST', '/admin/ledger/check', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          sumMicros: 0,
          accountsChecked: expect.any(Number),
          mismatches: [],
        });
        // buyer, publisher payable, PAYPAL_CASH, PLATFORM_REVENUE, PAYOUTS_IN_FLIGHT at least.
        expect(res.body.accountsChecked).toBeGreaterThanOrEqual(5);
      });

      it('audit search by a capture id returns the TOPUP_COMPLETED row', async () => {
        const res = await call(
          'GET',
          `/admin/audit?paypalId=${encodeURIComponent(captureId)}`,
          adminCookie,
        );
        expect(res.status).toBe(200);
        expect(res.body.next).toBeNull();
        expect(res.body.events).toHaveLength(1);
        expect(res.body.events[0]).toMatchObject({
          action: 'TOPUP_COMPLETED',
          paypalId: captureId,
          entity: 'topups',
          actorType: 'SIM',
          actorId: w.buyerId,
          data: { amountCents: 2000 },
        });
        const [topup] = await q<{ paypal_capture_id: string }>(
          `SELECT paypal_capture_id FROM topups WHERE id = $1`,
          [res.body.events[0].entityId],
        );
        expect(topup!.paypal_capture_id).toBe(captureId);
      });

      it('filters by publisher, actor, action and time; the payout row carries its batch id', async () => {
        const sent = await call(
          'GET',
          `/admin/audit?publisherId=${w.publisherId}&action=PAYOUT_SENT`,
          adminCookie,
        );
        expect(sent.status).toBe(200);
        for (const e of sent.body.events) expect(e.publisherId).toBe(w.publisherId);

        const byBuyer = await call(
          'GET',
          `/admin/audit?actorId=${w.buyerId}&action=TOPUP_COMPLETED`,
          adminCookie,
        );
        expect(byBuyer.body.events).toHaveLength(2);

        const future = new Date(Date.now() + 60_000).toISOString();
        const none = await call(
          'GET',
          `/admin/audit?actorId=${w.buyerId}&from=${encodeURIComponent(future)}`,
          adminCookie,
        );
        expect(none.body.events).toEqual([]);
        const before = await call(
          'GET',
          `/admin/audit?actorId=${w.buyerId}&action=TOPUP_COMPLETED&to=${encodeURIComponent(future)}`,
          adminCookie,
        );
        expect(before.body.events).toHaveLength(2);
        const past = new Date(Date.now() - 3_600_000).toISOString();
        const tooEarly = await call(
          'GET',
          `/admin/audit?actorId=${w.buyerId}&to=${encodeURIComponent(past)}`,
          adminCookie,
        );
        expect(tooEarly.body.events).toEqual([]);
      });

      it('health: dependency checks ok, open top-ups and pending payout items counted', async () => {
        await q(`UPDATE sites SET last_gate_seen_at = now() WHERE id = $1`, [w.siteId]);
        await q(
          `INSERT INTO bot_hits (site_id, bucket, category, bot_name, decision, hits)
         VALUES ($1, date_trunc('minute', now()), 'AI_TRAINING', 'GPTBot', 'QUOTE_402', 3)`,
          [w.siteId],
        );
        await q(
          `INSERT INTO topups (buyer_id, amount_cents, status) VALUES ($1, 1500, 'AWAITING_APPROVAL')`,
          [w.buyerId],
        );

        const res = await call('GET', '/admin/health', adminCookie);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          status: 'ok',
          checks: {
            paypal: { ok: true },
            db: { ok: true },
            workflows: { ok: true, mode: 'inproc' },
          },
          openTopups: { count: 1, needsReconcile: 0 },
          pendingPayouts: { pendingItems: 1, unclaimedItems: 0, batchesNeedingReconcile: 0 },
        });
        const site = res.body.gate.find((g: { siteId: string }) => g.siteId === w.siteId);
        expect(site).toMatchObject({ publisherId: w.publisherId, status: 'PENDING_VERIFY' });
        expect(Date.parse(site.lastGateSeenAt)).toBeGreaterThan(Date.now() - 60_000);
        expect(Date.parse(site.lastHitAt)).toBeGreaterThan(Date.now() - 120_000);
      });
    });

    describe('audit search paging and validation', () => {
      it('pages newest first with a keyset cursor, no gaps or repeats', async () => {
        const publisherId = (await world()).publisherId;
        for (let i = 0; i < 5; i++) {
          await audit(app.db.pool, {
            actorType: 'SYSTEM',
            publisherId,
            action: 'ALERT',
            data: { i },
          });
        }
        const seen: number[] = [];
        let cursor: string | null = null;
        do {
          const url: string = `/admin/audit?publisherId=${publisherId}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
          const res = await call('GET', url, adminCookie);
          expect(res.status).toBe(200);
          expect(res.body.events.length).toBeLessThanOrEqual(2);
          seen.push(...res.body.events.map((e: { data: { i: number } }) => e.data.i));
          cursor = res.body.next;
        } while (cursor);
        expect(seen).toEqual([4, 3, 2, 1, 0]);
      });

      it.each([
        'publisherId=not-a-uuid',
        'limit=0',
        'limit=201',
        'cursor=abc',
        'from=yesterday',
        'action=NOT_AN_ACTION',
        'unknown=1',
      ])('bad query %s → 400 VALIDATION_ERROR', async (qs) => {
        const res = await call('GET', `/admin/audit?${qs}`, adminCookie);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('ledger check under load', () => {
      it('runs alongside concurrent charges and top-ups without a false mismatch', async () => {
        const w = await world();
        await cardTopup(w, 5000);
        const work = [
          ...Array.from({ length: 20 }, () => charge(w, 10)),
          cardTopup(w, 500),
          cardTopup(w, 700),
        ];
        const checks = Array.from({ length: 6 }, () =>
          call('POST', '/admin/ledger/check', adminCookie),
        );
        const [results] = await Promise.all([Promise.all(checks), Promise.all(work)]);
        for (const r of results) {
          expect(r.status).toBe(200);
          expect(r.body).toMatchObject({ sumMicros: 0, mismatches: [] });
        }
        const after = await call('POST', '/admin/ledger/check', adminCookie);
        expect(after.body).toMatchObject({ sumMicros: 0, mismatches: [] });
      });
    });

    describe('adminHealth', () => {
      const base = () => ({
        pool: app.db.pool,
        config: { WORKFLOWS_MODE: 'inproc' as const },
        paypalToken: async () => 'token',
      });

      it('PayPal refuses the token → degraded with the PayPal error code, no message', async () => {
        const h = await adminHealth({
          ...base(),
          paypalToken: async () => {
            throw new PayPalAuthError(401, 'invalid_client');
          },
        });
        expect(h.status).toBe('degraded');
        expect(h.checks.paypal).toEqual({
          ok: false,
          ms: expect.any(Number),
          error: 'invalid_client',
        });
        expect(h.checks.db.ok).toBe(true);
      });

      it('a hung token call times out instead of hanging the endpoint', async () => {
        const h = await adminHealth({
          ...base(),
          timeoutMs: 50,
          paypalToken: () => new Promise<string>(() => {}),
        });
        expect(h.status).toBe('degraded');
        expect(h.checks.paypal.error).toBe('TIMEOUT');
      });

      it('workflows mode without the Render keys → degraded, keys named', async () => {
        const h = await adminHealth({
          ...base(),
          config: { WORKFLOWS_MODE: 'workflows', RENDER_API_KEY: 'x' },
        });
        expect(h.status).toBe('degraded');
        expect(h.checks.workflows).toMatchObject({
          ok: false,
          mode: 'workflows',
          missing: ['RENDER_WORKFLOWS_SERVICE_ID'],
        });
        const ok = await adminHealth({
          ...base(),
          config: {
            WORKFLOWS_MODE: 'workflows',
            RENDER_API_KEY: 'x',
            RENDER_WORKFLOWS_SERVICE_ID: 'wfl-1',
          },
        });
        expect(ok.status).toBe('ok');
      });

      it('DB down → degraded, tiles null, no throw', async () => {
        const h = await adminHealth({
          ...base(),
          pool: {
            query: () => Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
          } as never,
        });
        expect(h).toMatchObject({
          status: 'degraded',
          checks: {
            db: { ok: false, error: 'ECONNREFUSED' },
            facts: { ok: false, error: 'DB_UNAVAILABLE' },
          },
          gate: null,
          openTopups: null,
          pendingPayouts: null,
        });
      });

      /** `SELECT 1` answers; every later query gets `later()`. */
      const flakyPool = (later: () => Promise<never>) =>
        ({
          query: (sql: string) => (sql === 'SELECT 1' ? app.db.pool.query(sql) : later()),
        }) as never;

      it('DB drops after SELECT 1 (a tile query rejects) → degraded, tiles null, no throw', async () => {
        const h = await adminHealth({
          ...base(),
          pool: flakyPool(() => Promise.reject(Object.assign(new Error('x'), { code: '57P01' }))),
        });
        expect(h).toMatchObject({
          status: 'degraded',
          checks: { db: { ok: true }, facts: { ok: false, error: '57P01' } },
          gate: null,
          openTopups: null,
          pendingPayouts: null,
        });
      });

      it('saturated pool after SELECT 1 (a tile query hangs) → times out, tiles null', async () => {
        const h = await adminHealth({
          ...base(),
          timeoutMs: 50,
          pool: flakyPool(() => new Promise<never>(() => {})),
        });
        expect(h).toMatchObject({
          status: 'degraded',
          checks: { db: { ok: true }, facts: { ok: false, error: 'TIMEOUT' } },
          gate: null,
          openTopups: null,
          pendingPayouts: null,
        });
      });
    });
  },
);
