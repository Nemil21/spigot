// SP-036 acceptance on Postgres + FakePayPal + the real demo site (in-process, 5% scale):
// a freshly seeded DB with no LIVE dataset reaches LIVE by itself, then the simulated week lands
// with `created_at` set at insert (no UPDATE backdates anything, by statement log), every call
// after its buyer's top-up, all SIM; a non-SIM buyer can't pass `simulatedAt`; the ledger
// check passes; `--live` stops a buyer on 402.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createAccessLog } from '../apps/demo-site/src/accessLog.js';
import { createApp } from '../apps/demo-site/src/app.js';
import { openStore } from '../apps/demo-site/src/data/store.js';
import { authenticateKey } from '../apps/api/src/auth/apiKeys.js';
import { DEMO_BUYER, seedApiKey, seedDemo } from '../apps/api/src/cli/seedDemo.js';
import { loadConfig, type Config } from '../apps/api/src/config.js';
import { resetHostQueues } from '../apps/api/src/crawl/queue.js';
import { createDb, createPool, type Db } from '../apps/api/src/db/index.js';
import { testDatabaseUrl } from '../apps/api/src/db/test-db.js';
import { ledgerCheck } from '../apps/api/src/ledger/check.js';
import { FakePayPal } from '../apps/api/src/paypal/index.js';
import { createRecordedModel } from '../apps/api/src/schema-agent/claude.js';
import { REQUIRED_ENV } from '../apps/api/src/test/env.js';
import {
  buildCatalogue,
  ensureLive,
  findDemoSite,
  runLive,
  runWeek,
  simCall,
  soldDatasets,
  WEEK_MS,
  type DemoSite,
} from './sim-buyers.lib.js';

/** Every SQL text sent by any pg client in this process while `on`. */
function statementLog() {
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const original = proto.query;
  const texts: string[] = [];
  let on = false;
  proto.query = function (this: unknown, ...args: unknown[]) {
    if (on) {
      const q = args[0];
      const text = typeof q === 'string' ? q : (q as { text?: string } | null)?.text;
      if (text) texts.push(text);
    }
    return original.apply(this, args);
  };
  return {
    texts,
    start: () => {
      on = true;
    },
    stop: () => {
      on = false;
    },
    restore: () => {
      proto.query = original;
    },
  };
}

const WEEK_TARGET_MICROS = 40_000_000; // $40: the same code path as $500, a tenth of the calls

