/* eslint-disable @typescript-eslint/no-explicit-any -- untyped pg rows and caught errors in assertions */
// SP-002 schema tests: migrate a throwaway database and check the constraints from the
// ticket's acceptance criteria. Needs TEST_DATABASE_URL (see db/testing.mjs).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listMigrations, migrate } from '../migrate.mjs';
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from '../testing.mjs';

describe('migration runner: file names', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'spigot-migrations-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the real migrations directory is valid', async () => {
    const files = await listMigrations();
    expect(files[0]?.name).toBe('001_init.sql');
  });

  test('two files with the same number fail with a clear message, before connecting', async () => {
    await writeFile(path.join(dir, '001_init.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '002_sp049_refund_status.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '002_sp047_auto_topup.sql'), 'SELECT 1;');
    // A connection string that can't connect proves validation runs first.
    await expect(migrate({ dir, connectionString: 'postgres://nobody@127.0.0.1:1/none' })).rejects.toThrow(
      /duplicate migration number 002: "002_sp047_auto_topup.sql" and "002_sp049_refund_status.sql"/,
    );
  });

  test('a badly named file is refused', async () => {
    const bad = await mkdtemp(path.join(os.tmpdir(), 'spigot-migrations-'));
    try {
      await writeFile(path.join(bad, '3_oops.sql'), 'SELECT 1;');
      await expect(listMigrations(bad)).rejects.toThrow(/bad migration file name "3_oops.sql"/);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!testDatabaseUrl)('SP-002 schema', () => {
  let tdb: TestDatabase;
  let db: pg.Client;

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrate: false });
    db = new pg.Client({ connectionString: tdb.url });
    await db.connect();
    await migrate({ client: db });
  });

  afterAll(async () => {
    await db?.end();
    await tdb?.drop();
  });

  // --- helpers --------------------------------------------------------------

  const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T> =>
    (await db.query(sql, params)).rows[0] as T;

  /** Run `fn` in a transaction that is always rolled back, so tests stay independent. */
  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('BEGIN');
    try {
      return await fn();
    } finally {
      await db.query('ROLLBACK');
    }
  }

  /** Assert a statement fails with SQLSTATE `code` (and constraint), inside a savepoint. */
  async function rejects(sql: string, params: unknown[], code: string, constraint?: string) {
    await db.query('SAVEPOINT s');
    try {
      const err = await db.query(sql, params).then(
        () => null,
        (e: any) => e,
      );
      expect(err, `expected ${sql} to fail`).not.toBeNull();
      expect(err.code, err.message).toBe(code);
      if (constraint) expect(err.constraint).toBe(constraint);
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT s');
    }
  }

  async function publisher(extra: { is_demo?: boolean } = {}) {
    return one(
      `INSERT INTO publishers (name, email, payout_email, is_demo)
       VALUES ('Bluebonnet', $1, 'payouts@bluebonnet.example', $2) RETURNING *`,
      [`p-${Math.random()}@example.com`, extra.is_demo ?? false],
    );
  }
  async function site(publisherId: string) {
    return one(
      `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash)
       VALUES ($1, $2, 'tok', 'ck', 'gk') RETURNING *`,
      [publisherId, `https://s${Math.random().toString(36).slice(2)}.example`],
    );
  }
  const buyer = () => one(`INSERT INTO buyers (name, email) VALUES ('Acme', $1) RETURNING *`, [`b-${Math.random()}@x.io`]);
  const account = (kind: string, ownerId: string | null) =>
    one(`INSERT INTO ledger_accounts (kind, owner_id) VALUES ($1, $2) RETURNING *`, [kind, ownerId]);
  /** Platform accounts are singletons: get-or-create. */
  const platform = (kind: string) =>
    one(
      `INSERT INTO ledger_accounts (kind) VALUES ($1)
       ON CONFLICT ON CONSTRAINT ledger_accounts_kind_owner_key DO UPDATE SET kind = EXCLUDED.kind RETURNING *`,
      [kind],
    );
  const txn = (kind = 'TOPUP', extra: { is_simulated?: boolean; created_at?: string } = {}) =>
    one(
      `INSERT INTO ledger_txns (kind, idempotency_key, is_simulated, created_at)
       VALUES ($1, $2, $3, coalesce($4::timestamptz, now())) RETURNING *`,
      [kind, `k:${Math.random()}`, extra.is_simulated ?? false, extra.created_at ?? null],
    );
  const entry = (txnId: string, accountId: string, amount: number) =>
    db.query(`INSERT INTO ledger_entries (txn_id, account_id, amount_micros) VALUES ($1, $2, $3)`, [
      txnId,
      accountId,
      amount,
    ]);

  // --- migrations -----------------------------------------------------------

  test('migrating twice succeeds and applies nothing the second time', async () => {
    const again = await migrate({ client: db });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toContain('001_init.sql');
  });

  test('every table in data-model.md exists', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const t of [
      'publishers', 'sites', 'pages', 'snapshots', 'templates', 'datasets', 'schema_versions', 'records',
      'record_versions', 'crawl_runs', 'bot_hits', 'buyers', 'api_keys', 'topups', 'ledger_accounts',
      'ledger_txns', 'ledger_entries', 'api_calls', 'claims', 'balance_refunds', 'payout_batches',
      'payout_items', 'webhook_events', 'audit_events', 'job_ticks',
    ]) {
      expect(tables).toContain(t);
    }
  });

  // --- ledger ---------------------------------------------------------------

  test('an unbalanced ledger txn fails at COMMIT', async () => {
    const cash = await platform('PAYPAL_CASH');
    const b = await buyer();
    const bal = await account('BUYER_BALANCE', b.id);

    await db.query('BEGIN');
    const t = await txn();
    await entry(t.id, cash.id, -20_000_000);
    await entry(t.id, bal.id, 19_000_000); // the row inserts; the deferred check fires at COMMIT
    const err = await db.query('COMMIT').then(
      () => null,
      (e: any) => e,
    );
    expect(err?.code).toBe('23514');
    expect(err?.constraint).toBe('ledger_entries_balanced');
    expect((await one(`SELECT count(*)::int AS n FROM ledger_txns WHERE id = $1`, [t.id])).n).toBe(0);

    // A balanced txn commits.
    await db.query('BEGIN');
    const ok = await txn();
    await entry(ok.id, cash.id, -20_000_000);
    await entry(ok.id, bal.id, 20_000_000);
    await db.query('COMMIT');
    expect((await one(`SELECT count(*)::int AS n FROM ledger_entries WHERE txn_id = $1`, [ok.id])).n).toBe(2);
  });

  test('a negative BUYER_BALANCE fails; a negative PUBLISHER_PAYABLE succeeds', () =>
    inTx(async () => {
      const b = await buyer();
      const bal = await account('BUYER_BALANCE', b.id);
      await rejects(
        `UPDATE ledger_accounts SET balance_micros = -1 WHERE id = $1`,
        [bal.id],
        '23514',
        'ledger_accounts_buyer_balance_nonnegative',
      );
      const p = await publisher();
      const payable = await account('PUBLISHER_PAYABLE', p.id);
      const row = await one(`UPDATE ledger_accounts SET balance_micros = -500 WHERE id = $1 RETURNING *`, [payable.id]);
      expect(row.balance_micros).toBe('-500');
    }));

  test('one platform account per kind (NULLS NOT DISTINCT), one owner account per kind', () =>
    inTx(async () => {
      await platform('PLATFORM_REVENUE');
      await rejects(
        `INSERT INTO ledger_accounts (kind, owner_id) VALUES ('PLATFORM_REVENUE', NULL)`,
        [],
        '23505',
        'ledger_accounts_kind_owner_key',
      );
      const b = await buyer();
      await account('BUYER_BALANCE', b.id);
      await rejects(`INSERT INTO ledger_accounts (kind, owner_id) VALUES ('BUYER_BALANCE', $1)`, [b.id], '23505');
      await rejects(`INSERT INTO ledger_accounts (kind, owner_id) VALUES ('BUYER_BALANCE', NULL)`, [], '23514');
    }));

  test('a zero ledger entry is rejected', () =>
    inTx(async () => {
      const cash = await platform('PAYPAL_CASH');
      const t = await txn();
      await rejects(
        `INSERT INTO ledger_entries (txn_id, account_id, amount_micros) VALUES ($1, $2, 0)`,
        [t.id, cash.id],
        '23514',
        'ledger_entries_amount_nonzero',
      );
    }));

  test('DEMO_RESET and REFUND_REVERSAL ledger kinds are accepted; an unknown kind is not', () =>
    inTx(async () => {
      expect((await txn('DEMO_RESET')).kind).toBe('DEMO_RESET');
      expect((await txn('REFUND_REVERSAL')).kind).toBe('REFUND_REVERSAL');
      await rejects(`INSERT INTO ledger_txns (kind, idempotency_key) VALUES ('BOGUS', 'x')`, [], '23514');
    }));

  test('ledger_txns.idempotency_key is unique', () =>
    inTx(async () => {
      await db.query(`INSERT INTO ledger_txns (kind, idempotency_key) VALUES ('CHARGE', 'charge:1')`);
      await rejects(`INSERT INTO ledger_txns (kind, idempotency_key) VALUES ('CHARGE', 'charge:1')`, [], '23505');
    }));

  test('a non-simulated backdated ledger txn is rejected; a simulated one is accepted', () =>
    inTx(async () => {
      const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
      await rejects(
        `INSERT INTO ledger_txns (kind, idempotency_key, is_simulated, created_at) VALUES ('CHARGE', 'bd:1', false, $1)`,
        [week],
        '23514',
        'ledger_txns_no_backdate',
      );
      const sim = await txn('CHARGE', { is_simulated: true, created_at: week });
      expect(new Date(sim.created_at).toISOString()).toBe(week);

      // Entries follow their txn: backdated entries only on a simulated txn.
      const cash = await platform('PAYPAL_CASH');
      await db.query(`INSERT INTO ledger_entries (txn_id, account_id, amount_micros, created_at) VALUES ($1, $2, 5, $3)`, [
        sim.id,
        cash.id,
        week,
      ]);
      const real = await txn('CHARGE');
      await rejects(
        `INSERT INTO ledger_entries (txn_id, account_id, amount_micros, created_at) VALUES ($1, $2, 5, $3)`,
        [real.id, cash.id, week],
        '23514',
        'ledger_entries_no_backdate',
      );
      // Within the 5-minute window is fine.
      const recent = new Date(Date.now() - 60_000).toISOString();
      await txn('CHARGE', { created_at: recent });
    }));

  // --- append-only ----------------------------------------------------------

  test('UPDATE / DELETE / TRUNCATE on ledger_entries and audit_events fail', async () => {
    const cash = await platform('PAYPAL_CASH');
    const rev = await platform('PLATFORM_REVENUE');
    await db.query('BEGIN');
    const t = await txn('CHARGE');
    await entry(t.id, cash.id, -1);
    await entry(t.id, rev.id, 1);
    await db.query('COMMIT');
    await db.query(`INSERT INTO audit_events (actor_type, action) VALUES ('SYSTEM', 'TEST')`);

    await inTx(async () => {
      await rejects(`UPDATE ledger_entries SET amount_micros = 2 WHERE txn_id = $1`, [t.id], '42501');
      await rejects(`DELETE FROM ledger_entries WHERE txn_id = $1`, [t.id], '42501');
      await rejects(`TRUNCATE ledger_entries CASCADE`, [], '42501');
      await rejects(`UPDATE audit_events SET action = 'X'`, [], '42501');
      await rejects(`DELETE FROM audit_events`, [], '42501');
      await rejects(`TRUNCATE audit_events`, [], '42501');
    });

    // PUBLIC has no UPDATE / DELETE grant on them.
    const { rows } = await db.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_name IN ('ledger_entries', 'audit_events')
          AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')`,
    );
    expect(rows).toEqual([]);
  });

  // --- crawl runs -----------------------------------------------------------

  test('a second live crawl run for a site fails; an APPROVE run may overlap', () =>
    inTx(async () => {
      const s = await site((await publisher()).id);
      const first = await one(`INSERT INTO crawl_runs (site_id, trigger) VALUES ($1, 'MANUAL') RETURNING *`, [s.id]);
      await rejects(
        `INSERT INTO crawl_runs (site_id, trigger) VALUES ($1, 'SCHEDULE')`,
        [s.id],
        '23505',
        'crawl_runs_one_live_per_site',
      );
      await rejects(
        `INSERT INTO crawl_runs (site_id, trigger, status) VALUES ($1, 'PING', 'RUNNING')`,
        [s.id],
        '23505',
        'crawl_runs_one_live_per_site',
      );
      await db.query(`INSERT INTO crawl_runs (site_id, trigger) VALUES ($1, 'APPROVE')`, [s.id]);
      await db.query(`UPDATE crawl_runs SET status = 'SUCCEEDED' WHERE id = $1`, [first.id]);
      await db.query(`INSERT INTO crawl_runs (site_id, trigger) VALUES ($1, 'MANUAL')`, [s.id]);
    }));

  // --- paid calls -----------------------------------------------------------

  test('a duplicate (api_key_id, idempotency_key) fails', () =>
    inTx(async () => {
      const b = await buyer();
      const key = await one(
        `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'sk_spg_a', $2) RETURNING *`,
        [b.id, `h${Math.random()}`],
      );
      const insert = `INSERT INTO api_calls (buyer_id, api_key_id, channel, idempotency_key, commission_bps, served_record_keys)
                      VALUES ($1, $2, 'REST', 'idem-1', 2000, '[]')`;
      await db.query(insert, [b.id, key.id]);
      await rejects(insert, [b.id, key.id], '23505', 'api_calls_api_key_id_idempotency_key_key');
    }));

  test('claims: one per record per call', () =>
    inTx(async () => {
      const s = await site((await publisher()).id);
      const ds = await one(`INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'listings', 'Listing') RETURNING *`, [s.id]);
      const rec = await one(
        `INSERT INTO records (dataset_id, record_key, data, hash) VALUES ($1, 'k1', '{}', 'h') RETURNING *`,
        [ds.id],
      );
      const b = await buyer();
      const key = await one(`INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'p', $2) RETURNING *`, [
        b.id,
        `h${Math.random()}`,
      ]);
      const call = await one(
        `INSERT INTO api_calls (buyer_id, api_key_id, channel, idempotency_key) VALUES ($1, $2, 'MCP', 'i') RETURNING *`,
        [b.id, key.id],
      );
      const insert = `INSERT INTO claims (api_call_id, record_id, buyer_id, reason) VALUES ($1, $2, $3, 'STALE')`;
      await db.query(insert, [call.id, rec.id, b.id]);
      await rejects(insert, [call.id, rec.id, b.id], '23505');
    }));

  // --- top-ups, refunds, payouts -------------------------------------------

  test('topups: amount range, PayPal ids unique, idempotency per buyer, REFUNDED status', () =>
    inTx(async () => {
      const b = await buyer();
      await rejects(`INSERT INTO topups (buyer_id, amount_cents) VALUES ($1, 499)`, [b.id], '23514');
      await rejects(`INSERT INTO topups (buyer_id, amount_cents) VALUES ($1, 50001)`, [b.id], '23514');
      const t = await one(
        `INSERT INTO topups (buyer_id, amount_cents, idempotency_key, paypal_order_id, status, needs_reconcile)
         VALUES ($1, 2000, 'k', 'ORDER1', 'REFUNDED', true) RETURNING *`,
        [b.id],
      );
      expect(t.status).toBe('REFUNDED');
      await rejects(`INSERT INTO topups (buyer_id, amount_cents, idempotency_key) VALUES ($1, 2000, 'k')`, [b.id], '23505');
      await rejects(`INSERT INTO topups (buyer_id, amount_cents, paypal_order_id) VALUES ($1, 2000, 'ORDER1')`, [b.id], '23505');
      const b2 = await buyer();
      await db.query(`INSERT INTO topups (buyer_id, amount_cents, idempotency_key) VALUES ($1, 2000, 'k')`, [b2.id]);
    }));

  test('balance_refunds: PENDING status and idempotency per buyer', () =>
    inTx(async () => {
      const b = await buyer();
      const t = await one(`INSERT INTO topups (buyer_id, amount_cents) VALUES ($1, 2000) RETURNING *`, [b.id]);
      const insert = `INSERT INTO balance_refunds (buyer_id, topup_id, amount_cents, status, idempotency_key, error_code)
                      VALUES ($1, $2, 740, 'PENDING', 'r1', NULL)`;
      await db.query(insert, [b.id, t.id]);
      await rejects(insert, [b.id, t.id], '23505');
    }));

  test('payout_batches: one SCHEDULE batch per period_end, any number of MANUAL_DEMO', () =>
    inTx(async () => {
      const end = '2026-11-16T00:00:00Z';
      await db.query(`INSERT INTO payout_batches (trigger, period_end) VALUES ('SCHEDULE', $1)`, [end]);
      await rejects(
        `INSERT INTO payout_batches (trigger, period_end) VALUES ('SCHEDULE', $1)`,
        [end],
        '23505',
        'payout_batches_one_schedule_per_period',
      );
      await db.query(`INSERT INTO payout_batches (trigger, period_end) VALUES ('MANUAL_DEMO', $1)`, [end]);
      await db.query(`INSERT INTO payout_batches (trigger, period_end) VALUES ('MANUAL_DEMO', $1)`, [end]);
    }));

  // --- datasets, records, bot hits -----------------------------------------

  test('datasets: price range and published_seq default', () =>
    inTx(async () => {
      const s = await site((await publisher()).id);
      const ds = await one(`INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'a', 'A') RETURNING *`, [s.id]);
      expect(ds.published_seq).toBe('0');
      expect(ds.price_per_record_micros).toBe('1500');
      await rejects(
        `INSERT INTO datasets (site_id, slug, type_name, price_per_record_micros) VALUES ($1, 'b', 'B', 99)`,
        [s.id],
        '23514',
      );
      await rejects(
        `INSERT INTO datasets (site_id, slug, type_name, price_per_record_micros) VALUES ($1, 'c', 'C', 100001)`,
        [s.id],
        '23514',
      );
      await rejects(`INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'a', 'A2')`, [s.id], '23505');
    }));

  test('records.updated_at is not touched by a trigger; other tables are', () =>
    inTx(async () => {
      const p = await publisher();
      const s = await site(p.id);
      const ds = await one(`INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'r', 'R') RETURNING *`, [s.id]);
      const old = '2026-01-01T00:00:00Z';
      const r = await one(
        `INSERT INTO records (dataset_id, record_key, data, hash, updated_at) VALUES ($1, 'k', '{}', 'h', $2) RETURNING *`,
        [ds.id, old],
      );
      const refreshed = await one(`UPDATE records SET crawled_at = now() WHERE id = $1 RETURNING updated_at`, [r.id]);
      expect(new Date(refreshed.updated_at).toISOString()).toBe(new Date(old).toISOString());
      await rejects(`INSERT INTO records (dataset_id, record_key, data, hash) VALUES ($1, 'k', '{}', 'h2')`, [ds.id], '23505');

      await db.query(`UPDATE publishers SET updated_at = $2 WHERE id = $1`, [p.id, old]);
      const touched = await one(`SELECT updated_at FROM publishers WHERE id = $1`, [p.id]);
      expect(new Date(touched.updated_at).getTime()).toBeGreaterThan(new Date(old).getTime());
    }));

  test('record_versions.seq is a global bigserial', () =>
    inTx(async () => {
      const s = await site((await publisher()).id);
      const ds = await one(`INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, 'v', 'V') RETURNING *`, [s.id]);
      const r = await one(`INSERT INTO records (dataset_id, record_key, data, hash) VALUES ($1, 'k', '{}', 'h') RETURNING *`, [ds.id]);
      const a = await one(`INSERT INTO record_versions (dataset_id, record_id, version, op) VALUES ($1, $2, 1, 'add') RETURNING seq`, [ds.id, r.id]);
      const b = await one(`INSERT INTO record_versions (dataset_id, record_id, version, op) VALUES ($1, $2, 2, 'update') RETURNING seq`, [ds.id, r.id]);
      expect(Number(b.seq)).toBeGreaterThan(Number(a.seq));
      await rejects(`INSERT INTO record_versions (dataset_id, record_id, version, op) VALUES ($1, $2, 3, 'upsert')`, [ds.id, r.id], '23514');
    }));

  test('bot_hits upserts on its composite primary key', () =>
    inTx(async () => {
      const s = await site((await publisher()).id);
      const upsert = `INSERT INTO bot_hits (site_id, bucket, category, bot_name, decision, hits, bytes)
                      VALUES ($1, '2026-11-12T06:00:00Z', 'AI_TRAINING', 'GPTBot', 'QUOTE_402', 3, 100)
                      ON CONFLICT (site_id, bucket, category, bot_name, decision, is_simulated)
                      DO UPDATE SET hits = bot_hits.hits + EXCLUDED.hits, bytes = bot_hits.bytes + EXCLUDED.bytes
                      RETURNING hits, bytes`;
      await db.query(upsert, [s.id]);
      const row = await one(upsert, [s.id]);
      expect(row.hits).toBe(6);
    }));

  test('status columns reject values outside their state machine', () =>
    inTx(async () => {
      const p = await publisher();
      await rejects(
        `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
         VALUES ($1, 'https://x.example', 't', 'c', 'g', 'LIVE')`,
        [p.id],
        '23514',
      );
      const s = await site(p.id);
      await rejects(`INSERT INTO crawl_runs (site_id, trigger, status) VALUES ($1, 'MANUAL', 'DONE')`, [s.id], '23514');
    }));
});
