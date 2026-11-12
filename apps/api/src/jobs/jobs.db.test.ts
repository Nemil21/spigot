import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { loadConfig } from '../config.js';
import { createDb, createPool, runEvery, runJobTick } from '../db/index.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { claimCall } from '../meter/idempotency.js';
import { FakePayPal } from '../paypal/index.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { seedDataset } from '../test/extract-fixtures.js';
import { balanceOf, setTopupPayPal, topupById } from '../topups/index.js';
import { defaultJobDeps, setJobDeps, type JobDeps } from './deps.js';
import { loadJobs } from './index.js';
import pollerJob from './topup-poller.job.js';
import { abandonStaleTopups, retentionSweep } from './sweeps.js';
import { pollOpenTopups } from './topupPoller.js';

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const MIN = 60_000;

/** FakePayPal answers with every capture's amount rewritten to `value` (a mismatched capture). */
function amountRewritingFetch(fake: FakePayPal, value: string): typeof fetch {
  return async (input, init) => {
    const res = await fake.fetch(input, init);
    if (res.status >= 300) return res;
    const body = (await res.json()) as {
      purchase_units?: { payments?: { captures?: { amount: unknown }[] } }[];
    };
    for (const pu of body.purchase_units ?? []) {
      for (const c of pu.payments?.captures ?? []) c.amount = { value, currency_code: 'USD' };
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  };
}

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe('jobs are off in tests unless enabled', () => {
  it('defaultJobDeps is null under vitest until setJobDeps, so a job tick touches nothing', async () => {
    expect(defaultJobDeps()).toBeNull();
    await expect(pollerJob.run()).resolves.toBeUndefined();
  });

  it('the three SP-019 jobs autoload with their intervals', async () => {
    const jobs = await loadJobs();
    const byName = Object.fromEntries(jobs.map((j) => [j.name, j.everyMs]));
    expect(byName).toMatchObject({
      'topup-poller': 30_000,
      'topup-abandon-sweep': 5 * MIN,
      'retention-sweep': 60 * MIN,
    });
  });
});

describe.skipIf(!testDatabaseUrl)('SP-019 jobs (Postgres + FakePayPal)', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let fake: FakePayPal;
  let deps: JobDeps;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await buildServer(
      loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url, PAYPAL_MODE: 'stub' }),
      { logger: false },
    );
    await app.ready();
    // No latency: the fake's delays are timers, and one test runs under fake timers.
    fake = new FakePayPal({ latencyMs: 0, jitterMs: 0 });
  });
  afterAll(async () => {
    setTopupPayPal(undefined);
    setJobDeps(undefined);
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    app.rateLimiter.reset();
    fake.clearFaults();
    const pp = fake.client({ timeoutMs: 1_000 });
    setTopupPayPal(pp);
    deps = { db: app.db, config: app.config, pp };
    setJobDeps(deps);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const agent = () => request(app.server);

  async function newBuyer() {
    const res = await agent()
      .post('/api/buyer/signup')
      .set('Origin', ORIGIN)
      .send({ name: 'Acme', email: `b-${randomUUID()}@example.com`, password: 'correct horse' });
    expect(res.status).toBe(201);
    return { id: res.body.buyerId as string, cookie: cookiesOf(res) };
  }

  /** A $20 wallet top-up waiting for the buyer at PayPal. */
  async function openTopup(cookie: string) {
    const res = await agent()
      .post('/api/buyer/topups')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 2000, method: 'PAYPAL_WALLET', saveForAutoTopup: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { topupId: res.body.topupId as string, orderId: res.body.orderId as string };
  }

  const capture = (cookie: string, id: string) =>
    agent()
      .post(`/api/buyer/topups/${id}/capture`)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({});

  const backdate = (topupId: string, minutes: number) =>
    app.db.pool.query(
      `UPDATE topups SET created_at = now() - make_interval(mins => $2) WHERE id = $1`,
      [topupId, minutes],
    );

  async function topupTxns(topupId: string) {
    const { rows } = await app.db.pool.query(
      `SELECT id FROM ledger_txns WHERE idempotency_key = $1`,
      [`topup:${topupId}`],
    );
    return rows.length;
  }

  const getOrders = (orderId: string) =>
    fake.calls.filter((c) => c.op === 'get_order' && c.path.endsWith(`/${orderId}`)).length;
  const captures = (orderId: string) =>
    fake.calls.filter((c) => c.op === 'capture' && c.path.includes(`/${orderId}/`));

  it('buyer approves, then closes the tab before our capture → the poller credits within 60 s', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await openTopup(buyer.cookie);
    fake.approve(orderId); // …and the W11 tab is gone: nobody calls /capture.

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const ran: number[] = [];
    const handle = runEvery(
      app.db.pool,
      pollerJob.name,
      pollerJob.everyMs,
      async () => pollerJob.run(),
      {
        onRun: (t) => ran.push(t),
        onError: (err) => {
          throw err;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await handle.stop();
    // A tick that started inside the 60 s may still be finishing its I/O: wait for it.
    await vi.waitFor(
      async () => expect((await topupById(app.db, topupId))?.status).toBe('COMPLETED'),
      {
        timeout: 5_000,
      },
    );

    expect(ran.length).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
    expect(await topupTxns(topupId)).toBe(1);
    expect(captures(orderId).map((c) => c.requestId)).toEqual([`capture:${topupId}`]);
    const { rows } = await app.db.pool.query(
      `SELECT actor_type FROM audit_events WHERE entity_id = $1 AND action = 'TOPUP_COMPLETED'`,
      [topupId],
    );
    expect(rows).toEqual([{ actor_type: 'SYSTEM' }]);
  });

  it('poller and capture endpoint racing → one credit', async () => {
    for (let round = 0; round < 5; round++) {
      const buyer = await newBuyer();
      const { topupId, orderId } = await openTopup(buyer.cookie);
      fake.approve(orderId);
      const [cap] = await Promise.all([
        capture(buyer.cookie, topupId),
        pollOpenTopups(deps),
        pollOpenTopups(deps),
        capture(buyer.cookie, topupId),
      ]);
      expect(cap.status, JSON.stringify(cap.body)).toBe(200);
      expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
      expect(await topupTxns(topupId)).toBe(1);
      // Every capture attempt used the same request id, so PayPal captured once.
      expect(new Set(captures(orderId).map((c) => c.requestId))).toEqual(
        new Set([`capture:${topupId}`]),
      );
      expect(fake.order(orderId)?.captureIds).toHaveLength(1);
    }
  });

  it('a capture that does not match → one ALERT, then the poller leaves the row alone', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await openTopup(buyer.cookie);
    fake.approve(orderId);
    await deps.pp.captureOrder(orderId, topupId); // captured at PayPal, not credited yet
    // PayPal reports a different amount than the top-up asked for.
    const mismatched = fake.client({
      timeoutMs: 1_000,
      fetch: amountRewritingFetch(fake, '19.00'),
    });
    const before = getOrders(orderId);

    for (let i = 0; i < 5; i++) await pollOpenTopups({ ...deps, pp: mismatched });

    expect(getOrders(orderId) - before).toBe(1);
    expect(await topupById(app.db, topupId)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      needsReconcile: true,
    });
    const { rows } = await app.db.pool.query(
      `SELECT id FROM audit_events WHERE entity_id = $1 AND action = 'ALERT'`,
      [topupId],
    );
    expect(rows).toHaveLength(1);
    expect(await topupTxns(topupId)).toBe(0);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(0);
  });

  it('31-min-old unapproved top-up → ABANDONED (after one getOrder); a 29-min-old one is left', async () => {
    const buyer = await newBuyer();
    const old = await openTopup(buyer.cookie);
    const young = await openTopup(buyer.cookie);
    await backdate(old.topupId, 31);
    await backdate(young.topupId, 29);

    await abandonStaleTopups(deps);
    expect((await topupById(app.db, old.topupId))?.status).toBe('ABANDONED');
    expect(getOrders(old.orderId)).toBe(1);
    expect((await topupById(app.db, young.topupId))?.status).toBe('AWAITING_APPROVAL');
    expect(getOrders(young.orderId)).toBe(0);

    // The poller no longer looks at it either.
    await pollOpenTopups(deps);
    expect(getOrders(old.orderId)).toBe(1);
  });

  it('the sweep never strands money: approved → captured + credited; captured elsewhere → credited', async () => {
    const buyer = await newBuyer();
    const approved = await openTopup(buyer.cookie);
    fake.approve(approved.orderId);
    await backdate(approved.topupId, 31);

    // Captured at PayPal (e.g. our capture's response was lost), but never credited.
    const captured = await openTopup(buyer.cookie);
    fake.approve(captured.orderId);
    await deps.pp.captureOrder(captured.orderId, captured.topupId);
    await backdate(captured.topupId, 45);

    const res = await abandonStaleTopups(deps);
    expect(res.stale.outcomes).toMatchObject({ COMPLETED: 2 });
    for (const t of [approved, captured]) {
      expect((await topupById(app.db, t.topupId))?.status).toBe('COMPLETED');
      expect(await topupTxns(t.topupId)).toBe(1);
    }
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(40_000_000);
    expect(fake.order(captured.orderId)?.captureIds).toHaveLength(1);
  });

  it('abandon, then capture (approval at minute 31) → credited once', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await openTopup(buyer.cookie);
    await backdate(topupId, 31);
    await abandonStaleTopups(deps);
    expect((await topupById(app.db, topupId))?.status).toBe('ABANDONED');

    fake.approve(orderId); // the buyer finally approves; W11's onApprove captures
    const [a, b] = await Promise.all([
      capture(buyer.cookie, topupId),
      capture(buyer.cookie, topupId),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toMatchObject({ status: 'COMPLETED', balanceMicros: 20_000_000 });

    // Every later path is a no-op.
    await abandonStaleTopups(deps);
    await pollOpenTopups(deps);
    expect((await capture(buyer.cookie, topupId)).body.status).toBe('COMPLETED');
    expect(await topupTxns(topupId)).toBe(1);
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
    expect(fake.order(orderId)?.captureIds).toHaveLength(1);
  });

  it('a row with pending_reason is never abandoned; it is credited when the capture clears', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await openTopup(buyer.cookie);
    fake.approve(orderId);
    fake.pendNextCapture('ECHECK');
    const cap = await capture(buyer.cookie, topupId);
    expect(cap.status, JSON.stringify(cap.body)).toBe(200);
    expect(cap.body).toMatchObject({ status: 'AWAITING_APPROVAL', pendingReason: 'ECHECK' });
    expect(await topupById(app.db, topupId)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      pendingReason: 'ECHECK',
    });
    await backdate(topupId, 120);

    for (let i = 0; i < 3; i++) await abandonStaleTopups(deps);
    expect(await topupById(app.db, topupId)).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect(await topupTxns(topupId)).toBe(0);

    // The eCheck clears; the next sweep sees it COMPLETED and credits.
    fake.settleCapture(fake.order(orderId)!.captureIds[0]!);
    await abandonStaleTopups(deps);
    expect((await topupById(app.db, topupId))?.status).toBe('COMPLETED');
    expect(await balanceOf(app.db.pool, buyer.id)).toBe(20_000_000);
  });

  it('a PENDING capture that clears with the wrong amount → one ALERT, then the sweep leaves it', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await openTopup(buyer.cookie);
    fake.approve(orderId);
    fake.pendNextCapture('ECHECK');
    expect((await capture(buyer.cookie, topupId)).body).toMatchObject({ pendingReason: 'ECHECK' });
    await backdate(topupId, 120);
    fake.settleCapture(fake.order(orderId)!.captureIds[0]!);
    const mismatched = fake.client({
      timeoutMs: 1_000,
      fetch: amountRewritingFetch(fake, '19.00'),
    });
    const before = getOrders(orderId);

    for (let i = 0; i < 4; i++) await abandonStaleTopups({ ...deps, pp: mismatched });

    expect(getOrders(orderId) - before).toBe(1);
    expect(await topupById(app.db, topupId)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      pendingReason: 'ECHECK',
      needsReconcile: true,
    });
    const { rows } = await app.db.pool.query(
      `SELECT id FROM audit_events WHERE entity_id = $1 AND action = 'ALERT'`,
      [topupId],
    );
    expect(rows).toHaveLength(1);
    expect(await topupTxns(topupId)).toBe(0);
  });

  it('a row with paypal_capture_id or needs_reconcile is skipped by the sweep (no PayPal call)', async () => {
    const buyer = await newBuyer();
    const withCapture = await openTopup(buyer.cookie);
    const reconcile = await openTopup(buyer.cookie);
    await app.db.pool.query(`UPDATE topups SET paypal_capture_id = $2 WHERE id = $1`, [
      withCapture.topupId,
      `CAP-${randomUUID()}`,
    ]);
    await app.db.pool.query(`UPDATE topups SET needs_reconcile = true WHERE id = $1`, [
      reconcile.topupId,
    ]);
    await backdate(withCapture.topupId, 40);
    await backdate(reconcile.topupId, 40);

    await abandonStaleTopups(deps);
    for (const t of [withCapture, reconcile]) {
      expect((await topupById(app.db, t.topupId))?.status).toBe('AWAITING_APPROVAL');
      expect(getOrders(t.orderId)).toBe(0);
    }
  });

  it('PayPal unreachable during the sweep → not abandoned (retried next sweep)', async () => {
    const buyer = await newBuyer();
    const { topupId, orderId } = await openTopup(buyer.cookie);
    await backdate(topupId, 31);
    fake.failNext('get_order', { kind: 'status', http: 503 }, 10);
    await abandonStaleTopups(deps);
    expect((await topupById(app.db, topupId))?.status).toBe('AWAITING_APPROVAL');
    fake.clearFaults();
    await abandonStaleTopups(deps);
    expect((await topupById(app.db, topupId))?.status).toBe('ABANDONED');
    expect(getOrders(orderId)).toBeGreaterThanOrEqual(2);
  });

  it('an order PayPal no longer has (404) is abandoned: nothing can have been captured', async () => {
    const buyer = await newBuyer();
    const { topupId } = await openTopup(buyer.cookie);
    await app.db.pool.query(`UPDATE topups SET paypal_order_id = $2 WHERE id = $1`, [
      topupId,
      `GONE-${randomUUID().slice(0, 8)}`,
    ]);
    await backdate(topupId, 31);
    await abandonStaleTopups(deps);
    expect((await topupById(app.db, topupId))?.status).toBe('ABANDONED');
  });

  it('two API processes → each job runs once per tick', async () => {
    const a = createPool(db.url, { max: 4, applicationName: 'proc-a' });
    const b = createPool(db.url, { max: 4, applicationName: 'proc-b' });
    try {
      const jobs = await loadJobs();
      for (const job of jobs) {
        const runs: string[] = [];
        // Ticks far ahead of the wall clock, so no other test's tick collides.
        const base = Math.floor(Date.now() / job.everyMs) + 1_000;
        for (let t = base; t < base + 5; t++) {
          const fn = (who: string) => async () => {
            runs.push(who);
            setJobDeps({ ...deps, db: createDb(who === 'a' ? a : b) });
            await job.run();
          };
          const ran = await Promise.all([
            runJobTick(a, job.name, t, fn('a')),
            runJobTick(b, job.name, t, fn('b')),
          ]);
          expect(ran.filter(Boolean), `${job.name} tick ${t}`).toHaveLength(1);
        }
        expect(runs, job.name).toHaveLength(5);
      }
    } finally {
      setJobDeps(deps);
      await Promise.all([a.end(), b.end()]);
    }
  });

  describe('retention', () => {
    async function seedCalls() {
      const ds = await seedDataset(app.db.pool, randomUUID().slice(0, 8));
      const buyer = (
        await app.db.pool.query<{ id: string }>(
          `INSERT INTO buyers (name) VALUES ('Ret') RETURNING id`,
        )
      ).rows[0]!.id;
      const key = (
        await app.db.pool.query<{ id: string }>(
          `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'ret', $2) RETURNING id`,
          [buyer, `hash-${randomUUID()}`],
        )
      ).rows[0]!.id;
      const call = async (hoursAgo: number) => {
        const idem = randomUUID();
        await app.db.pool.query(
          `INSERT INTO api_calls (buyer_id, api_key_id, channel, dataset_id, endpoint, idempotency_key,
                                  request_hash, status, http_status, response_body, served_record_keys, created_at)
           VALUES ($1, $2, 'REST', $3, 'records.search', $4, 'h', 'NOT_CHARGED', 200,
                   '{"records":[]}', '[{"key":"k1","hash":"x"}]', now() - make_interval(hours => $5))`,
          [buyer, key, ds.datasetId, idem, hoursAgo],
        );
        return idem;
      };
      return { ds, buyer, key, call };
    }

    it('nulls response_body after 24 h, keeps served_record_keys; a replay then gets IDEMPOTENCY_KEY_EXPIRED', async () => {
      const { ds, buyer, key, call } = await seedCalls();
      const fresh = await call(23);
      const old = await call(25);
      const week = await call(24 * 6);

      await retentionSweep(deps);
      const { rows } = await app.db.pool.query<{
        idempotency_key: string;
        response_body: unknown;
        served_record_keys: unknown;
      }>(
        `SELECT idempotency_key, response_body, served_record_keys FROM api_calls WHERE api_key_id = $1`,
        [key],
      );
      const by = Object.fromEntries(rows.map((r) => [r.idempotency_key, r]));
      expect(by[fresh]!.response_body).toEqual({ records: [] });
      expect(by[old]!.response_body).toBeNull();
      expect(by[week]!.response_body).toBeNull();
      for (const k of [fresh, old, week]) {
        expect(by[k]!.served_record_keys).toEqual([{ key: 'k1', hash: 'x' }]);
      }

      const replay = (idem: string) =>
        app.db.tx((tx) =>
          claimCall(tx, {
            buyerId: buyer,
            apiKeyId: key,
            channel: 'REST',
            datasetId: ds.datasetId,
            endpoint: 'records.search',
            idempotencyKey: idem,
            requestHash: 'h',
            isSimulated: false,
            simulatedAt: null,
          }),
        );
      await expect(replay(fresh)).resolves.toMatchObject({ kind: 'replay' });
      await expect(replay(old)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_EXPIRED' });
    });

    it('deletes record_versions older than 30 days and keeps newer ones', async () => {
      const ds = await seedDataset(app.db.pool, randomUUID().slice(0, 8));
      const record = (
        await app.db.pool.query<{ id: string }>(
          `INSERT INTO records (dataset_id, record_key, data, hash) VALUES ($1, 'k1', '{}', 'h') RETURNING id`,
          [ds.datasetId],
        )
      ).rows[0]!.id;
      const version = async (daysAgo: number, v: number) =>
        (
          await app.db.pool.query<{ seq: string }>(
            `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash, changed_at)
             VALUES ($1, $2, $3, 'update', '[]', 'h', now() - make_interval(days => $4)) RETURNING seq`,
            [ds.datasetId, record, v, daysAgo],
          )
        ).rows[0]!.seq;
      const old = await version(31, 1);
      const kept = await version(29, 2);

      const res = await retentionSweep(deps);
      expect(res.recordVersions).toBeGreaterThanOrEqual(1);
      const { rows } = await app.db.pool.query<{ seq: string }>(
        `SELECT seq FROM record_versions WHERE record_id = $1 ORDER BY seq`,
        [record],
      );
      expect(rows.map((r) => r.seq)).toEqual([kept]);
      expect(rows.map((r) => r.seq)).not.toContain(old);
    });
  });
});