describe.skipIf(!testDatabaseUrl)('SP-036 sim:buyers (Postgres + FakePayPal + demo site)', () => {
  let tdb: TestDatabase;
  let pool: pg.Pool;
  let db: Db;
  let config: Config;
  let dataDir: string;
  let originServer: Server;
  let site: DemoSite;
  const sqlLog = statementLog();
  const lines: string[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    pool = createPool(tdb.url, { max: 8, applicationName: 'sim-buyers-test' });
    db = createDb(pool);
    dataDir = await mkdtemp(join(tmpdir(), 'spigot-sp036-'));
    const store = await openStore({ dataDir, scale: 0.05 });
    const demo = createApp({ store, accessLog: createAccessLog(() => {}) });
    originServer = createServer(demo);
    const origin = await new Promise<string>((resolve) =>
      originServer.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(originServer.address() as AddressInfo).port}`),
      ),
    );
    config = loadConfig({
      ...REQUIRED_ENV,
      DATABASE_URL: tdb.url,
      PAYPAL_MODE: 'stub',
      DEMO_SITE_URL: origin,
      ALLOW_LOCAL_ORIGINS: 'true',
      SCHEMA_AGENT_MODE: 'recorded',
    });
    const fake = new FakePayPal({ latencyMs: 1, jitterMs: 2 });
    await seedDemo({ db, config, pp: fake.client({ timeoutMs: 1_000 }) });
    site = await findDemoSite(db, config);
    resetHostQueues();
  }, 120_000);

  afterAll(async () => {
    sqlLog.restore();
    if (originServer) await new Promise<void>((r) => originServer.close(() => r()));
    await pool?.end();
    await tdb?.drop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('a freshly seeded DB has no LIVE dataset; ensureLive crawls, proposes and approves the Listing by itself', async () => {
    expect(site.status).toBe('VERIFIED');
    expect(await soldDatasets(db, site.id)).toHaveLength(0);

    const r = await ensureLive(
      { db, config, crawl: { minGapMs: 0 }, model: createRecordedModel() },
      site,
      (l) => lines.push(l),
    );
    expect(r.status).toBe('made_live');
    if (r.status !== 'made_live') return;
    expect(r.records).toBeGreaterThan(50);
    expect(lines.some((l) => l.includes('running the discovery crawl'))).toBe(true);
    expect(lines.some((l) => l.includes('approved the Listing proposal'))).toBe(true);

    const sold = await soldDatasets(db, site.id);
    expect(sold.map((s) => s.ds.typeName)).toEqual(['Listing']);
    // agent_phone is never served.
    expect(sold[0]!.ds.fields.map((f) => f.name)).not.toContain('agent_phone');
    const sv = await pool.query<{ fields: Array<{ name: string; visible?: boolean }> }>(
      'SELECT fields FROM schema_versions WHERE id = $1',
      [r.schemaVersionId],
    );
    expect(sv.rows[0]!.fields.find((f) => f.name === 'agent_phone')?.visible).toBe(false);
    const attested = await pool.query('SELECT rights_attested_at FROM sites WHERE id = $1', [
      site.id,
    ]);
    expect(attested.rows[0].rights_attested_at).not.toBeNull();

    // Second call: nothing to do.
    expect((await ensureLive({ db, config }, site)).status).toBe('already_live');
  }, 180_000);

  it('the week: ≈ target gross, all SIM, dated at insert after each top-up, no UPDATE backdating; ledger check passes', async () => {
    const now = new Date();
    sqlLog.start();
    const r = await runWeek({ db, config, baseUrl: config.APP_BASE_URL }, site, {
      targetMicros: WEEK_TARGET_MICROS,
      now,
      seed: 36,
    });
    sqlLog.stop();

    expect(r.calls).toBeGreaterThan(50);
    expect(r.stopped).toEqual([]);
    expect(r.afterMicros).toBeGreaterThanOrEqual(WEEK_TARGET_MICROS * 0.8);
    expect(r.afterMicros).toBeLessThanOrEqual(WEEK_TARGET_MICROS * 1.2);

    // Statement log: nothing UPDATEs the ledger tables, and no UPDATE of api_calls touches
    // created_at (the only api_calls UPDATE is chargeAndRecord's same-transaction status
    // transition RECEIVED → CHARGED; the timestamp is the INSERT's).
    const updates = sqlLog.texts.filter((t) => /^\s*UPDATE\s/i.test(t));
    expect(updates.filter((t) => /^\s*UPDATE\s+ledger_(txns|entries)\b/i.test(t))).toEqual([]);
    const callUpdates = updates.filter((t) => /^\s*UPDATE\s+api_calls\b/i.test(t));
    for (const t of callUpdates) expect(t).not.toMatch(/created_at/i);
    expect(sqlLog.texts.some((t) => /INSERT INTO api_calls/i.test(t))).toBe(true);

    // Every call (week rows) is SIM, inside the week, after its buyer's latest top-up, and its
    // CHARGE txn and entries carry the same instant.
    const { rows } = await pool.query<{
      is_simulated: boolean;
      created_at: Date;
      txn_at: Date;
      txn_sim: boolean;
      entries_at: Date[];
      funded_at: Date;
    }>(
      `SELECT c.is_simulated, c.created_at, t.created_at AS txn_at, t.is_simulated AS txn_sim,
              (SELECT array_agg(DISTINCT e.created_at) FROM ledger_entries e WHERE e.txn_id = t.id) AS entries_at,
              (SELECT max(tt.created_at) FROM ledger_txns tt
                 JOIN ledger_entries ee ON ee.txn_id = tt.id
                 JOIN ledger_accounts aa ON aa.id = ee.account_id
                WHERE tt.kind = 'TOPUP' AND aa.kind = 'BUYER_BALANCE' AND aa.owner_id = c.buyer_id) AS funded_at
         FROM api_calls c JOIN ledger_txns t ON t.id = c.charge_txn_id`,
    );
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) {
      expect(row.is_simulated).toBe(true);
      expect(row.txn_sim).toBe(true);
      expect(row.txn_at.getTime()).toBe(row.created_at.getTime());
      expect(row.entries_at.map((d) => d.getTime())).toEqual([row.created_at.getTime()]);
      expect(row.created_at.getTime()).toBeGreaterThan(row.funded_at.getTime());
      expect(row.created_at.getTime()).toBeGreaterThanOrEqual(now.getTime() - WEEK_MS);
      expect(row.created_at.getTime()).toBeLessThan(now.getTime());
    }
    // Spread over the week, not piled on one day.
    const days = new Set(rows.map((r) => r.created_at.toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(6);
    // Both kinds of call were bought.
    const kinds = await pool.query<{ endpoint: string }>(
      `SELECT DISTINCT endpoint FROM api_calls WHERE status = 'CHARGED' ORDER BY endpoint`,
    );
    expect(kinds.rows.map((k) => k.endpoint)).toEqual(['changes.list', 'records.search']);

    const check = await ledgerCheck(pool);
    expect(check.mismatches).toEqual([]);
  }, 180_000);

  it('a re-run tops the week up to the target instead of adding another week', async () => {
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM api_calls');
    const r = await runWeek({ db, config, baseUrl: config.APP_BASE_URL }, site, {
      targetMicros: WEEK_TARGET_MICROS,
      seed: 37,
    });
    const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM api_calls');
    expect(r.calls).toBe(0);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  }, 60_000);

  it('a non-SIM buyer passing simulatedAt is rejected, and nothing is stored', async () => {
    const acmeKey = await authenticateKey(
      pool,
      seedApiKey(config.SESSION_SECRET, DEMO_BUYER.email),
    );
    const sold = await soldDatasets(db, site.id);
    const [spec] = await buildCatalogue(db, sold);
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM api_calls');
    await expect(
      simCall(
        { db, baseUrl: config.APP_BASE_URL },
        { id: acmeKey.buyerId, apiKeyId: acmeKey.id },
        spec!,
        { simulatedAt: new Date(Date.now() - 3 * 86_400_000), idempotencyKey: 'acme-backdate' },
      ),
    ).rejects.toThrow(/simulatedAt is only allowed/);
    const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM api_calls');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    // And the database refuses a backdated non-SIM ledger row even if code tried.
    await expect(
      pool.query(
        `INSERT INTO ledger_txns (kind, idempotency_key, is_simulated, created_at)
         VALUES ('CHARGE', 'sp036-backdate', false, now() - interval '2 days')`,
      ),
    ).rejects.toThrow(/backdated only for is_simulated/);
  }, 60_000);

  it('--live makes calls dated now and stops a buyer on 402 (no SIM top-up)', async () => {
    // Leave one SIM buyer with less than any call costs: drain it with week calls first.
    const { rows: simBuyers } = await pool.query<{ id: string; email: string }>(
      `SELECT id, email FROM buyers WHERE is_simulated ORDER BY email`,
    );
    // Revoke every key but the first SIM buyer's, so --live only picks that buyer.
    await pool.query(`UPDATE api_keys SET revoked_at = now() WHERE buyer_id = ANY($1::uuid[])`, [
      simBuyers.slice(1).map((b) => b.id),
    ]);
    const only = simBuyers[0]!;
    const key = await authenticateKey(pool, seedApiKey(config.SESSION_SECRET, only.email));
    const sold = await soldDatasets(db, site.id);
    const catalogue = await buildCatalogue(db, sold);
    const priciest = [...catalogue].sort((a, b) => b.priceMicros - a.priceMicros)[0]!;
    // Spend it down with real SIM calls until a 402.
    for (let i = 0; i < 10_000; i++) {
      const { outcome } = await simCall(
        { db, baseUrl: config.APP_BASE_URL },
        { id: only.id, apiKeyId: key.id },
        priciest,
        { idempotencyKey: `drain-${i}` },
      );
      if (outcome === 'insufficient') break;
    }
    const t0 = Date.now();
    const out: string[] = [];
    const r = await runLive({ db, config, baseUrl: config.APP_BASE_URL }, site, {
      signal: new AbortController().signal,
      gapMs: [1, 2],
      maxCalls: 50,
      seed: 1,
      log: (l) => out.push(l),
    });
    // The buyer still has a few cents: cheap calls go through until a 402 stops it.
    expect(r.reason).toBe('all_stopped');
    expect(r.stopped).toHaveLength(1);
    expect(out.some((l) => l.includes('402 INSUFFICIENT_BALANCE; stopped'))).toBe(true);
    const live = await pool.query<{ created_at: Date; is_simulated: boolean }>(
      `SELECT created_at, is_simulated FROM api_calls WHERE idempotency_key LIKE 'sim-live:%'`,
    );
    for (const row of live.rows) {
      expect(row.is_simulated).toBe(true);
      expect(row.created_at.getTime()).toBeGreaterThanOrEqual(t0 - 1_000);
    }
    expect((await ledgerCheck(pool)).mismatches).toEqual([]);
  }, 120_000);
});
