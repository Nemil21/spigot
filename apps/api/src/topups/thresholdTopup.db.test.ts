import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig, type Config } from '../config.js';
import { runEvery } from '../db/index.js';
import { createPool } from '../db/pool.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { createDb, type Db } from '../db/tx.js';
import { setJobDeps, type JobDeps } from '../jobs/deps.js';
import sweepJob from '../jobs/vault-topup-sweep.job.js';
import { sweepOrphanedVaultTopups, VAULT_GIVE_UP_AFTER_MS } from '../jobs/vaultTopupSweep.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { FakePayPal, type PayPalOrdersClient } from '../paypal/index.js';
import { paidRead, type PaidReadResult } from '../services/paidRead.js';
import { REQUIRED_ENV } from '../test/env.js';
import { chargeVaultTopup, reserveVaultTopup } from './autoTopup.js';
import { TOPUP_COLUMNS, type TopupRow } from './row.js';
import { settleThresholdTopups, thresholdTopUp } from './thresholdTopup.js';

/**
 * SP-047c: auto top-up below the threshold (async after a charge) and the orphaned `VAULT_MIT`
 * sweep, on Postgres and FakePayPal.
 */

const FIELDS = [
  { name: 'title', type: 'string', visible: true, filterable: [] },
  { name: 'city', type: 'string', visible: true, filterable: ['eq'] },
];

/** 40 records × $0.0015 = $0.06. */
const LIMIT = 40;
const PRICE = 60_000;
const DOLLAR = 1_000_000;
const TWENTY_DOLLARS = 20 * DOLLAR;
const THRESHOLD = 2 * DOLLAR;
const SEC = 1_000;

