import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import { FakePayPalExtras } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import { setPayoutDeps } from '../payouts/deps.js';
import { pollRecentBatches } from '../payouts/poll.js';
import { cases } from '../security/tenancy/payouts.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-021 payout routes against Postgres, PayPal on FakePayPal (swapped in with `setPayoutDeps`):
 * `GET /api/publishers/me/payouts`, the demo-only run-now, `POST /admin/payouts/run` and
 * `POST /admin/payouts/:batchId/reconcile`. Runs `security/tenancy/payouts.cases.ts`.
 */

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const ADMIN = 'ops@spigot.test';

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)('SP-021 payout routes (Postgres)', { timeout: 60_000 }, () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPalExtras;
  let adminCookie: string;
  let buyerCookie: string;
  const pubs: Record<'demo' | 'a' | 'b', { id: string; cookie: string; email: string }> =
    {} as never;

  beforeAll(async () => {
    db = await createTestDatabase();
    const config = loadConfig({
      ...REQUIRED_ENV,
      DATABASE_URL: db.url,
      PAYPAL_MODE: 'stub',
      ADMIN_EMAILS: ADMIN,
    });
    app = await buildServer(config);
    await app.ready();
    fake = new FakePayPalExtras();
    setPayoutDeps({ pool: app.db.pool, pp: moneyOut(fake.transport(), undefined) });

    adminCookie = (await signup('/api/auth/signup', ADMIN)).cookie;
    buyerCookie = (await signup('/api/buyer/signup', `b-${randomUUID()}@example.com`)).cookie;
    for (const k of ['demo', 'a', 'b'] as const) {
      const email = `${k}-${randomUUID()}@example.com`;
      const s = await signup('/api/auth/signup', email, `${k}-payee-${randomUUID()}@payee.example`);
      const [row] = await q<{ id: string }>(`SELECT id FROM publishers WHERE email = $1`, [email]);
      pubs[k] = { id: row!.id, cookie: s.cookie, email };
    }
    await q(`UPDATE publishers SET is_demo = true WHERE id = $1`, [pubs.demo.id]);
  });
  afterAll(async () => {
    setPayoutDeps(undefined);
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => app.rateLimiter.reset());

  const agent = () => request(app.server);
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await app.db.pool.query(sql, params)).rows as T[];

  async function signup(path: string, email: string, payoutEmail = 'pay@example.com') {
    const body =
      path === '/api/auth/signup'
        ? { name: 'Pub', email, password: 'correct horse', payoutEmail }
        : { name: 'Buyer', email, password: 'battery staple' };
    const res = await agent().post(path).set('Origin', ORIGIN).send(body);
    expect(res.status).toBe(201);
    return { cookie: cookiesOf(res) };
  }

  const call = (method: 'GET' | 'POST', url: string, cookie: string, body?: object) => {
    const req = method === 'GET' ? agent().get(url) : agent().post(url).set('Origin', ORIGIN);
    const withCookie = req.set('Cookie', cookie);
    return body ? withCookie.send(body) : withCookie;
  };

  async function charge(publisherId: string, priceMicros: number): Promise<void> {
    const client = await app.db.pool.connect();
    try {
      await client.query('BEGIN');
      const platform = await platformAccounts(client);
      const [b] = (await client.query(`INSERT INTO buyers (name) VALUES ('B') RETURNING id`)).rows;
      const buyer = await getOrCreateAccount(client, 'BUYER_BALANCE', b.id);
      const publisher = await getOrCreateAccount(client, 'PUBLISHER_PAYABLE', publisherId);
      await post(client, {
        kind: 'TOPUP',
        idempotencyKey: `topup:${randomUUID()}`,
        entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, priceMicros),
      });
      await post(client, {
        kind: 'CHARGE',
        idempotencyKey: `charge:${randomUUID()}`,
        entries: chargeEntries(
          { buyer, publisher, platformRevenue: platform.platformRevenue },
          priceMicros,
          2000,
        ),
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  it('covers every payout route with a tenancy case', () => {
    const urls = cases.map((c) => `${c.method} ${c.url}`).sort();
    expect(urls).toEqual(
      [
        'GET /api/publishers/me/payouts',
        'POST /api/publishers/me/payouts/run',
        'POST /admin/payouts/run',
        'POST /admin/payouts/:batchId/reconcile',
      ].sort(),
    );
  });

  it('run-now: non-demo publisher → 403 and nothing built; buyer / no session → 401', async () => {
    await charge(pubs.a.id, 5_000_000);
    const res = await call('POST', '/api/publishers/me/payouts/run', pubs.a.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await q(`SELECT 1 FROM payout_batches`)).toHaveLength(0);
    expect((await call('POST', '/api/publishers/me/payouts/run', buyerCookie)).status).toBe(401);
    expect((await call('POST', '/api/publishers/me/payouts/run', '')).status).toBe(401);
  });

  it('run-now (demo publisher): $1 demo threshold, reply lists only the caller’s item; GET is tenant-scoped', async () => {
    await charge(pubs.demo.id, 3_000_000); // $2.40 payable: under $10, over the $1 demo threshold
    await charge(pubs.b.id, 2_000_000); // $1.60
    // pubs.a has $4.00 from the previous test.
    const res = await call('POST', '/api/publishers/me/payouts/run', pubs.demo.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ demoControl: true, outcome: 'PENDING' });
    expect(res.body.items).toEqual([
      expect.objectContaining({ publisherId: pubs.demo.id, netCents: 240 }),
    ]);
    const batchId = res.body.batchId as string;
    expect((await q(`SELECT 1 FROM payout_items WHERE batch_id = $1`, [batchId])).length).toBe(3);

    // B's view of the shared batch: B's item only, never A's or demo's amounts / emails.
    const view = await call('GET', '/api/publishers/me/payouts', pubs.b.cookie);
    expect(view.status).toBe(200);
    expect(view.body.isDemo).toBe(false);
    expect(view.body.batches).toHaveLength(1);
    const [batch] = view.body.batches;
    expect(batch).toMatchObject({ id: batchId, status: 'PENDING', trigger: 'MANUAL_DEMO' });
    expect(batch.paypalBatchId).toBeTruthy();
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({ status: 'PENDING', netCents: 160 });
    expect(JSON.stringify(view.body)).not.toContain('demo-payee');
    expect(JSON.stringify(view.body)).not.toContain('a-payee');
    expect(view.body.next).toMatchObject({
      payableCents: 0,
      thresholdCents: 1000,
      inFlightCents: 160,
      eligible: false,
    });
    expect(view.body.next.nextPayoutDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A smuggled publisherId is ignored.
    const smuggled = await call(
      'GET',
      `/api/publishers/me/payouts?publisherId=${pubs.a.id}`,
      pubs.b.cookie,
    );
    expect(smuggled.body.batches[0].items[0].netCents).toBe(160);

    // Poll to SUCCESS: the pill data flips and fee_cents shows.
    for (let i = 0; i < 3; i++)
      await pollRecentBatches({ pool: app.db.pool, pp: moneyOut(fake.transport(), undefined) });
    const after = await call('GET', '/api/publishers/me/payouts', pubs.demo.cookie);
    expect(after.body.isDemo).toBe(true);
    expect(after.body.batches[0]).toMatchObject({ status: 'SUCCESS' });
    expect(after.body.batches[0].items[0]).toMatchObject({ status: 'SUCCESS', feeCents: 25 });
    expect(after.body.batches[0].items[0].paypalItemId).toBeTruthy();
    expect(after.body.next.inFlightCents).toBe(0);
    expect((await ledgerCheck(app.db.pool)).mismatches).toEqual([]);

    // Second immediate run: nothing to pay.
    const again = await call('POST', '/api/publishers/me/payouts/run', pubs.demo.cookie);
    expect(again.body.outcome).toBe('NO_ITEMS');
  });

  it('GET without a session → 401', async () => {
    expect((await call('GET', '/api/publishers/me/payouts', '')).status).toBe(401);
    expect((await call('GET', '/api/publishers/me/payouts', buyerCookie)).status).toBe(401);
  });

  it('admin routes: non-admin publisher 403, buyer / none 401, admin runs', async () => {
    for (const url of ['/admin/payouts/run', `/admin/payouts/${randomUUID()}/reconcile`]) {
      expect((await call('POST', url, pubs.demo.cookie, {})).status).toBe(403);
      expect((await call('POST', url, buyerCookie, {})).status).toBe(401);
      expect((await call('POST', url, '', {})).status).toBe(401);
    }
    const bad = await call('POST', '/admin/payouts/run', adminCookie, {
      thresholdCentsOverride: 50,
    });
    expect(bad.status).toBe(400);
    await charge(pubs.b.id, 2_000_000);
    const ok = await call('POST', '/admin/payouts/run', adminCookie, {
      trigger: 'MANUAL_DEMO',
      thresholdCentsOverride: 100,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ demoControl: true, outcome: 'PENDING' });
    expect(ok.body.items.map((i: { publisherId: string }) => i.publisherId)).toContain(pubs.b.id);
  });

  it('admin reconcile: unknown batch 404, a batch not waiting for reconcile 409', async () => {
    const missing = await call('POST', `/admin/payouts/${randomUUID()}/reconcile`, adminCookie, {
      paypalBatchId: 'X1',
    });
    expect(missing.status).toBe(404);
    const [b] = await q<{ id: string }>(`SELECT id FROM payout_batches LIMIT 1`);
    const conflict = await call('POST', `/admin/payouts/${b!.id}/reconcile`, adminCookie, {
      paypalBatchId: 'X1',
    });
    expect(conflict.status).toBe(409);
    const invalid = await call('POST', `/admin/payouts/${b!.id}/reconcile`, adminCookie, {});
    expect(invalid.status).toBe(400);
  });
});
