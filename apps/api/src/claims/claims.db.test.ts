import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { cases } from '../security/tenancy/claims.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/** `title` is required and visible; `agent_phone` is required but hidden (never claimable). */
const FIELDS = [
  { name: 'title', type: 'string', required: true, visible: true, filterable: [] },
  { name: 'price_usd', type: 'integer', visible: true, filterable: ['eq'] },
  { name: 'agent_phone', type: 'string', required: true, visible: false, filterable: [] },
];
const UNIT = 1_500;
const N = 40;

describe.skipIf(!testDatabaseUrl)(
  'SP-048a POST /v1/claims (Postgres)',
  { timeout: 120_000 },
  () => {
    let db: TestDatabase;
    let app: FastifyInstance;

    beforeAll(async () => {
      db = await createTestDatabase();
      app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: db.url }), {
        logger: false,
      });
      await app.ready();
    });
    afterAll(async () => {
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => app.rateLimiter.reset());

    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    async function topUp(buyerId: string, micros: number) {
      await app.db.tx(async (tx) => {
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', buyerId);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash }, micros),
        });
      });
    }

    async function newBuyer(balanceMicros = 5_000_000) {
      const [b] = await q<{ id: string }>(`INSERT INTO buyers (name) VALUES ($1) RETURNING id`, [
        `Buyer ${randomUUID().slice(0, 8)}`,
      ]);
      const k = await createKey(app.db.pool, b!.id, { scopes: ['read'] });
      if (balanceMicros) await topUp(b!.id, balanceMicros);
      return { buyerId: b!.id, key: k.key };
    }

    /**
     * One publisher / site / LIVE `listings` dataset of 40 records, served newest first (l-40 … l-1):
     * - l-3 is at version 2 with `title: null` (v1 had a title);
     * - l-11 … l-20 have `title: null` from version 1;
     * - l-5 and l-6 are byte-identical (same hash): l-6 is served first, so l-5 is the duplicate.
     * Then a buyer makes one paid 40-record call (60,000 µ$; abuse limit 6,000 µ$ = 4 credits).
     */
    async function world() {
      const tag = randomUUID().slice(0, 8);
      const [pub] = await q<{ id: string }>(
        `INSERT INTO publishers (name, email, payout_email) VALUES ($1, $2, $2) RETURNING id`,
        [`Pub ${tag}`, `pub-${tag}@example.com`],
      );
      const [s] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
       VALUES ($1, $2, $3, 'v', 'c', 'g', 'READY') RETURNING id`,
        [pub!.id, `https://${tag}.example.com`, `s-${tag}`],
      );
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count, price_per_record_micros)
       VALUES ($1, 'listings', 'Listing', 'LIVE', $2, $3) RETURNING id`,
        [s!.id, N, UNIT],
      );
      const [sv] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
       VALUES ($1, 1, 'APPROVED', $2, '{}', '{"from":"url"}', 'AI') RETURNING id`,
        [ds!.id, JSON.stringify(FIELDS)],
      );
      await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
      await q(
        `INSERT INTO records (dataset_id, record_key, data, hash, version, crawled_at, updated_at)
       SELECT $1, 'l-' || i,
              jsonb_build_object(
                'title', CASE WHEN i BETWEEN 11 AND 20 THEN NULL
                              WHEN i IN (5, 6) THEN 'Twin' ELSE 'Listing ' || i END,
                'price_usd', CASE WHEN i IN (5, 6) THEN 900 ELSE 1000 + i END,
                'agent_phone', NULL),
              CASE WHEN i IN (5, 6) THEN 'dup' ELSE md5(i::text) END,
              1, now(), timestamptz '2026-11-11T00:00:00Z' + i * interval '1 second'
         FROM generate_series(1, $2) i`,
        [ds!.id, N],
      );
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
       SELECT $1, r.id, 1, 'add', jsonb_build_array(jsonb_build_object('op','add','path','','value', r.data)), r.hash
         FROM records r WHERE r.dataset_id = $1`,
        [ds!.id],
      );
      // l-3 → v2: title dropped.
      await bumpL3(ds!.id, null, 'l3-v2', 2);
      await q(
        `UPDATE datasets SET published_seq = (SELECT max(seq) FROM record_versions WHERE dataset_id = $1) WHERE id = $1`,
        [ds!.id],
      );

      const buyer = await newBuyer();
      const path = `/v1/s-${tag}/datasets/listings`;
      const res = await get(`${path}/records?limit=${N}`, buyer.key);
      expect(res.status).toBe(200);
      const callId = res.headers['spigot-call-id'] as string;
      return { ...buyer, publisherId: pub!.id, datasetId: ds!.id, path, callId };
    }

    async function bumpL3(datasetId: string, title: string | null, hash: string, version: number) {
      const [r] = await q<{ id: string }>(
        `UPDATE records SET data = jsonb_set(data, '{title}', coalesce(to_jsonb($3::text), 'null'::jsonb)), hash = $4, version = $5
        WHERE dataset_id = $1 AND record_key = $2 RETURNING id`,
        [datasetId, 'l-3', title, hash, version],
      );
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
       VALUES ($1, $2, $3, 'update', $4, $5)`,
        [
          datasetId,
          r!.id,
          version,
          JSON.stringify([{ op: 'replace', path: '/title', value: title }]),
          hash,
        ],
      );
    }

    const get = (path: string, key: string) =>
      request(app.server).get(path).set('Authorization', `Bearer ${key}`);
    const claim = (key: string, body: Record<string, unknown>) =>
      request(app.server).post('/v1/claims').set('Authorization', `Bearer ${key}`).send(body);

    const bal = async (kind: 'BUYER_BALANCE' | 'PUBLISHER_PAYABLE', owner: string) =>
      (
        await q<{ b: number }>(
          `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = $1 AND owner_id = $2`,
          [kind, owner],
        )
      )[0]?.b ?? 0;
    const call = async (id: string) =>
      (
        await q<{ status: string; credited: number; price: number }>(
          `SELECT status, credited_micros AS credited, price_micros AS price FROM api_calls WHERE id = $1`,
          [id],
        )
      )[0]!;
    const creditTxns = async (callId: string) =>
      q<{ id: string; key: string }>(
        `SELECT t.id, t.idempotency_key AS key FROM claims c JOIN ledger_txns t ON t.ref_id = c.id
        WHERE c.api_call_id = $1 AND t.kind = 'CREDIT'`,
        [callId],
      );
    const expectLedgerClean = async () => {
      const r = await ledgerCheck(app.db.pool);
      expect(r.mismatches).toEqual([]);
      expect(r.sumMicros).toBe(0);
      const over = await q(`SELECT id FROM api_calls WHERE credited_micros > price_micros`);
      expect(over).toEqual([]);
    };

    // ── Acceptance ──────────────────────────────────────────────────────────────────────────────

    it('MISSING_FIELD and DUPLICATE → AUTO_CREDITED, CREDIT posted, publisher payable reduced', async () => {
      const w = await world();
      // After the call l-3 gets its title back: the check must use the version that was served.
      await bumpL3(w.datasetId, 'Listing 3 again', 'l3-v3', 3);
      const buyerBefore = await bal('BUYER_BALANCE', w.buyerId);
      const payableBefore = await bal('PUBLISHER_PAYABLE', w.publisherId);

      const mf = await claim(w.key, {
        callId: w.callId,
        recordKey: 'listings/l-3',
        reason: 'MISSING_FIELD',
      });
      expect(mf.status).toBe(200);
      expect(mf.body).toEqual({
        claimId: expect.any(String),
        status: 'AUTO_CREDITED',
        creditMicros: UNIT,
      });

      const dup = await claim(w.key, {
        callId: w.callId,
        recordKey: 'listings/l-5',
        reason: 'DUPLICATE',
      });
      expect(dup.body).toMatchObject({ status: 'AUTO_CREDITED', creditMicros: UNIT });

      // The first copy is the original; a present title is not missing; STALE waits for SP-048c.
      for (const [recordKey, reason] of [
        ['listings/l-6', 'DUPLICATE'],
        ['listings/l-7', 'MISSING_FIELD'],
        ['listings/l-8', 'STALE'],
      ]) {
        const r = await claim(w.key, { callId: w.callId, recordKey, reason, note: 'see site' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'OPEN', creditMicros: 0 });
      }

      expect(await bal('BUYER_BALANCE', w.buyerId)).toBe(buyerBefore + 2 * UNIT);
      // 20% commission: the publisher gave back 1,200 per credit.
      expect(await bal('PUBLISHER_PAYABLE', w.publisherId)).toBe(payableBefore - 2 * 1_200);
      expect(await call(w.callId)).toEqual({
        status: 'PARTIALLY_CREDITED',
        credited: 2 * UNIT,
        price: N * UNIT,
      });
      const txns = await creditTxns(w.callId);
      expect(txns.map((t) => t.key).sort()).toEqual(
        [`claim:${mf.body.claimId}`, `claim:${dup.body.claimId}`].sort(),
      );
      const [row] = await q<{
        status: string;
        decided_by: string;
        credit_micros: number;
        ledger_txn_id: string;
      }>(`SELECT status, decided_by, credit_micros, ledger_txn_id FROM claims WHERE id = $1`, [
        mf.body.claimId,
      ]);
      expect(row).toMatchObject({
        status: 'AUTO_CREDITED',
        decided_by: 'AUTO',
        credit_micros: UNIT,
      });
      expect(row!.ledger_txn_id).toBeTruthy();
      const audits = await q<{ entity_id: string }>(
        `SELECT entity_id FROM audit_events WHERE action = 'CLAIM_DECIDED' AND publisher_id = $1`,
        [w.publisherId],
      );
      expect(audits.map((a) => a.entity_id).sort()).toEqual(
        [mf.body.claimId, dup.body.claimId].sort(),
      );
      await expectLedgerClean();
    });

    it('a claim 3 days after the call (body purged) is checked from served_record_keys', async () => {
      const w = await world();
      await q(
        `UPDATE api_calls SET created_at = now() - interval '3 days', response_body = NULL WHERE id = $1`,
        [w.callId],
      );
      const r = await claim(w.key, {
        callId: w.callId,
        recordKey: 'listings/l-12',
        reason: 'MISSING_FIELD',
      });
      expect(r.body).toMatchObject({ status: 'AUTO_CREDITED', creditMicros: UNIT });
      await expectLedgerClean();
    });

    it('after a commission change, the credit reverses at the call’s snapshotted rate', async () => {
      const w = await world();
      await q(`UPDATE publishers SET commission_bps = 5000 WHERE id = $1`, [w.publisherId]);
      const r = await claim(w.key, {
        callId: w.callId,
        recordKey: 'listings/l-3',
        reason: 'MISSING_FIELD',
      });
      expect(r.body.status).toBe('AUTO_CREDITED');
      const entries = await q<{ kind: string; amount: number }>(
        `SELECT a.kind, e.amount_micros AS amount FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_txns t ON t.id = e.txn_id
        WHERE t.idempotency_key = $1 ORDER BY a.kind`,
        [`claim:${r.body.claimId}`],
      );
      expect(entries).toEqual([
        { kind: 'BUYER_BALANCE', amount: UNIT },
        { kind: 'PLATFORM_REVENUE', amount: -300 }, // 20% (snapshot), not 50%
        { kind: 'PUBLISHER_PAYABLE', amount: -1_200 },
      ]);
      await expectLedgerClean();
    });

    it('a record not in the call → 422; other ineligible claims are refused without a row', async () => {
      const w = await world();
      const bad = await claim(w.key, {
        callId: w.callId,
        recordKey: 'listings/l-999',
        reason: 'MISSING_FIELD',
      });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('CLAIM_NOT_ELIGIBLE');
      // A real record of the dataset that a 1-record call (l-40) didn't serve.
      const one = await get(`${w.path}/records/l-40`, w.key);
      const notServed = await claim(w.key, {
        callId: one.headers['spigot-call-id'],
        recordKey: 'listings/l-3',
        reason: 'MISSING_FIELD',
      });
      expect(notServed.status).toBe(422);
      // Wrong dataset prefix.
      const prefix = await claim(w.key, {
        callId: w.callId,
        recordKey: 'other/l-3',
        reason: 'MISSING_FIELD',
      });
      expect(prefix.status).toBe(422);
      // Older than 7 days.
      await q(`UPDATE api_calls SET created_at = now() - interval '8 days' WHERE id = $1`, [
        w.callId,
      ]);
      const old = await claim(w.key, {
        callId: w.callId,
        recordKey: 'listings/l-3',
        reason: 'MISSING_FIELD',
      });
      expect(old.status).toBe(422);
      // Unknown call, malformed body, no key.
      expect(
        (
          await claim(w.key, {
            callId: randomUUID(),
            recordKey: 'listings/l-3',
            reason: 'MISSING_FIELD',
          })
        ).status,
      ).toBe(404);
      expect(
        (await claim(w.key, { callId: w.callId, recordKey: 'listings/l-3', reason: 'NOPE' }))
          .status,
      ).toBe(400);
      expect((await request(app.server).post('/v1/claims').send({})).status).toBe(401);
      expect(await q(`SELECT id FROM claims WHERE buyer_id = $1`, [w.buyerId])).toEqual([]);
    });

    it('ledger check passes after a mix of claims across buyers', async () => {
      const a = await world();
      const b = await world();
      await Promise.all([
        claim(a.key, { callId: a.callId, recordKey: 'listings/l-3', reason: 'MISSING_FIELD' }),
        claim(a.key, { callId: a.callId, recordKey: 'listings/l-5', reason: 'DUPLICATE' }),
        claim(b.key, { callId: b.callId, recordKey: 'listings/l-11', reason: 'MISSING_FIELD' }),
        claim(b.key, { callId: b.callId, recordKey: 'listings/l-9', reason: 'WRONG_VALUE' }),
      ]);
      await expectLedgerClean();
    });

    // ── Race / idempotency ──────────────────────────────────────────────────────────────────────

    it('the same claim 10× in parallel → one claim, one CREDIT', async () => {
      const w = await world();
      const body = { callId: w.callId, recordKey: 'listings/l-3', reason: 'MISSING_FIELD' };
      const results = await Promise.all(Array.from({ length: 10 }, () => claim(w.key, body)));
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      const ids = new Set(results.map((r) => r.body.claimId));
      expect(ids.size).toBe(1);
      for (const r of results)
        expect(r.body).toMatchObject({ status: 'AUTO_CREDITED', creditMicros: UNIT });
      expect(await q(`SELECT id FROM claims WHERE api_call_id = $1`, [w.callId])).toHaveLength(1);
      expect(await creditTxns(w.callId)).toHaveLength(1);
      expect((await call(w.callId)).credited).toBe(UNIT);
      await expectLedgerClean();
    });

    it('10 different claims in parallel over the 10% limit → credits stop at the limit, the rest OPEN', async () => {
      const w = await world();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          claim(w.key, {
            callId: w.callId,
            recordKey: `listings/l-${11 + i}`,
            reason: 'MISSING_FIELD',
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      const statuses = results.map((r) => r.body.status as string);
      // 10% of 60,000 = 6,000 = exactly 4 credits.
      expect(statuses.filter((s) => s === 'AUTO_CREDITED')).toHaveLength(4);
      expect(statuses.filter((s) => s === 'OPEN')).toHaveLength(6);
      expect((await call(w.callId)).credited).toBe(4 * UNIT);
      expect(await creditTxns(w.callId)).toHaveLength(4);
      expect(
        await q(`SELECT id FROM claims WHERE api_call_id = $1 AND status = 'OPEN'`, [w.callId]),
      ).toHaveLength(6);
      await expectLedgerClean();
    });

    it('credits never push credited_micros above price_micros', async () => {
      const w = await world();
      // One-record calls on null-title records; the 40-record call keeps the abuse limit open.
      const full = await get(`${w.path}/records/l-13`, w.key);
      const nearlyFull = await get(`${w.path}/records/l-14`, w.key);
      const fullId = full.headers['spigot-call-id'] as string;
      const nearId = nearlyFull.headers['spigot-call-id'] as string;
      // Simulate an earlier partial credit: one more record's price would overshoot.
      await q(
        `UPDATE api_calls SET credited_micros = 1, status = 'PARTIALLY_CREDITED' WHERE id = $1`,
        [nearId],
      );

      const [a, b] = await Promise.all([
        claim(w.key, { callId: fullId, recordKey: 'listings/l-13', reason: 'MISSING_FIELD' }),
        claim(w.key, { callId: nearId, recordKey: 'listings/l-14', reason: 'MISSING_FIELD' }),
      ]);
      expect(a.body).toMatchObject({ status: 'AUTO_CREDITED', creditMicros: UNIT });
      expect(await call(fullId)).toEqual({ status: 'CREDITED', credited: UNIT, price: UNIT });
      expect(b.body).toMatchObject({ status: 'OPEN', creditMicros: 0 });
      expect(await call(nearId)).toEqual({
        status: 'PARTIALLY_CREDITED',
        credited: 1,
        price: UNIT,
      });
      expect(await creditTxns(nearId)).toEqual([]);
      await expectLedgerClean();
    });

    // ── Tenancy (security/tenancy/claims.cases.ts) ──────────────────────────────────────────────

    describe('tenancy', () => {
      it('every claims route has a tenancy case', () => {
        expect(cases.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /v1/claims']);
      });

      it("B claiming on A's callId → 404, no claim row, no CREDIT, A's call untouched", async () => {
        const a = await world();
        const b = await newBuyer();
        const before = await bal('BUYER_BALANCE', b.buyerId);
        const r = await claim(b.key, {
          callId: a.callId,
          recordKey: 'listings/l-3',
          reason: 'MISSING_FIELD',
          buyerId: a.buyerId,
        });
        expect(r.status).toBe(404);
        expect(await q(`SELECT id FROM claims WHERE api_call_id = $1`, [a.callId])).toEqual([]);
        expect(await call(a.callId)).toMatchObject({ status: 'CHARGED', credited: 0 });
        expect(await bal('BUYER_BALANCE', b.buyerId)).toBe(before);
      });
    });
  },
);
