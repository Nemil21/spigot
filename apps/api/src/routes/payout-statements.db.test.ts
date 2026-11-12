import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import { FakePayPalExtras } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import { setPayoutDeps } from '../payouts/deps.js';
import { pollRecentBatches } from '../payouts/poll.js';
import { cases } from '../security/tenancy/payout-statements.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-031 `GET /api/publishers/me/payouts/statements` against Postgres, PayPal on FakePayPal:
 * records sold, SIM share, rounding carried forward, the next-payout preview, tenancy, and two
 * concurrent "Run payout now" clicks building one item.
 */

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)(
  'SP-031 payout statements (Postgres)',
  { timeout: 60_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;
    let fake: FakePayPalExtras;
    let buyerCookie: string;
    const pubs: Record<'demo' | 'b', { id: string; cookie: string }> = {} as never;

    beforeAll(async () => {
      db = await createTestDatabase();
      const config = loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' });
      app = await buildServer(config);
      await app.ready();
      fake = new FakePayPalExtras();
      setPayoutDeps({ pool: app.db.pool, pp: moneyOut(fake.transport(), undefined) });

      buyerCookie = (await signup('/api/buyer/signup', `b-${randomUUID()}@example.com`)).cookie;
      for (const k of ['demo', 'b'] as const) {
        const email = `${k}-${randomUUID()}@example.com`;
        const s = await signup('/api/auth/signup', email);
        const [row] = await q<{ id: string }>(`SELECT id FROM publishers WHERE email = $1`, [
          email,
        ]);
        pubs[k] = { id: row!.id, cookie: s.cookie };
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

    async function signup(path: string, email: string) {
      const body =
        path === '/api/auth/signup'
          ? {
              name: 'Pub',
              email,
              password: 'correct horse',
              payoutEmail: `payee-${randomUUID()}@payee.example`,
            }
          : { name: 'Buyer', email, password: 'battery staple' };
      const res = await agent().post(path).set('Origin', ORIGIN).send(body);
      expect(res.status).toBe(201);
      return { cookie: cookiesOf(res) };
    }

    const get = (url: string, cookie: string) => agent().get(url).set('Cookie', cookie);
    const run = (cookie: string) =>
      agent().post('/api/publishers/me/payouts/run').set('Origin', ORIGIN).set('Cookie', cookie);

    /** A charged call: ledger CHARGE (20% commission) plus its `api_calls` row with `records`. */
    async function charge(publisherId: string, priceMicros: number, records: number, sim = false) {
      const client = await app.db.pool.connect();
      try {
        await client.query('BEGIN');
        const platform = await platformAccounts(client);
        const [b] = (
          await client.query(
            `INSERT INTO buyers (name, is_simulated) VALUES ('B', $1) RETURNING id`,
            [sim],
          )
        ).rows;
        const [k] = (
          await client.query(
            `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'abcd1234', $2) RETURNING id`,
            [b.id, randomUUID()],
          )
        ).rows;
        const buyer = await getOrCreateAccount(client, 'BUYER_BALANCE', b.id);
        const publisher = await getOrCreateAccount(client, 'PUBLISHER_PAYABLE', publisherId);
        await post(client, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          isSimulated: sim,
          entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, priceMicros),
        });
        const charged = await post(client, {
          kind: 'CHARGE',
          idempotencyKey: `charge:${randomUUID()}`,
          isSimulated: sim,
          entries: chargeEntries(
            { buyer, publisher, platformRevenue: platform.platformRevenue },
            priceMicros,
            2000,
          ),
        });
        await client.query(
          `INSERT INTO api_calls (buyer_id, api_key_id, channel, idempotency_key, status,
                                records_returned, price_micros, charge_txn_id, is_simulated)
         VALUES ($1, $2, 'REST', $3, 'CHARGED', $4, $5, $6, $7)`,
          [b.id, k.id, randomUUID(), records, priceMicros, charged.txn.id, sim],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }

    it('covers the route with a tenancy case', () => {
      expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET /api/publishers/me/payouts/statements',
      ]);
    });

    it('buyer or no session → 401', async () => {
      expect((await get('/api/publishers/me/payouts/statements', buyerCookie)).status).toBe(401);
      expect((await get('/api/publishers/me/payouts/statements', '')).status).toBe(401);
    });

    it('no payouts yet: an empty preview and no items', async () => {
      const res = await get('/api/publishers/me/payouts/statements', pubs.b.cookie);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual({});
      expect(res.body.next).toMatchObject({
        periodStart: null,
        recordsSold: 0,
        grossMicros: 0,
        commissionMicros: 0,
        simGrossMicros: 0,
        simRecords: 0,
        roundingCarriedMicros: null,
      });
    });

    it('SIM share, records and rounding carried forward; tenant-scoped; two run clicks → one item', async () => {
      // Real: $3.00005 → commission 600,010, payable 2,400,040. SIM: $1 → payable 800,000.
      await charge(pubs.demo.id, 3_000_050, 30);
      await charge(pubs.demo.id, 1_000_000, 10, true);
      await charge(pubs.b.id, 2_000_000, 7);

      const preview = await get('/api/publishers/me/payouts/statements', pubs.demo.cookie);
      expect(preview.body.next).toMatchObject({
        recordsSold: 40,
        grossMicros: 4_000_050,
        commissionMicros: 800_010,
        simGrossMicros: 1_000_000,
        simRecords: 10,
        roundingCarriedMicros: null,
      });
      expect(preview.body.next.periodStart).toBeTruthy();

      // Two "Run payout now" clicks at once: the advisory lock + in-flight rule build one item.
      const [r1, r2] = await Promise.all([run(pubs.demo.cookie), run(pubs.demo.cookie)]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      const items = await q<{ id: string; netCents: number }>(
        `SELECT id, net_cents AS "netCents" FROM payout_items WHERE publisher_id = $1`,
        [pubs.demo.id],
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.netCents).toBe(320); // floor(3,200,040 / 10,000)

      const after = await get('/api/publishers/me/payouts/statements', pubs.demo.cookie);
      expect(after.body.items[items[0]!.id]).toMatchObject({
        recordsSold: 40,
        grossMicros: 4_000_050,
        commissionMicros: 800_010,
        simGrossMicros: 1_000_000,
        simRecords: 10,
        roundingCarriedMicros: 40,
      });
      // The next statement starts after this batch: nothing sold since.
      expect(after.body.next).toMatchObject({ recordsSold: 0, grossMicros: 0 });

      // Still the same figures once PayPal says SUCCESS.
      for (let i = 0; i < 3; i++)
        await pollRecentBatches({ pool: app.db.pool, pp: moneyOut(fake.transport(), undefined) });
      const settled = await get('/api/publishers/me/payouts/statements', pubs.demo.cookie);
      expect(settled.body.items[items[0]!.id]).toMatchObject({ grossMicros: 4_000_050 });

      // B (in the same batch) sees only B's own item and figures, even with a smuggled id.
      const b = await get(
        `/api/publishers/me/payouts/statements?publisherId=${pubs.demo.id}`,
        pubs.b.cookie,
      );
      expect(Object.keys(b.body.items)).not.toContain(items[0]!.id);
      const bItems = Object.values(b.body.items) as { grossMicros: number; simRecords: number }[];
      expect(bItems).toHaveLength(1);
      expect(bItems[0]).toMatchObject({ grossMicros: 2_000_000, simRecords: 0 });
    });
  },
);
