import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { authenticateKey } from '../auth/apiKeys.js';
import { verifyPassword } from '../auth/password.js';
import { loadConfig, type Config } from '../config.js';
import { createDb, createPool, type Db } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { ledgerCheck } from '../ledger/check.js';
import { FakePayPal, type PayPalOrdersClient } from '../paypal/index.js';
import { REQUIRED_ENV } from '../test/env.js';
import { balanceOf, topupById } from '../topups/index.js';
import {
  allFunded,
  DEMO_BUYER,
  DEMO_PUBLISHER,
  seedApiKey,
  seedDemo,
  seedPassword,
  seedTopupId,
  simBuyers,
  simulatedWeekStart,
  SIM_NO_PAYPAL_LABEL,
  type SeedDeps,
} from './seedDemo.js';

/** `pp` with `createTopupOrder` replaced (the client is a class instance: no spreading). */
function wrapCreate(
  pp: PayPalOrdersClient,
  create: PayPalOrdersClient['createTopupOrder'],
): PayPalOrdersClient {
  return new Proxy(pp, {
    get(target, prop, receiver) {
      if (prop === 'createTopupOrder') return create;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const never = <T>() => new Promise<T>(() => {});

// Each test migrates a fresh database and seeds 20 buyers.
describe.skipIf(!testDatabaseUrl)(
  'SP-035 seed:demo (Postgres + FakePayPal)',
  { timeout: 60_000 },
  () => {
    let tdb: TestDatabase;
    let pools: pg.Pool[];
    let config: Config;
    let fake: FakePayPal;

    beforeEach(async () => {
      tdb = await createTestDatabase();
      pools = [];
      config = loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: tdb.url,
        PAYPAL_MODE: 'stub',
        DEMO_PUBLISHER_PAYOUT_EMAIL: 'publisher-biz@example.com',
        SPIGOT_VERIFY_TOKEN: 'spigot-verify=preset-demo-token',
        DEMO_SITE_URL: 'http://localhost:4100',
      });
      fake = new FakePayPal({ latencyMs: 5, jitterMs: 10 });
    });
    afterEach(async () => {
      await Promise.all(pools.map((p) => p.end()));
      await tdb?.drop();
    });

    function newDb(): Db {
      const pool = createPool(tdb.url, { max: 8 });
      pools.push(pool);
      return createDb(pool);
    }
    const deps = (
      db: Db,
      pp: PayPalOrdersClient = fake.client({ timeoutMs: 1_000 }),
    ): SeedDeps => ({
      db,
      config,
      pp,
    });

    async function counts(db: Db) {
      const { rows } = await db.pool.query<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM publishers) AS publishers,
              (SELECT count(*)::int FROM sites) AS sites,
              (SELECT count(*)::int FROM buyers) AS buyers,
              (SELECT count(*)::int FROM api_keys) AS keys,
              (SELECT count(*)::int FROM topups) AS topups,
              (SELECT count(*)::int FROM ledger_txns) AS txns,
              (SELECT count(*)::int FROM crawl_runs) AS crawls`,
      );
      return rows[0]!;
    }
    async function topupTxns(db: Db) {
      const { rows } = await db.pool.query<{
        key: string;
        is_simulated: boolean;
        created_at: Date;
        memo: string | null;
      }>(
        `SELECT idempotency_key AS key, is_simulated, created_at, memo FROM ledger_txns
        WHERE kind = 'TOPUP' ORDER BY idempotency_key`,
      );
      return rows;
    }
    const creates = () => fake.calls.filter((c) => c.op === 'order_create');

    it('fresh DB → publisher, verified site, Acme, 20 funded SIM buyers; ledger check passes', async () => {
      const db = newDb();
      const now = new Date('2026-11-12T10:30:00Z');
      const bodies: Record<string, unknown>[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const base = fake.client({
        timeoutMs: 1_000,
        fetch: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (new URL(url).pathname === '/v2/checkout/orders' && typeof init?.body === 'string') {
            bodies.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return fake.fetch(input, init);
        },
      });
      const pp = wrapCreate(base, async (input) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        try {
          return await base.createTopupOrder(input);
        } finally {
          inFlight--;
        }
      });

      const r = await seedDemo(deps(db, pp), { now });

      // Publisher: is_demo, pays the separate sandbox business account; can log in.
      expect(r.publisher).toMatchObject({
        created: true,
        isDemo: true,
        payoutEmail: 'publisher-biz@example.com',
      });
      const { rows: pub } = await db.pool.query(
        `SELECT name, is_demo, password_hash FROM publishers WHERE email = $1`,
        [DEMO_PUBLISHER.email],
      );
      expect(pub[0]).toMatchObject({ name: 'Bluebonnet Rentals (demo)', is_demo: true });
      expect(await verifyPassword(pub[0].password_hash, r.publisher.password)).toBe(true);

      // Site: VERIFIED with the preset token, keys printed match the stored hashes, no crawl seeded.
      expect(r.site).toMatchObject({
        created: true,
        status: 'VERIFIED',
        origin: 'http://localhost:4100',
        verify: { content: 'spigot-verify=preset-demo-token' },
        gateKeyMatches: true,
      });
      expect(r.site.gateKey).toMatch(/^gk_/);
      expect(r.site.crawlKey).toMatch(/^ck_/);
      const { rows: audits } = await db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE entity = 'sites' ORDER BY id`,
      );
      expect(audits.map((a) => a.action)).toEqual(['SITE_CONNECTED', 'SITE_VERIFIED']);

      // Acme: real buyer, no balance, a working key with the topup scope.
      expect(r.acme).toMatchObject({ created: true, name: DEMO_BUYER.name });
      const acmeKey = await authenticateKey(db.pool, r.acme.apiKey);
      expect(acmeKey).toMatchObject({ buyerId: r.acme.id, scopes: ['read', 'topup'] });
      expect(await balanceOf(db.pool, r.acme.id)).toBe(0);
      const { rows: acme } = await db.pool.query(`SELECT is_simulated FROM buyers WHERE id = $1`, [
        r.acme.id,
      ]);
      expect(acme[0].is_simulated).toBe(false);

      // 20 SIM buyers, each one CAPTURE top-up with the deterministic id and PayPal ids.
      expect(r.simTopups).toHaveLength(20);
      expect(allFunded(r)).toBe(true);
      for (const t of r.simTopups) {
        expect(t.topupId).toBe(seedTopupId(t.email));
        expect(t).toMatchObject({ status: 'COMPLETED', created: true });
        expect(t.amountCents).toBeGreaterThanOrEqual(2000);
        expect(t.amountCents).toBeLessThanOrEqual(5000);
        expect(t.amountCents % 100).toBe(0);
        expect(t.paypalOrderId).toEqual(expect.any(String));
        expect(t.paypalCaptureId).toEqual(expect.any(String));
        expect(await topupById(db, t.topupId)).toMatchObject({
          trigger: 'SIM',
          method: 'CARD',
          status: 'COMPLETED',
        });
        expect(await balanceOf(db.pool, t.buyerId)).toBe(t.amountCents * 10_000);
        expect(await authenticateKey(db.pool, t.apiKey)).toMatchObject({
          buyerId: t.buyerId,
          scopes: ['read'],
        });
      }
      const { rows: sims } = await db.pool.query(
        `SELECT count(*)::int AS n FROM buyers WHERE is_simulated`,
      );
      expect(sims[0].n).toBe(20);

      // One order per SIM buyer; concurrency 3; working test cards only (never 5105…5100).
      expect(creates()).toHaveLength(20);
      expect(maxInFlight).toBeLessThanOrEqual(3);
      expect(maxInFlight).toBeGreaterThan(1);
      const cards = bodies.map(
        (b) => (b.payment_source as { card: { number: string } }).card.number,
      );
      expect(cards).toHaveLength(20);
      expect(cards.some((c) => c.startsWith('5105'))).toBe(false);
      expect(new Set(cards).size).toBeGreaterThan(1);

      // TOPUP txns: one per SIM buyer, simulated, dated to the start of the simulated week.
      const txns = await topupTxns(db);
      expect(txns).toHaveLength(20);
      for (const t of txns) {
        expect(t.is_simulated).toBe(true);
        expect(t.created_at.toISOString()).toBe(simulatedWeekStart(now).toISOString());
      }
      expect(simulatedWeekStart(now).toISOString()).toBe('2026-11-05T00:00:00.000Z');

      expect((await counts(db)).crawls).toBe(0);
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('second run creates nothing and calls PayPal for nothing; same keys and passwords', async () => {
      const db = newDb();
      const first = await seedDemo(deps(db));
      const before = await counts(db);
      const callsBefore = fake.calls.length;

      const second = await seedDemo(deps(db));
      expect(await counts(db)).toEqual(before);
      expect(fake.calls.length).toBe(callsBefore);
      expect(second.publisher.created).toBe(false);
      expect(second.site.created).toBe(false);
      expect(second.acme).toMatchObject({
        created: false,
        apiKey: first.acme.apiKey,
        password: first.acme.password,
      });
      expect(second.site.gateKey).toBe(first.site.gateKey);
      expect(second.simTopups.every((t) => t.status === 'COMPLETED' && !t.created)).toBe(true);
      expect(second.simTopups.map((t) => t.paypalOrderId)).toEqual(
        first.simTopups.map((t) => t.paypalOrderId),
      );
      expect(seedApiKey(config.SESSION_SECRET, DEMO_BUYER.email)).toBe(first.acme.apiKey);
      expect(seedPassword(config.SESSION_SECRET, DEMO_BUYER.email)).toBe(first.acme.password);
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('two seeds in parallel → one cast, one PayPal order and one TOPUP txn per SIM buyer', async () => {
      const a = newDb();
      const b = newDb();
      const [ra, rb] = await Promise.all([
        seedDemo(deps(a, fake.client({ timeoutMs: 2_000 }))),
        seedDemo(deps(b, fake.client({ timeoutMs: 2_000 }))),
      ]);
      const c = await counts(a);
      expect(c).toMatchObject({
        publishers: 1,
        sites: 1,
        buyers: 21,
        keys: 21,
        topups: 20,
        txns: 20,
      });
      expect(ra.publisher.id).toBe(rb.publisher.id);
      expect(ra.acme.id).toBe(rb.acme.id);

      for (const spec of simBuyers()) {
        const id = seedTopupId(spec.email);
        expect(fake.orders().filter((o) => o.customId === id)).toHaveLength(1);
        expect(creates().filter((x) => x.requestId === id)).toHaveLength(1);
      }
      expect(await topupTxns(a)).toHaveLength(20);
      // Exactly one run inserted (and paid) each top-up; the other reconciled or saw it in flight.
      for (let i = 0; i < 20; i++) {
        expect(Number(ra.simTopups[i]!.created) + Number(rb.simTopups[i]!.created)).toBe(1);
      }
      // A re-run settles whatever the twin left in flight, still without a second order.
      const rc = await seedDemo(deps(a));
      expect(allFunded(rc)).toBe(true);
      expect(creates()).toHaveLength(20);
      expect(await topupTxns(a)).toHaveLength(20);
      expect((await ledgerCheck(a.pool)).mismatches).toEqual([]);
    });

    it("a seed killed between the top-up insert and PayPal's answer: the re-run reconciles, never a second order", async () => {
      const db = newDb();
      const [one, two] = simBuyers().map((s) => seedTopupId(s.email));
      const base = fake.client({ timeoutMs: 1_000 });
      let hung = 0;
      // Run 1 "dies": for buyer 1 PayPal creates + captures but the answer never arrives; for buyer 2
      // it dies after storing the order id (settle's first step) and before the credit.
      const dying = wrapCreate(base, async (input) => {
        if (input.topupId === one) {
          await base.createTopupOrder(input);
          hung++;
          return never();
        }
        if (input.topupId === two) {
          const res = await base.createTopupOrder(input);
          await db.pool.query(`UPDATE topups SET paypal_order_id = $2 WHERE id = $1`, [
            two,
            res.orderId,
          ]);
          hung++;
          return never();
        }
        return base.createTopupOrder(input);
      });
      void seedDemo(deps(db, dying));
      await expect.poll(async () => (await counts(db)).txns, { timeout: 10_000 }).toBe(18);
      expect(hung).toBe(2);
      expect(await topupById(db, one)).toMatchObject({ status: 'CREATED', paypalOrderId: null });
      expect(fake.orders().filter((o) => o.customId === one)).toHaveLength(1);

      // Re-run right away: buyer 2 is credited from GET order; buyer 1 is still "in flight".
      const r2 = await seedDemo(deps(db));
      const s1 = r2.simTopups.find((t) => t.topupId === one)!;
      const s2 = r2.simTopups.find((t) => t.topupId === two)!;
      expect(s2).toMatchObject({
        status: 'COMPLETED',
        created: false,
        paypalCaptureId: expect.any(String),
      });
      expect(s1).toMatchObject({ status: 'IN_FLIGHT', created: false });

      // Later (the create is > 5 min old): flagged for a human with an alert, no new order.
      await db.pool.query(
        `UPDATE topups SET created_at = now() - interval '10 minutes' WHERE id = $1`,
        [one],
      );
      const r3 = await seedDemo(deps(db));
      expect(r3.simTopups.find((t) => t.topupId === one)).toMatchObject({
        status: 'NEEDS_RECONCILE',
        code: 'SIM_CREATE_STALE',
      });
      expect(await topupById(db, one)).toMatchObject({ needsReconcile: true, status: 'CREATED' });

      for (const id of [one, two]) {
        expect(fake.orders().filter((o) => o.customId === id)).toHaveLength(1);
        expect(creates().filter((c) => c.requestId === id)).toHaveLength(1);
      }
      const txns = await topupTxns(db);
      expect(txns).toHaveLength(19);
      expect(txns.filter((t) => t.key === `topup:${two}`)).toHaveLength(1);
      expect(txns.filter((t) => t.key === `topup:${one}`)).toHaveLength(0);
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('rate-limited by PayPal → ledger-only SIM top-up on the same row, labelled "SIM (no PayPal)"', async () => {
      const db = newDb();
      const now = new Date('2026-11-12T10:30:00Z');
      fake.failNext(
        'order_create',
        { kind: 'status', http: 429, issue: 'RATE_LIMIT_REACHED' },
        100,
      );
      const r = await seedDemo(deps(db, fake.client({ timeoutMs: 1_000, retries: 0 })), {
        simBuyers: 2,
        now,
      });
      expect(allFunded(r)).toBe(true);
      expect(fake.orders()).toHaveLength(0);
      for (const t of r.simTopups) {
        expect(t).toMatchObject({
          status: 'LEDGER_ONLY',
          paypalOrderId: null,
          paypalCaptureId: null,
        });
        expect(await topupById(db, t.topupId)).toMatchObject({
          status: 'COMPLETED',
          paypalOrderId: null,
          paypalCaptureId: null,
          needsReconcile: false,
          trigger: 'SIM',
        });
        expect(await balanceOf(db.pool, t.buyerId)).toBe(t.amountCents * 10_000);
      }
      const txns = await topupTxns(db);
      expect(txns).toHaveLength(2);
      for (const t of txns) {
        expect(t).toMatchObject({ is_simulated: true, memo: SIM_NO_PAYPAL_LABEL });
        expect(t.created_at.toISOString()).toBe(simulatedWeekStart(now).toISOString());
      }
      const { rows } = await db.pool.query(
        `SELECT data FROM audit_events WHERE action = 'TOPUP_COMPLETED' AND data->>'ledgerOnly' = 'true'`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].data.label).toBe(SIM_NO_PAYPAL_LABEL);

      // Re-run: nothing new, no PayPal call.
      fake.clearFaults();
      const callsBefore = fake.calls.length;
      const before = await counts(db);
      const again = await seedDemo(deps(db), { simBuyers: 2 });
      expect(again.simTopups.every((t) => t.status === 'LEDGER_ONLY' && !t.created)).toBe(true);
      expect(await counts(db)).toEqual(before);
      expect(fake.calls.length).toBe(callsBefore);
      expect((await ledgerCheck(db.pool)).mismatches).toEqual([]);
    });

    it('--with-proposals before the live crawl is skipped (the crawl is never seeded)', async () => {
      const db = newDb();
      const r = await seedDemo(deps(db), { simBuyers: 1, withProposals: true });
      expect(r.proposals).toMatchObject({ status: 'skipped' });
      expect((await counts(db)).crawls).toBe(0);
    });

    it('refuses without DEMO_PUBLISHER_PAYOUT_EMAIL on the sandbox', async () => {
      const db = newDb();
      const sandbox = loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: tdb.url,
        PAYPAL_MODE: 'sandbox',
      });
      await expect(seedDemo({ db, config: sandbox, pp: fake.client() })).rejects.toThrow(
        /DEMO_PUBLISHER_PAYOUT_EMAIL/,
      );
      expect((await counts(db)).publishers).toBe(0);
    });
  },
);
