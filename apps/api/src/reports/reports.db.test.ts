import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDb, type Db } from '../db/index.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { creditEntries, payoutSentEntries, topupEntries } from '../ledger/postings.js';
import { chargeAndRecord, type ChargeInput } from '../meter/charge.js';
import { cases as earningsCases } from '../security/tenancy/earnings.cases.js';
import { cases as usageCases } from '../security/tenancy/usage.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import type { Earnings } from './earnings.js';
import { LEDGER_BLOCK, type LedgerPage } from './ledgerRows.js';
import { USAGE_BLOCK, type CallDetail, type UsagePage } from './usage.js';

/**
 * SP-030a integration (ticket §Test plan): every money fixture is produced through
 * `chargeAndRecord` (plus a claim credit and a payout posted through `post()`), then read back
 * through the real routes with real sessions. KPIs are reconciled against `ledgerCheck`'s
 * per-publisher terms.
 */

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const UNIT = 1333; // not a multiple of 5: the 20% commission floors, so rounding is exercised
const DAY = 24 * 60 * 60 * 1000;

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface Publisher {
  id: string;
  cookie: string;
  datasetId: string;
  datasetKey: string;
}
interface Buyer {
  id: string;
  cookie: string | null;
  apiKeyId: string;
}

describe.skipIf(!testDatabaseUrl)(
  'SP-030a earnings, ledger and usage (Postgres)',
  { timeout: 120_000 },
  () => {
    let pools: TwoPools;
    let pool: pg.Pool;
    let db: Db;
    let app: FastifyInstance;

    const agent = () => request(app.server);
    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows as T[];

    async function newPublisher(datasetSlug = 'listings'): Promise<Publisher> {
      const res = await agent()
        .post('/api/auth/signup')
        .set('Origin', ORIGIN)
        .send({
          name: 'Bluebonnet',
          email: `p-${randomUUID()}@example.com`,
          password: 'correct horse',
          payoutEmail: 'payouts@example.com',
        });
      expect(res.status).toBe(201);
      const slug = `site-${randomUUID().slice(0, 8)}`;
      const [site] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash)
       VALUES ($1, $2, $3, 'v', $4, $5) RETURNING id`,
        [res.body.publisherId, `https://${slug}.example.com`, slug, `c-${slug}`, `g-${slug}`],
      );
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name) VALUES ($1, $2, 'Listing') RETURNING id`,
        [site!.id, datasetSlug],
      );
      return {
        id: res.body.publisherId,
        cookie: cookiesOf(res),
        datasetId: ds!.id,
        datasetKey: `${slug}/${datasetSlug}`,
      };
    }

    /** A buyer through signup (session cookie), or a SIM buyer row (no login), with a key and funds. */
    async function newBuyer(opts: { simulated?: boolean; name?: string } = {}): Promise<Buyer> {
      let id: string;
      let cookie: string | null = null;
      if (opts.simulated) {
        [{ id }] = (await q<{ id: string }>(
          `INSERT INTO buyers (name, is_simulated) VALUES ($1, true) RETURNING id`,
          [opts.name ?? 'Sim Agent'],
        )) as [{ id: string }];
      } else {
        const res = await agent()
          .post('/api/buyer/signup')
          .set('Origin', ORIGIN)
          .send({
            name: opts.name ?? 'Acme Agents',
            email: `b-${randomUUID()}@example.com`,
            password: 'correct horse',
          });
        expect(res.status).toBe(201);
        id = res.body.buyerId;
        cookie = cookiesOf(res);
      }
      const [key] = await q<{ id: string }>(
        `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'sk_spg_x', $2) RETURNING id`,
        [id, `hash-${randomUUID()}`],
      );
      return { id, cookie, apiKeyId: key!.id };
    }

    async function topUp(b: Buyer, micros: number) {
      await db.tx(async (tx) => {
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', b.id);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash }, micros),
        });
      });
    }

    function charge(
      b: Buyer,
      p: Publisher,
      count: number,
      over: Partial<ChargeInput> & { channel?: 'REST' | 'MCP' } = {},
    ) {
      const { channel = 'REST', ...rest } = over;
      const records = Array.from({ length: count }, (_, i) => ({ key: `listings/${i}` }));
      return chargeAndRecord(
        { db, buyerId: b.id, apiKeyId: b.apiKeyId, channel },
        {
          dataset: { id: p.datasetId },
          endpoint: 'records.search',
          idempotencyKey: randomUUID(),
          request: { count, n: randomUUID() },
          body: { records },
          servedKeys: records.map((r) => ({ key: r.key, hash: `h-${r.key}` })),
          unitPriceMicros: UNIT,
          count,
          isSimulated: false,
          ...rest,
        },
      );
    }

    /** Claim credit on one call (as SP-049 would post it): reverses `micros` of its split. */
    async function credit(p: Publisher, b: Buyer, callId: string, micros: number) {
      await db.tx(async (tx) => {
        const accounts = {
          buyer: await getOrCreateAccount(tx, 'BUYER_BALANCE', b.id),
          publisher: await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', p.id),
          platformRevenue: await getOrCreateAccount(tx, 'PLATFORM_REVENUE'),
        };
        await post(tx, {
          kind: 'CREDIT',
          idempotencyKey: `credit:${randomUUID()}`,
          refType: 'api_call',
          refId: callId,
          entries: creditEntries(accounts, micros, 2000),
        });
        await tx.query(
          `UPDATE api_calls SET credited_micros = credited_micros + $2 WHERE id = $1`,
          [callId, micros],
        );
      });
    }

    /** A payout item with a PayPal item id, and its PAYOUT_SENT txn. */
    async function payout(p: Publisher, micros: number, paypalItemId: string) {
      const [batch] = await q<{ id: string }>(
        `INSERT INTO payout_batches (trigger, status, paypal_batch_id) VALUES ('MANUAL_DEMO', 'PENDING', $1)
       RETURNING id`,
        [`PB-${randomUUID().slice(0, 8)}`],
      );
      const [item] = await q<{ id: string }>(
        `INSERT INTO payout_items (batch_id, publisher_id, receiver_email, paypal_item_id)
       VALUES ($1, $2, 'payouts@example.com', $3) RETURNING id`,
        [batch!.id, p.id, paypalItemId],
      );
      await db.tx(async (tx) => {
        const accounts = {
          publisher: await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', p.id),
          payoutsInFlight: await getOrCreateAccount(tx, 'PAYOUTS_IN_FLIGHT'),
        };
        await post(tx, {
          kind: 'PAYOUT_SENT',
          idempotencyKey: `payout_item:${item!.id}`,
          refType: 'payout_item',
          refId: item!.id,
          entries: payoutSentEntries(accounts, micros),
        });
      });
    }

    /** `ledgerCheck`'s per-publisher terms for `p` (same SQL shape as ledger/check.ts). */
    async function checkTerms(p: Publisher, includeSim = true) {
      const [r] = await q<{
        payable: number;
        charges: number;
        credits: number;
        sent: number;
        returned: number;
      }>(
        `SELECT coalesce(sum(e.amount_micros), 0)::bigint AS payable,
              coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'CHARGE'), 0)::bigint AS charges,
              coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'CREDIT'), 0)::bigint AS credits,
              coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'PAYOUT_SENT'), 0)::bigint AS sent,
              coalesce(sum(abs(e.amount_micros)) FILTER (WHERE t.kind = 'PAYOUT_RETURNED'), 0)::bigint AS returned
       FROM ledger_accounts a
       JOIN ledger_entries e ON e.account_id = a.id
       JOIN ledger_txns t ON t.id = e.txn_id
       WHERE a.kind = 'PUBLISHER_PAYABLE' AND a.owner_id = $1 AND ($2::bool OR NOT t.is_simulated)`,
        [p.id, includeSim],
      );
      return r!;
    }

    const getEarnings = (p: Publisher, query = '') =>
      agent().get(`/api/publishers/me/earnings${query}`).set('Cookie', p.cookie);
    const getLedger = (p: Publisher, query = '') =>
      agent().get(`/api/publishers/me/ledger${query}`).set('Cookie', p.cookie);
    const getUsage = (b: Buyer, query = '') =>
      agent().get(`/api/buyer/usage${query}`).set('Cookie', b.cookie!);

    // World: publisher A sells to a real buyer X (REST + MCP, a replay, a 402, a credit) and a SIM
    // buyer Y (backdated 3 days); A has been paid out once. Publisher B sells once to X.
    let A: Publisher;
    let B: Publisher;
    let X: Buyer;
    let Y: Buyer;
    let broke: Buyer;
    const xCalls: string[] = [];
    let simCallIds: string[] = [];
    let bCallId: string;
    let paymentRequiredCallId: string;
    const simAt = new Date(Date.now() - 3 * DAY);

    beforeAll(async () => {
      pools = await twoPools();
      pool = pools.a;
      db = createDb(pool);
      app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: pools.db.url }), {
        logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      });
      await app.ready();

      A = await newPublisher();
      B = await newPublisher();
      X = await newBuyer({ name: 'Acme Agents' });
      Y = await newBuyer({ simulated: true, name: 'Sim Agent' });
      broke = await newBuyer({ name: 'Broke Bot' });
      await topUp(X, 10_000_000);
      await topUp(Y, 10_000_000);

      for (const n of [3, 2, 1]) {
        const r = await charge(X, A, n);
        expect(r).toMatchObject({ status: 200, replay: false });
        xCalls.push(r.callId);
      }
      const mcp = await charge(X, A, 4, {
        channel: 'MCP',
        idempotencyKey: 'mcp-key-1',
        request: { m: 1 },
      });
      xCalls.push(mcp.callId);
      // A retry with the same key replays: no new row, no new charge.
      const replay = await charge(X, A, 4, {
        channel: 'MCP',
        idempotencyKey: 'mcp-key-1',
        request: { m: 1 },
      });
      expect(replay).toMatchObject({ replay: true, chargedMicros: 0, callId: mcp.callId });

      const sims = await Promise.all(
        [5, 7].map((n) => charge(Y, A, n, { isSimulated: true, simulatedAt: simAt })),
      );
      simCallIds = sims.map((s) => s.callId);

      const short = await charge(broke, A, 2);
      expect(short.status).toBe(402);
      paymentRequiredCallId = short.callId;

      await credit(A, X, xCalls[0]!, 2 * UNIT);
      await payout(A, 1_000, 'PAYPAL-ITEM-A1');

      bCallId = (await charge(X, B, 9)).callId;
    });
    afterAll(async () => {
      await app?.close();
      await pools?.close();
    });

    describe('GET /api/publishers/me/earnings', () => {
      it('KPIs reconcile with ledgerCheck per-publisher figures', async () => {
        const check = await ledgerCheck(pool);
        expect(check.mismatches).toEqual([]);

        const res = await getEarnings(A);
        expect(res.status).toBe(200);
        const { kpis } = res.body as Earnings;
        const terms = await checkTerms(A);

        // Net of charges = ledgerCheck's "charges (net)" term; payable = the account balance.
        expect(kpis.netMicros).toBe(terms.charges);
        expect(kpis.payableMicros).toBe(terms.payable);
        expect(kpis.payableMicros).toBe(
          terms.charges - terms.credits - terms.sent + terms.returned,
        );
        const [bal] = await q<{ b: number }>(
          `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = 'PUBLISHER_PAYABLE' AND owner_id = $1`,
          [A.id],
        );
        expect(kpis.payableMicros).toBe(bal!.b);

        // Gross is what buyers were charged for A's calls; commission is the rest.
        const counts = [3, 2, 1, 4, 5, 7];
        const gross = counts.reduce((s, n) => s + n * UNIT, 0);
        const [rev] = await q<{ c: number }>(
          `SELECT coalesce(sum(e.amount_micros), 0)::bigint AS c
         FROM api_calls c JOIN ledger_entries e ON e.txn_id = c.charge_txn_id
         JOIN ledger_accounts a ON a.id = e.account_id AND a.kind = 'PLATFORM_REVENUE'
         WHERE c.dataset_id = $1`,
          [A.datasetId],
        );
        expect(kpis).toMatchObject({
          grossMicros: gross,
          commissionMicros: rev!.c,
          netMicros: gross - rev!.c,
          calls: 6,
          recordsSold: 22,
          changesSold: 0,
          buyers: 2,
        });
        // Floor rounding happened per call (1333 × 20% is not whole), and was carried exactly.
        expect(kpis.commissionMicros).toBe(
          counts.reduce((s, n) => s + Math.floor((n * UNIT) / 5), 0),
        );
      });

      it('includeSim=false excludes SIM calls and SIM txns', async () => {
        const res = await getEarnings(A, '?includeSim=false');
        expect(res.status).toBe(200);
        const { kpis, rows } = res.body as Earnings;
        const terms = await checkTerms(A, false);
        expect(kpis).toMatchObject({
          grossMicros: (3 + 2 + 1 + 4) * UNIT,
          netMicros: terms.charges,
          payableMicros: terms.payable,
          calls: 4,
          recordsSold: 10,
          buyers: 1,
        });
        expect(rows.every((r) => !r.isSimulated)).toBe(true);
        expect(rows.map((r) => r.key)).toEqual(['Acme Agents']);

        const withSim = (await getEarnings(A, '?includeSim=true')).body as Earnings;
        expect(withSim.kpis.payableMicros - kpis.payableMicros).toBe(
          (await checkTerms(A)).charges - terms.charges,
        );
        expect(withSim.rows.some((r) => r.isSimulated)).toBe(true);
      });

      it('groups by buyer with channel split and SIM flag', async () => {
        const { rows } = (await getEarnings(A, '?groupBy=buyer')).body as Earnings;
        const acme = rows.find((r) => r.key === 'Acme Agents')!;
        expect(acme).toMatchObject({
          id: X.id,
          isSimulated: false,
          calls: 4,
          records: 10,
          grossMicros: 10 * UNIT,
          channels: {
            REST: { calls: 3, grossMicros: 6 * UNIT },
            MCP: { calls: 1, grossMicros: 4 * UNIT },
          },
        });
        expect(acme.commissionMicros + acme.netMicros).toBe(acme.grossMicros);
        const sim = rows.find((r) => r.key === 'Sim Agent')!;
        expect(sim).toMatchObject({ isSimulated: true, calls: 2, records: 12 });
        // Sorted by gross, descending.
        expect(rows[0]!.grossMicros).toBeGreaterThanOrEqual(rows[1]!.grossMicros);
      });

      it('groups by dataset (SIM and real rows apart) and by UTC day', async () => {
        const byDataset = ((await getEarnings(A, '?groupBy=dataset')).body as Earnings).rows;
        expect(byDataset.map((r) => [r.key, r.id, r.isSimulated, r.calls])).toEqual([
          [A.datasetKey, A.datasetId, true, 2],
          [A.datasetKey, A.datasetId, false, 4],
        ]);

        const byDay = ((await getEarnings(A, '?groupBy=day')).body as Earnings).rows;
        const simDay = simAt.toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        expect(byDay.map((r) => [r.key, r.isSimulated, r.calls])).toEqual([
          [simDay, true, 2],
          [today, false, 4],
        ]);
      });

      it('groups by several dimensions at once (W08: buyer,dataset,channel,day); rows sum to the KPIs', async () => {
        const { kpis, rows } = (await getEarnings(A, '?groupBy=buyer,dataset,channel,day'))
          .body as Earnings;
        const sum = (f: (r: Earnings['rows'][number]) => number) =>
          rows.reduce((t, r) => t + f(r), 0);
        expect(sum((r) => r.calls)).toBe(kpis.calls);
        expect(sum((r) => r.records)).toBe(kpis.recordsSold);
        expect(sum((r) => r.grossMicros)).toBe(kpis.grossMicros);
        expect(sum((r) => r.netMicros)).toBe(kpis.netMicros);

        const today = new Date().toISOString().slice(0, 10);
        const mcp = rows.find((r) => r.dims.channel === 'MCP')!;
        expect(mcp).toMatchObject({
          id: `${X.id}|${A.datasetId}|MCP|${today}`,
          key: `Acme Agents · ${A.datasetKey} · MCP · ${today}`,
          dims: {
            buyer: { id: X.id, name: 'Acme Agents' },
            dataset: { id: A.datasetId, key: A.datasetKey },
            channel: 'MCP',
            day: today,
          },
          isSimulated: false,
          calls: 1,
          records: 4,
          grossMicros: 4 * UNIT,
          channels: { REST: { calls: 0 }, MCP: { calls: 1, grossMicros: 4 * UNIT } },
        });
        expect(rows.filter((r) => r.isSimulated).map((r) => r.dims.buyer?.name)).toEqual([
          'Sim Agent',
        ]);

        // Day first reads as a time series; a single dimension keeps its old shape plus `dims`.
        const byDay = ((await getEarnings(A, '?groupBy=day,dataset')).body as Earnings).rows;
        expect(byDay.map((r) => r.dims.day)).toEqual([...byDay.map((r) => r.dims.day!)].sort());
        const byBuyer = ((await getEarnings(A, '?groupBy=buyer')).body as Earnings).rows;
        expect(byBuyer.find((r) => r.id === X.id)?.dims).toEqual({
          buyer: { id: X.id, name: 'Acme Agents' },
        });
      });

      it('from/to bound the calls by time; payable stays the current balance', async () => {
        const from = new Date(Date.now() - DAY).toISOString();
        const { kpis, rows } = (await getEarnings(A, `?from=${from}&groupBy=day`)).body as Earnings;
        expect(kpis.calls).toBe(4);
        expect(rows.every((r) => !r.isSimulated)).toBe(true);
        expect(kpis.payableMicros).toBe((await checkTerms(A)).payable);

        const to = new Date(Date.now() - DAY).toISOString();
        const old = (await getEarnings(A, `?to=${to}`)).body as Earnings;
        expect(old.kpis).toMatchObject({ calls: 2, buyers: 1, recordsSold: 12 });
      });

      it('rejects a bad query with 400 VALIDATION_ERROR', async () => {
        for (const qs of [
          '?groupBy=site',
          '?groupBy=buyer,buyer',
          '?groupBy=buyer,',
          '?groupBy=',
          '?includeSim=maybe',
          '?from=yesterday',
          '?from=1',
          '?from=2026-11-02&to=2026-11-01',
        ]) {
          const res = await getEarnings(A, qs);
          expect(res.status, qs).toBe(400);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });

      it('reads one snapshot: net = payable on every read while charges land concurrently', async () => {
        const R = await newPublisher();
        const buyer = await newBuyer({ name: 'Racer' });
        await topUp(buyer, 50_000_000);
        const dbB = createDb(pools.b); // a second "API process" posting charges
        const charges = Array.from({ length: 20 }, (_, i) =>
          chargeAndRecord(
            { db: dbB, buyerId: buyer.id, apiKeyId: buyer.apiKeyId, channel: 'REST' },
            {
              dataset: { id: R.datasetId },
              endpoint: 'records.search',
              idempotencyKey: `race-${i}`,
              request: { i },
              body: { i },
              servedKeys: [],
              unitPriceMicros: UNIT,
              count: 1 + (i % 3),
              isSimulated: false,
            },
          ),
        );
        const reads = Array.from({ length: 10 }, () => getEarnings(R));
        const [, results] = await Promise.all([Promise.all(charges), Promise.all(reads)]);
        for (const res of results) {
          const { kpis } = res.body as Earnings;
          expect(kpis.netMicros).toBe(kpis.payableMicros);
        }
        const final = ((await getEarnings(R)).body as Earnings).kpis;
        expect(final.calls).toBe(20);
        expect(final.netMicros).toBe((await checkTerms(R)).charges);
      });

      it('a publisher with no sales gets zeros, not an error', async () => {
        const empty = await newPublisher();
        const res = await getEarnings(empty);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          kpis: {
            grossMicros: 0,
            commissionMicros: 0,
            netMicros: 0,
            payableMicros: 0,
            calls: 0,
            recordsSold: 0,
            changesSold: 0,
            buyers: 0,
          },
          rows: [],
        });
      });
    });

    describe('GET /api/publishers/me/ledger', () => {
      it("lists the entries on the publisher's payable account, signed, with PayPal ids", async () => {
        const res = await getLedger(A);
        expect(res.status).toBe(200);
        const page = res.body as LedgerPage;
        expect(page.nextCursor).toBeNull();
        // 6 charges + 1 credit + 1 payout; the 402 and the replay posted nothing.
        expect(page.rows.map((r) => r.kind).sort()).toEqual(
          [
            'CHARGE',
            'CHARGE',
            'CHARGE',
            'CHARGE',
            'CHARGE',
            'CHARGE',
            'CREDIT',
            'PAYOUT_SENT',
          ].sort(),
        );
        // Newest entry first.
        const ids = page.rows.map((r) => BigInt(r.id));
        expect([...ids].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(ids);

        const sum = page.rows.reduce((s, r) => s + r.amountMicros, 0);
        expect(sum).toBe((await checkTerms(A)).payable);

        const paid = page.rows.find((r) => r.kind === 'PAYOUT_SENT')!;
        expect(paid).toMatchObject({
          amountMicros: -1_000,
          paypalId: 'PAYPAL-ITEM-A1',
          memo: 'PayPal payout sent',
          ref: { type: 'payout_item' },
        });
        expect(paid.paypalBatchId).toMatch(/^PB-/);

        const credited = page.rows.find((r) => r.kind === 'CREDIT')!;
        expect(credited.amountMicros).toBeLessThan(0);
        expect(credited.ref).toEqual({ type: 'api_call', id: xCalls[0] });

        const first = page.rows.find((r) => r.ref?.id === xCalls[0] && r.kind === 'CHARGE')!;
        expect(first).toMatchObject({
          memo: `3 records sold · ${A.datasetKey}`,
          paypalId: null,
          isSimulated: false,
        });
        expect(first.amountMicros).toBe(3 * UNIT - Math.floor((3 * UNIT) / 5));
      });

      it('includeSim=false drops SIM txns', async () => {
        const page = (await getLedger(A, '?includeSim=false')).body as LedgerPage;
        expect(page.rows).toHaveLength(6);
        expect(page.rows.some((r) => r.isSimulated || simCallIds.includes(r.ref?.id ?? ''))).toBe(
          false,
        );
      });

      it(`pages ${LEDGER_BLOCK} rows per block with a cursor, no gaps or repeats`, async () => {
        const P = await newPublisher();
        const buyer = await newBuyer({ name: 'Pager' });
        await topUp(buyer, 50_000_000);
        const total = LEDGER_BLOCK + 5;
        for (let i = 0; i < total; i++) await charge(buyer, P, 1);

        const first = (await getLedger(P)).body as LedgerPage;
        expect(first.rows).toHaveLength(LEDGER_BLOCK);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = (await getLedger(P, `?cursor=${first.nextCursor}`)).body as LedgerPage;
        expect(second.rows).toHaveLength(5);
        expect(second.nextCursor).toBeNull();
        const all = [...first.rows, ...second.rows].map((r) => r.id);
        expect(new Set(all).size).toBe(total);

        const bad = await getLedger(P, '?cursor=not-a-cursor');
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('GET /api/buyer/usage and /api/buyer/calls/:id', () => {
      it("lists the buyer's calls newest first: dataset, endpoint, records, charged, channel, replay flag", async () => {
        const res = await getUsage(X);
        expect(res.status).toBe(200);
        const page = res.body as UsagePage;
        // 4 calls on A + 1 on B; the replay did not add a row.
        expect(page.rows.map((r) => r.id).sort()).toEqual([...xCalls, bCallId].sort());
        const times = page.rows.map((r) => r.time);
        expect([...times].sort().reverse()).toEqual(times);

        const mcp = page.rows.find((r) => r.id === xCalls[3])!;
        expect(mcp).toMatchObject({
          endpoint: 'records.search',
          channel: 'MCP',
          status: 'CHARGED',
          records: 4,
          changes: null,
          chargedMicros: 4 * UNIT,
          creditedMicros: 0,
          replayable: true,
          isSimulated: false,
          dataset: { id: A.datasetId, slug: 'listings' },
        });
        const creditedRow = page.rows.find((r) => r.id === xCalls[0])!;
        expect(creditedRow.creditedMicros).toBe(2 * UNIT);
      });

      it('a 402 call shows with nothing charged and no replay', async () => {
        const page = (await getUsage(broke)).body as UsagePage;
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]).toMatchObject({
          id: paymentRequiredCallId,
          status: 'PAYMENT_REQUIRED',
          chargedMicros: 0,
          replayable: false,
        });
      });

      it('from/to filter by time', async () => {
        const future = new Date(Date.now() + DAY).toISOString();
        expect(((await getUsage(X, `?from=${future}`)).body as UsagePage).rows).toEqual([]);
        const past = new Date(Date.now() - DAY).toISOString();
        expect(((await getUsage(X, `?from=${past}`)).body as UsagePage).rows).toHaveLength(5);
        expect((await getUsage(X, '?to=garbage')).status).toBe(400);
      });

      it(`pages ${USAGE_BLOCK} rows per page with a cursor`, async () => {
        const P = await newPublisher();
        const buyer = await newBuyer({ name: 'Usage Pager' });
        await topUp(buyer, 50_000_000);
        for (let i = 0; i < USAGE_BLOCK + 3; i++) await charge(buyer, P, 1);
        const first = (await getUsage(buyer)).body as UsagePage;
        expect(first.rows).toHaveLength(USAGE_BLOCK);
        const second = (await getUsage(buyer, `?cursor=${first.nextCursor}`)).body as UsagePage;
        expect(second.rows).toHaveLength(3);
        expect(second.nextCursor).toBeNull();
        expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(
          USAGE_BLOCK + 3,
        );
        expect((await getUsage(buyer, '?cursor=eyJ4IjoxfQ')).status).toBe(400);
      });

      it('call detail carries the served record keys for claims', async () => {
        const res = await agent().get(`/api/buyer/calls/${xCalls[1]}`).set('Cookie', X.cookie!);
        expect(res.status).toBe(200);
        const call = res.body as CallDetail;
        expect(call).toMatchObject({
          id: xCalls[1],
          unitPriceMicros: UNIT,
          httpStatus: 200,
          chargedMicros: 2 * UNIT,
          servedRecords: [
            { key: 'listings/0', hash: 'h-listings/0' },
            { key: 'listings/1', hash: 'h-listings/1' },
          ],
        });
      });
    });

    describe('tenancy (earnings.cases.ts, usage.cases.ts)', () => {
      it('covers every SP-030a route', () => {
        expect(earningsCases.map((c) => `${c.method} ${c.url}`)).toEqual([
          'GET /api/publishers/me/earnings',
          'GET /api/publishers/me/ledger',
        ]);
        expect(usageCases.map((c) => `${c.method} ${c.url}`)).toEqual([
          'GET /api/buyer/usage',
          'GET /api/buyer/calls/:id',
        ]);
      });

      it("publisher B sees only B's earnings; ?publisherId=<A> is ignored", async () => {
        const res = await getEarnings(B, `?publisherId=${A.id}&groupBy=dataset`);
        expect(res.status).toBe(200);
        const { kpis, rows } = res.body as Earnings;
        expect(kpis).toMatchObject({ calls: 1, recordsSold: 9, grossMicros: 9 * UNIT, buyers: 1 });
        expect(kpis.payableMicros).toBe((await checkTerms(B)).payable);
        expect(rows.map((r) => r.id)).toEqual([B.datasetId]);
      });

      it("publisher A can't read B's ledger rows (nor B A's), even with the other's cursor", async () => {
        const aRows = ((await getLedger(A)).body as LedgerPage).rows;
        const bPage = (await getLedger(B, `?publisherId=${A.id}`)).body as LedgerPage;
        expect(bPage.rows).toHaveLength(1);
        expect(bPage.rows[0]).toMatchObject({
          kind: 'CHARGE',
          ref: { type: 'api_call', id: bCallId },
        });
        const aIds = new Set(aRows.map((r) => r.id));
        expect(bPage.rows.some((r) => aIds.has(r.id))).toBe(false);
        expect(aRows.some((r) => r.ref?.id === bCallId)).toBe(false);

        // A cursor positioned above all of A's entries, used by B, still yields only B's.
        const [max] = await q<{ m: string }>(`SELECT (max(id) + 1)::text AS m FROM ledger_entries`);
        const cursor = Buffer.from(JSON.stringify({ e: max!.m })).toString('base64url');
        const viaCursor = (await getLedger(B, `?cursor=${cursor}`)).body as LedgerPage;
        expect(viaCursor.rows.map((r) => r.id)).toEqual(bPage.rows.map((r) => r.id));
      });

      it("buyer usage is the caller's own; another buyer's call id is 404", async () => {
        const other = await newBuyer({ name: 'Other' });
        const res = await getUsage(other, `?buyerId=${X.id}`);
        expect(res.status).toBe(200);
        expect(res.body.rows).toEqual([]);

        const cross = await agent()
          .get(`/api/buyer/calls/${xCalls[0]}`)
          .set('Cookie', other.cookie!);
        expect(cross.status).toBe(404);
        expect(cross.body.error.code).toBe('NOT_FOUND');
        const notUuid = await agent().get('/api/buyer/calls/nope').set('Cookie', other.cookie!);
        expect(notUuid.status).toBe(404);
      });

      it('signed-out and wrong-role callers get 401', async () => {
        for (const url of [
          '/api/publishers/me/earnings',
          '/api/publishers/me/ledger',
          '/api/buyer/usage',
          `/api/buyer/calls/${xCalls[0]}`,
        ]) {
          const res = await agent().get(url);
          expect(res.status, url).toBe(401);
        }
        expect((await agent().get('/api/buyer/usage').set('Cookie', A.cookie)).status).toBe(401);
        expect(
          (await agent().get('/api/publishers/me/earnings').set('Cookie', X.cookie!)).status,
        ).toBe(401);
      });
    });
  },
);