describe.skipIf(!testDatabaseUrl)(
  'SP-047c threshold top-up + orphaned VAULT_MIT sweep (Postgres, FakePayPal)',
  { timeout: 120_000 },
  () => {
    let tdb: TestDatabase;
    let pool: pg.Pool;
    let db: Db;
    /** A second "API process": its own pool on the same database. */
    let poolB: pg.Pool;
    let dbB: Db;
    let config: Config;
    let fake: FakePayPal;
    let pp: PayPalOrdersClient;
    let callsBefore = 0;

    beforeAll(async () => {
      tdb = await createTestDatabase();
      pool = createPool(tdb.url, { max: 8, applicationName: 'test-a' });
      db = createDb(pool);
      poolB = createPool(tdb.url, { max: 8, applicationName: 'test-b' });
      dbB = createDb(poolB);
      config = loadConfig({ ...REQUIRED_ENV, DATABASE_URL: tdb.url, PAYPAL_MODE: 'stub' });
      // One fake for the suite: its order ids must stay unique (`topups.paypal_order_id`).
      fake = new FakePayPal({ latencyMs: 5, jitterMs: 10 });
    }, 60_000);
    afterAll(async () => {
      await settleThresholdTopups();
      setJobDeps(undefined);
      await pool?.end();
      await poolB?.end();
      await tdb?.drop();
    });
    beforeEach(() => {
      fake.clearFaults();
      fake.latencyMs = 5;
      fake.jitterMs = 10;
      callsBefore = fake.calls.length;
      pp = fake.client({ timeoutMs: 1_000 });
    });
    afterEach(async () => {
      vi.useRealTimers();
      await settleThresholdTopups();
      setJobDeps(undefined);
    });

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows as T[];

    interface World {
      site: string;
      buyerId: string;
      apiKeyId: string;
      vaultId: string;
    }

    /** A LIVE `listings` dataset and a buyer with auto top-up on ($20, $2 threshold) and a saved card. */
    async function world(opts: { balanceMicros: number; capCents?: number }): Promise<World> {
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
        `INSERT INTO buyers (name, auto_topup_enabled, auto_topup_amount_cents, auto_topup_threshold_micros,
                             monthly_topup_cap_cents, vault_id, vault_kind)
         VALUES ($1, true, 2000, $2, $3, $4, 'CARD') RETURNING id`,
        [`Buyer ${tag}`, THRESHOLD, opts.capCents ?? 10_000, vaultId],
      );
      const k = await createKey(pool, buyer!.id, { scopes: ['read', 'topup'] });
      if (opts.balanceMicros > 0) {
        await db.tx(async (tx) => {
          const b = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyer!.id);
          const { paypalCash } = await platformAccounts(tx);
          await post(tx, {
            kind: 'TOPUP',
            idempotencyKey: `topup:${randomUUID()}`,
            entries: topupEntries({ buyer: b, paypalCash }, opts.balanceMicros),
          });
        });
      }
      return { site, buyerId: buyer!.id, apiKeyId: k.id, vaultId };
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
    const topupTxns = async (topupId: string) =>
      (
        await q(`SELECT id FROM ledger_txns WHERE kind = 'TOPUP' AND idempotency_key = $1`, [
          `topup:${topupId}`,
        ])
      ).length;
    const auditActions = async (topupId: string) =>
      (
        await q<{ action: string }>(
          `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id`,
          [topupId],
        )
      ).map((r) => r.action);
    /** This test's order creates. */
    const creates = () => fake.calls.slice(callsBefore).filter((c) => c.op === 'order_create');
    const jobDeps = (now?: () => number): JobDeps => ({ db, config, pp, ...(now ? { now } : {}) });

    /** A paid read ($0.06) straight through `paidRead` with auto top-up wired, on either "process". */
    const read = (w: World, on: Db = db): Promise<PaidReadResult> =>
      paidRead(
        {
          db: on,
          buyerId: w.buyerId,
          apiKeyId: w.apiKeyId,
          channel: 'REST',
          baseUrl: REQUIRED_ENV.APP_BASE_URL!,
          autoTopup: { pp, config },
        },
        {
          site: w.site,
          dataset: 'listings',
          kind: 'records',
          limit: LIMIT,
          idempotencyKey: randomUUID(),
        },
      );

    // ---------------------------------------------------------------- threshold trigger

    it('a charge leaving $1.50 with a $2 threshold triggers exactly one $20 MIT top-up, no 402', async () => {
      const w = await world({ balanceMicros: 1_500_000 + PRICE });
      const res = await read(w);
      // The call itself is a plain 200: it never waited on PayPal.
      expect(res.status).toBe(200);
      expect(res.balanceMicros).toBe(1_500_000);
      expect(res.autoTopupCents).toBeUndefined();

      await settleThresholdTopups();
      const rows = await topups(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        method: 'VAULT_MIT',
        trigger: 'AUTO',
        status: 'COMPLETED',
        amountCents: 2000,
      });
      expect(await balance(w)).toBe(1_500_000 + TWENTY_DOLLARS);
      expect(await topupTxns(rows[0]!.id)).toBe(1);
      expect(creates().map((c) => c.requestId)).toEqual([rows[0]!.id]);
      const [created] = await q<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'TOPUP_CREATED'`,
        [rows[0]!.id],
      );
      expect(created!.data).toMatchObject({ trigger: 'AUTO', thresholdMicros: THRESHOLD });

      // The next calls are above the threshold: no more top-ups, and still no 402.
      for (let i = 0; i < 3; i++) expect((await read(w)).status).toBe(200);
      await settleThresholdTopups();
      expect(await topups(w)).toHaveLength(1);
      expect(creates()).toHaveLength(1);
    });

    it('a charge that leaves the balance at or above the threshold tops up nothing', async () => {
      const w = await world({ balanceMicros: THRESHOLD + PRICE });
      expect((await read(w)).balanceMicros).toBe(THRESHOLD);
      await settleThresholdTopups();
      expect(await topups(w)).toHaveLength(0);
      expect(creates()).toHaveLength(0);
    });

    it('auto top-up off or no saved method → no threshold top-up', async () => {
      const off = await world({ balanceMicros: DOLLAR });
      await q(`UPDATE buyers SET auto_topup_enabled = false WHERE id = $1`, [off.buyerId]);
      const noVault = await world({ balanceMicros: DOLLAR });
      await q(`UPDATE buyers SET vault_id = NULL, vault_kind = NULL WHERE id = $1`, [
        noVault.buyerId,
      ]);
      expect((await read(off)).status).toBe(200);
      expect((await read(noVault)).status).toBe(200);
      await settleThresholdTopups();
      expect(await topups(off)).toHaveLength(0);
      expect(await topups(noVault)).toHaveLength(0);
      expect(creates()).toHaveLength(0);
    });

    it('a burst of below-threshold charges on two processes → one MIT order', async () => {
      const w = await world({ balanceMicros: DOLLAR });
      fake.latencyMs = 40;
      // 10 paid calls (5 per "process") plus 10 direct triggers, so the DB rule is what dedupes,
      // not the per-process map. allSettled: a failure must not leave the rest running into the
      // next test (a stray CREATED row there is swept and replayed as a second request id).
      const settled = await Promise.allSettled([
        ...Array.from({ length: 10 }, (_, i) => read(w, i % 2 ? dbB : db)),
        ...Array.from({ length: 10 }, (_, i) =>
          thresholdTopUp(
            { db: i % 2 ? dbB : db, pp, config },
            { buyerId: w.buyerId, balanceMicros: 0 },
          ),
        ),
      ]);
      await settleThresholdTopups();
      expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
      const results = settled.map((s) => (s as PromiseFulfilledResult<unknown>).value);
      expect(results.slice(0, 10).every((r) => (r as PaidReadResult).status === 200)).toBe(true);
      const rows = await topups(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('COMPLETED');
      expect(new Set(creates().map((c) => c.requestId))).toEqual(new Set([rows[0]!.id]));
      expect(await balance(w)).toBe(DOLLAR - 10 * PRICE + TWENTY_DOLLARS);
    });

    it('race: threshold trigger and an in-request short-balance top-up → one MIT order', async () => {
      for (let round = 0; round < 6; round++) {
        callsBefore = fake.calls.length;
        // $0.01 left: below the threshold, and short for a $0.06 call.
        const w = await world({ balanceMicros: 10_000 });
        fake.latencyMs = 30;
        const [trigger, res] = await Promise.all([
          thresholdTopUp({ db: dbB, pp, config }, { buyerId: w.buyerId, balanceMicros: 10_000 }),
          // Vary who reaches the buyer row lock first.
          new Promise((r) => setTimeout(r, round * 7)).then(() => read(w)),
        ]);
        await settleThresholdTopups();

        // The short call never 402s: it either made the top-up or waited for the trigger's.
        expect(res.status).toBe(200);
        const rows = await topups(w);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'COMPLETED', trigger: 'AUTO' });
        expect(new Set(creates().map((c) => c.requestId))).toEqual(new Set([rows[0]!.id]));
        expect(await topupTxns(rows[0]!.id)).toBe(1);
        expect(await balance(w)).toBe(10_000 + TWENTY_DOLLARS - PRICE);
        if (res.autoTopupCents === 2000) {
          expect(trigger.result).toBe('SKIPPED');
        } else {
          expect(trigger).toMatchObject({ result: 'TOPPED_UP', topupId: rows[0]!.id });
        }
      }
    });

    it('lock order: reservations, a charge and a credit on one buyer never deadlock', async () => {
      // The interleaving behind main's red burst test, made deterministic. Foreign keys lock the
      // buyer row: inserting `api_calls` takes FOR KEY SHARE on it, and so does a second UPDATE of a
      // `topups` row in one transaction (creditTopupTx's ledger_txn_id). With reservations taking
      // FOR UPDATE: (1) reservation A holds the buyer row; (2) a charge's FK check waits for A;
      // (3) reservation B queues behind it; (4) a credit holding the ledger row runs its FK check
      // and queues behind B; (5) A commits, the charge locks the row and waits for the credit's
      // ledger row, B waits for the charge, the credit waits for B: 40P01, and the captured
      // top-up's credit rolls back.
      const w = await world({ balanceMicros: DOLLAR });
      const [acct] = await q<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE kind = 'BUYER_BALANCE' AND owner_id = $1`,
        [w.buyerId],
      );
      const [row] = await q<{ id: string }>(
        `INSERT INTO topups (buyer_id, amount_cents, method) VALUES ($1, 2000, 'CARD') RETURNING id`,
        [w.buyerId],
      );
      const pidOf = async (c: pg.PoolClient) =>
        (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const waiting = async (pid: number) =>
        (
          await q<{ w: boolean }>(
            `SELECT wait_event_type = 'Lock' AS w FROM pg_stat_activity WHERE pid = $1`,
            [pid],
          )
        )[0]?.w === true;
      const reservationsWaiting = async () =>
        (
          await q<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%FROM buyers WHERE id = $1 FOR%'`,
          )
        )[0]!.n;
      /** Settled, or blocked on a row / tuple lock (the fixed lock order never blocks there). */
      const settledOrWaiting = async (p: { done: boolean }, pid?: number) => {
        for (let i = 0; i < 200; i++) {
          if (p.done || (pid !== undefined && (await waiting(pid)))) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('neither settled nor waiting');
      };
      const track = <T>(promise: Promise<T>) => {
        const t = { done: false, promise };
        promise.then(
          () => (t.done = true),
          () => (t.done = true),
        );
        return t;
      };

      // (1) Reservation A, paused right after it locks the buyer row (the real reserveVaultTopup).
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const paused: Db = {
        pool,
        tx: (fn) =>
          db.tx((tx) => {
            let first = true;
            const query = tx.query.bind(tx) as (...a: unknown[]) => Promise<unknown>;
            const proxy = new Proxy(tx, {
              get: (t, p) =>
                p === 'query'
                  ? async (...a: unknown[]) => {
                      const r = await query(...a);
                      if (first) {
                        first = false;
                        locked();
                        await gate;
                      }
                      return r;
                    }
                  : Reflect.get(t, p),
            });
            return fn(proxy);
          }),
      };
      const opts = { buyerId: w.buyerId, trigger: 'AUTO' as const, whenBelowMicros: 0 };
      const a = track(reserveVaultTopup(paused, opts));
      await isLocked;

      const charge = await pool.connect();
      const credit = await poolB.connect();
      try {
        // (2) The charge: claimCall's insert (FK check on the buyer row).
        const chargePid = await pidOf(charge);
        await charge.query('BEGIN');
        const claim = track(
          charge.query(
            `INSERT INTO api_calls (buyer_id, api_key_id, channel, request_hash, idempotency_key)
             VALUES ($1, $2, 'REST', 'h', $3)`,
            [w.buyerId, w.apiKeyId, randomUUID()],
          ),
        );
        await settledOrWaiting(claim, chargePid);
        // (3) Reservation B (the real one) queues for the buyer row.
        const b = track(reserveVaultTopup(dbB, opts));
        for (let i = 0; i < 200 && (await reservationsWaiting()) < 1; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(await reservationsWaiting()).toBe(1);
        // (4) The credit: transition, post() locks the ledger row, then the second UPDATE.
        const creditPid = await pidOf(credit);
        await credit.query('BEGIN');
        await credit.query(`UPDATE topups SET updated_at = now() WHERE id = $1`, [row!.id]);
        await credit.query(`SELECT 1 FROM ledger_accounts WHERE id = $1 FOR UPDATE`, [acct!.id]);
        const second = track(
          credit.query(`UPDATE topups SET updated_at = now() WHERE id = $1`, [row!.id]),
        );
        await settledOrWaiting(second, creditPid);
        // (5) A commits; the charge goes on to post(), which needs the credit's ledger row.
        release();
        await a.promise;
        await claim.promise;
        const post = track(
          charge.query(`SELECT 1 FROM ledger_accounts WHERE id = $1 FOR UPDATE`, [acct!.id]),
        );
        // Postgres reports a deadlock within deadlock_timeout (1 s); the fixed order has none.
        await Promise.race([
          second.promise,
          post.promise,
          b.promise,
          new Promise((r) => setTimeout(r, 3_000)),
        ]).catch(() => {});
        // An aborted transaction keeps its locks until ROLLBACK: end the free one first.
        if (post.done) {
          await charge.query('ROLLBACK');
          await second.promise.catch(() => {});
          await credit.query('ROLLBACK');
        } else {
          await second.promise.catch(() => {});
          await credit.query('ROLLBACK');
          await post.promise.catch(() => {});
          await charge.query('ROLLBACK');
        }
        const outcomes = await Promise.allSettled([
          second.promise,
          post.promise,
          b.promise,
          a.promise,
        ]);
        expect(outcomes.filter((o) => o.status === 'rejected')).toEqual([]);
        expect(await b.promise).toMatchObject({ kind: 'BALANCE_OK', balanceMicros: DOLLAR });
      } finally {
        release();
        await credit.query('ROLLBACK').catch(() => {});
        await charge.query('ROLLBACK').catch(() => {});
        credit.release();
        charge.release();
        await q(`UPDATE topups SET status = 'FAILED' WHERE id = $1`, [row!.id]);
      }
    });

    it('a threshold top-up that is declined turns auto top-up off, as a short call would', async () => {
      const w = await world({ balanceMicros: DOLLAR });
      fake.failNext('order_create', { kind: 'decline' });
      const out = await thresholdTopUp(
        { db, pp, config },
        { buyerId: w.buyerId, balanceMicros: DOLLAR },
      );
      expect(out).toMatchObject({ result: 'DECLINED', code: 'INSTRUMENT_DECLINED' });
      const [row] = await topups(w);
      expect(row).toMatchObject({ status: 'FAILED', errorCode: 'INSTRUMENT_DECLINED' });
      const [b] = await q<{ on: boolean }>(
        `SELECT auto_topup_enabled AS on FROM buyers WHERE id = $1`,
        [w.buyerId],
      );
      expect(b!.on).toBe(false);
      expect(await balance(w)).toBe(DOLLAR);
    });

    // ---------------------------------------------------------------- orphan sweep

    /** Reserve a vault top-up and run its create with every answer lost (the client times out). */
    async function lostCreate(w: World): Promise<TopupRow> {
      const lossy = fake.client({ timeoutMs: 150, retries: 2 });
      // The first create and both same-id retries do the work, then lose the response.
      fake.failNext('order_create', { kind: 'drop_response' }, 3);
      const r = await reserveVaultTopup(db, { buyerId: w.buyerId, trigger: 'AUTO' });
      if (r.kind !== 'RESERVED') throw new Error(`expected RESERVED, got ${r.kind}`);
      const out = await chargeVaultTopup({ db, pp: lossy, config }, r, { timeoutMs: 5_000 });
      expect(out.status).toBe('ERROR');
      const [row] = await topups(w);
      expect(row).toMatchObject({ status: 'CREATED', paypalOrderId: null });
      return row!;
    }

    it('a MIT top-up whose create timed out (response lost) is credited by the sweep within 60 s, once', async () => {
      const w = await world({ balanceMicros: 10_000 });
      const row = await lostCreate(w);
      // PayPal did capture it: the fake holds one order for this request id.
      expect(creates().map((c) => c.requestId)).toEqual([row.id, row.id, row.id]);
      expect(await balance(w)).toBe(10_000);

      // Under 30 s old: the sweep leaves it to its own call.
      expect(await sweepOrphanedVaultTopups(jobDeps())).toEqual({ swept: 0, outcomes: {} });

      fake.latencyMs = 0;
      fake.jitterMs = 0;
      setJobDeps(jobDeps());
      const realSetTimeout = globalThis.setTimeout;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const start = Date.now();
      const tickOf = (ms: number) => Math.floor(ms / sweepJob.everyMs);
      const ran: number[] = [];
      let settled = 0;
      const handle = runEvery(pool, sweepJob.name, sweepJob.everyMs, async () => sweepJob.run(), {
        onRun: (t) => ran.push(t),
        onSettled: () => settled++,
        onError: (err) => {
          throw err;
        },
      });
      // 60 s of job clock, 5 s at a time. A tick's database and PayPal I/O is real, so let each
      // tick that started finish (in real time) before moving the clock past the next boundary.
      for (let elapsed = 0; elapsed < 60 * SEC; elapsed += 5 * SEC) {
        await vi.advanceTimersByTimeAsync(5 * SEC);
        while (settled < tickOf(Date.now()) - tickOf(start)) {
          await new Promise((r) => realSetTimeout(r, 10));
        }
      }
      vi.useRealTimers();
      await handle.stop();
      expect((await topups(w))[0]!.status).toBe('COMPLETED');

      expect(ran.length).toBeGreaterThanOrEqual(1);
      expect(await balance(w)).toBe(10_000 + TWENTY_DOLLARS);
      expect(await topupTxns(row.id)).toBe(1);
      // Every create carried the same PayPal-Request-Id; PayPal replayed the one order.
      expect(new Set(creates().map((c) => c.requestId))).toEqual(new Set([row.id]));
      const orderIds = new Set(
        fake
          .orders()
          .filter((o) => o.customId === row.id)
          .map((o) => o.id),
      );
      expect(orderIds.size).toBe(1);
      expect((await topups(w))[0]!.paypalOrderId).toBe([...orderIds][0]);
      const completed = await q<{ actor_id: string }>(
        `SELECT actor_id FROM audit_events WHERE entity_id = $1 AND action = 'TOPUP_COMPLETED'`,
        [row.id],
      );
      expect(completed).toEqual([{ actor_id: 'job:vault-topup-sweep' }]);

      // Later ticks find nothing to do.
      expect(await sweepOrphanedVaultTopups(jobDeps(() => Date.now() + 5 * 60 * SEC))).toEqual({
        swept: 0,
        outcomes: {},
      });
    });

    it('race: the sweep and a late original response for the same top-up → one credit', async () => {
      for (let round = 0; round < 6; round++) {
        callsBefore = fake.calls.length;
        const w = await world({ balanceMicros: 10_000 });
        fake.latencyMs = 0;
        fake.jitterMs = 0;
        const r = await reserveVaultTopup(db, { buyerId: w.buyerId, trigger: 'AUTO' });
        if (r.kind !== 'RESERVED') throw new Error(`expected RESERVED, got ${r.kind}`);
        // The original create is slow; its caller gives up after 20 ms but the call goes on.
        // Round 0: the original lands well after the sweep. Later rounds: around the same time.
        fake.failNext('order_create', { kind: 'latency', ms: round === 0 ? 300 : 60 });
        const slow = fake.client({ timeoutMs: 2_000 });
        const out = await chargeVaultTopup({ db, pp: slow, config }, r, { timeoutMs: 20 });
        expect(out.status).toBe('TIMEOUT');

        if (round > 0) fake.failNext('order_create', { kind: 'latency', ms: 10 + round * 8 });
        const later = () => Date.now() + 31 * SEC;
        const swept = await sweepOrphanedVaultTopups(jobDeps(later));
        expect(swept.swept).toBeGreaterThanOrEqual(1);

        // Wait for the original's late answer to be applied too.
        await vi.waitFor(() => expect(creates()).toHaveLength(2), { timeout: 5_000 });
        await new Promise((res) => setTimeout(res, 150));

        const [row] = await topups(w);
        expect(row!.status).toBe('COMPLETED');
        expect(await topupTxns(row!.id)).toBe(1);
        expect(await balance(w)).toBe(10_000 + TWENTY_DOLLARS);
        expect((await auditActions(row!.id)).filter((a) => a === 'TOPUP_COMPLETED')).toHaveLength(
          1,
        );
        expect(new Set(creates().map((c) => c.requestId))).toEqual(new Set([row!.id]));
      }
    });

    it('stuck CREATED with no order for 10 min → FAILED + needs_reconcile + alert, and auto top-up works again', async () => {
      const w = await world({ balanceMicros: 10_000 });
      // A row whose process died before PayPal ever saw it, 10+ minutes ago.
      const [stuck] = await q<{ id: string }>(
        `INSERT INTO topups (buyer_id, amount_cents, method, trigger, created_at)
         VALUES ($1, 2000, 'VAULT_MIT', 'AUTO', now() - interval '11 minutes') RETURNING id`,
        [w.buyerId],
      );
      // It blocks auto top-up: a short call is a plain 402.
      const jammed = await read(w);
      expect(jammed.status).toBe(402);
      expect(jammed.autoTopupCents).toBeUndefined();

      // PayPal doesn't answer the replay (503 on the create and both retries).
      fake.failNext('order_create', { kind: 'status', http: 503 }, 3);
      const swept = await sweepOrphanedVaultTopups(jobDeps(), { log: () => {} });
      expect(swept).toEqual({ swept: 1, outcomes: { GAVE_UP: 1 } });

      const [row] = await q<TopupRow>(`SELECT ${TOPUP_COLUMNS} FROM topups WHERE id = $1`, [
        stuck!.id,
      ]);
      expect(row).toMatchObject({
        status: 'FAILED',
        needsReconcile: true,
        errorCode: 'VAULT_TOPUP_UNRESOLVED',
        paypalOrderId: null,
      });
      expect(await auditActions(stuck!.id)).toEqual(['TOPUP_FAILED', 'ALERT']);
      const [alert] = await q<{ data: Record<string, unknown> }>(
        `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'ALERT'`,
        [stuck!.id],
      );
      expect(alert!.data).toMatchObject({ alert: 'VAULT_TOPUP_UNRESOLVED', topupId: stuck!.id });
      // Nothing was declined: auto top-up stays on, and the next short call tops up.
      const [b] = await q<{ on: boolean }>(
        `SELECT auto_topup_enabled AS on FROM buyers WHERE id = $1`,
        [w.buyerId],
      );
      expect(b!.on).toBe(true);
      const res = await read(w);
      expect(res.status).toBe(200);
      expect(res.autoTopupCents).toBe(2000);
      expect(await balance(w)).toBe(10_000 + TWENTY_DOLLARS - PRICE);

      // The next tick leaves the FAILED row alone (and alerts once only).
      expect(await sweepOrphanedVaultTopups(jobDeps())).toEqual({ swept: 0, outcomes: {} });
      expect(await auditActions(stuck!.id)).toEqual(['TOPUP_FAILED', 'ALERT']);
    });

    it('an unresolved row under 10 min stays CREATED; a needs_reconcile row is never replayed', async () => {
      const w = await world({ balanceMicros: 10_000 });
      const [young] = await q<{ id: string }>(
        `INSERT INTO topups (buyer_id, amount_cents, method, trigger, created_at)
         VALUES ($1, 2000, 'VAULT_MIT', 'AUTO', now() - interval '2 minutes') RETURNING id`,
        [w.buyerId],
      );
      fake.failNext('order_create', { kind: 'status', http: 503 }, 3);
      expect(await sweepOrphanedVaultTopups(jobDeps(), { log: () => {} })).toEqual({
        swept: 1,
        outcomes: { UNRESOLVED: 1 },
      });
      expect((await topups(w))[0]!.status).toBe('CREATED');

      // Flagged (e.g. a capture that didn't match): no replay, so no repeated alert.
      await q(`UPDATE topups SET needs_reconcile = true WHERE id = $1`, [young!.id]);
      callsBefore = fake.calls.length;
      expect(await sweepOrphanedVaultTopups(jobDeps())).toEqual({
        swept: 1,
        outcomes: { UNRESOLVED: 1 },
      });
      expect(creates()).toHaveLength(0);

      // …until it is 10 min old: FAILED, which frees the slot.
      const out = await sweepOrphanedVaultTopups(
        jobDeps(() => Date.now() + VAULT_GIVE_UP_AFTER_MS),
      );
      expect(out).toEqual({ swept: 1, outcomes: { GAVE_UP: 1 } });
      expect(creates()).toHaveLength(0);
    });

    it('the sweep job autoloads every 30 s', async () => {
      const { loadJobs } = await import('../jobs/index.js');
      const jobs = await loadJobs();
      expect(jobs.find((j) => j.name === 'vault-topup-sweep')?.everyMs).toBe(30 * SEC);
    });
  },
);
