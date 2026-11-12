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
import { cases } from '../security/tenancy/buyer-claims.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-050: W12's "Report a bad record" and claims list go through the buyer session, into the same
 * `createClaim` as `POST /v1/claims` (SP-048a).
 */
const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const FIELDS = [
  { name: 'title', type: 'string', required: true, visible: true, filterable: [] },
  { name: 'price_usd', type: 'integer', visible: true, filterable: ['eq'] },
];
const UNIT = 1_500;
const N = 20; // 30,000 µ$ charged → a 3,000 µ$ abuse-limit allowance (2 credits)

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

describe.skipIf(!testDatabaseUrl)(
  'SP-050 buyer-session claims (Postgres)',
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

    const agent = () => request(app.server);
    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    async function newBuyer() {
      const res = await agent()
        .post('/api/buyer/signup')
        .set('Origin', ORIGIN)
        .send({ name: 'Acme', email: `b-${randomUUID()}@example.com`, password: 'correct horse' });
      expect(res.status).toBe(201);
      const id = res.body.buyerId as string;
      await app.db.tx(async (tx) => {
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', id);
        const { paypalCash } = await platformAccounts(tx);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash }, 5_000_000),
        });
      });
      const k = await createKey(app.db.pool, id, { scopes: ['read'] });
      return { id, cookie: cookiesOf(res), key: k.key };
    }

    /** A LIVE `listings` dataset of 20 records; l-2 has a null required `title`. */
    async function world() {
      const tag = randomUUID().slice(0, 8);
      // Signed up (not inserted) so the publisher has a session for the W08 claims tab routes.
      const email = `pub-${tag}@example.com`;
      const signup = await agent()
        .post('/api/auth/signup')
        .set('Origin', ORIGIN)
        .send({ name: `Pub ${tag}`, email, password: 'correct horse', payoutEmail: email });
      expect(signup.status).toBe(201);
      const [pub] = await q<{ id: string }>(`SELECT id FROM publishers WHERE email = $1`, [email]);
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
                jsonb_build_object('title', CASE WHEN i = 2 THEN NULL ELSE 'Listing ' || i END,
                                   'price_usd', 1000 + i),
                md5(i::text), 1, now(), timestamptz '2026-11-11T00:00:00Z' + i * interval '1 second'
           FROM generate_series(1, $2) i`,
        [ds!.id, N],
      );
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
         SELECT $1, r.id, 1, 'add', jsonb_build_array(jsonb_build_object('op','add','path','','value', r.data)), r.hash
           FROM records r WHERE r.dataset_id = $1`,
        [ds!.id],
      );
      await q(
        `UPDATE datasets SET published_seq = (SELECT max(seq) FROM record_versions WHERE dataset_id = $1) WHERE id = $1`,
        [ds!.id],
      );
      const buyer = await newBuyer();
      const res = await agent()
        .get(`/v1/s-${tag}/datasets/listings/records?limit=${N}`)
        .set('Authorization', `Bearer ${buyer.key}`);
      expect(res.status).toBe(200);
      return {
        buyer,
        publisherId: pub!.id,
        publisherCookie: cookiesOf(signup),
        callId: res.headers['spigot-call-id'] as string,
      };
    }

    const fileClaim = (cookie: string, body: Record<string, unknown>) =>
      agent().post('/api/buyer/claims').set('Origin', ORIGIN).set('Cookie', cookie).send(body);
    const listClaims = (cookie: string, query = '') =>
      agent().get(`/api/buyer/claims${query}`).set('Cookie', cookie);
    const expectLedgerClean = async () => {
      const r = await ledgerCheck(app.db.pool);
      expect(r.mismatches).toEqual([]);
      expect(r.sumMicros).toBe(0);
    };

    it('needs a buyer session', async () => {
      expect((await agent().get('/api/buyer/claims')).status).toBe(401);
      expect((await agent().post('/api/buyer/claims').set('Origin', ORIGIN).send({})).status).toBe(
        401,
      );
    });

    it('MISSING_FIELD is auto-credited; WRONG_VALUE waits for the publisher; both are listed', async () => {
      const w = await world();
      const credited = await fileClaim(w.buyer.cookie, {
        callId: w.callId,
        recordKey: 'listings/l-2',
        reason: 'MISSING_FIELD',
        note: 'No title',
      });
      expect(credited.status).toBe(200);
      expect(credited.body).toMatchObject({ status: 'AUTO_CREDITED', creditMicros: UNIT });

      const open = await fileClaim(w.buyer.cookie, {
        callId: w.callId,
        recordKey: 'listings/l-4',
        reason: 'WRONG_VALUE',
        note: 'Rent is $1,950 on the site',
      });
      expect(open.status).toBe(200);
      expect(open.body).toMatchObject({ status: 'OPEN', creditMicros: 0 });

      const list = await listClaims(w.buyer.cookie);
      expect(list.status).toBe(200);
      expect(list.body.claims).toHaveLength(2);
      const [newest, oldest] = list.body.claims;
      expect(newest).toMatchObject({
        id: open.body.claimId,
        status: 'OPEN',
        reason: 'WRONG_VALUE',
        callId: w.callId,
        dataset: 'listings',
        recordKey: 'listings/l-4',
        amountMicros: UNIT,
        creditMicros: 0,
        decidedBy: null,
      });
      expect(oldest).toMatchObject({
        id: credited.body.claimId,
        status: 'AUTO_CREDITED',
        creditMicros: UNIT,
        decidedBy: 'AUTO',
        note: 'No title',
      });
      await expectLedgerClean();
    });

    it('a record not in the call → 422 CLAIM_NOT_ELIGIBLE; bad body → 400', async () => {
      const w = await world();
      const res = await fileClaim(w.buyer.cookie, {
        callId: w.callId,
        recordKey: 'listings/l-99',
        reason: 'STALE',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CLAIM_NOT_ELIGIBLE');
      const bad = await fileClaim(w.buyer.cookie, { callId: 'nope', reason: 'STALE' });
      expect(bad.status).toBe(400);
    });

    it('the same claim sent 8× in parallel (double clicks) → one claim, one CREDIT', async () => {
      const w = await world();
      const body = { callId: w.callId, recordKey: 'listings/l-2', reason: 'MISSING_FIELD' };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => fileClaim(w.buyer.cookie, body)),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(new Set(results.map((r) => r.body.claimId)).size).toBe(1);
      expect(results.every((r) => r.body.status === 'AUTO_CREDITED')).toBe(true);
      const credits = await q(
        `SELECT t.id FROM claims c JOIN ledger_txns t ON t.ref_id = c.id
          WHERE c.api_call_id = $1 AND t.kind = 'CREDIT'`,
        [w.callId],
      );
      expect(credits).toHaveLength(1);
      const [call] = await q<{ credited: number }>(
        `SELECT credited_micros AS credited FROM api_calls WHERE id = $1`,
        [w.callId],
      );
      expect(call!.credited).toBe(UNIT);
      await expectLedgerClean();
    });

    it('W12 → W08 loop: an OPEN claim reaches the publisher; Credit shows up in the buyer list', async () => {
      const w = await world();
      const filed = await fileClaim(w.buyer.cookie, {
        callId: w.callId,
        recordKey: 'listings/l-7',
        reason: 'WRONG_VALUE',
        note: 'Rent is different on the site',
      });
      expect(filed.body).toMatchObject({ status: 'OPEN', creditMicros: 0 });

      // SP-048b's routes, as the W08 claims tab calls them.
      const open = await agent().get('/api/claims?status=OPEN').set('Cookie', w.publisherCookie);
      expect(open.status).toBe(200);
      expect(open.body.claims).toEqual([
        expect.objectContaining({
          id: filed.body.claimId,
          recordKey: 'listings/l-7',
          reason: 'WRONG_VALUE',
          amountMicros: UNIT,
        }),
      ]);
      const decided = await agent()
        .post(`/api/claims/${filed.body.claimId}/decide`)
        .set('Origin', ORIGIN)
        .set('Cookie', w.publisherCookie)
        .send({ decision: 'CREDIT' });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ status: 'CREDITED', creditMicros: UNIT });

      const [mine] = (await listClaims(w.buyer.cookie)).body.claims;
      expect(mine).toMatchObject({
        id: filed.body.claimId,
        status: 'CREDITED',
        creditMicros: UNIT,
        decidedBy: 'PUBLISHER',
      });
      const usage = await agent().get('/api/buyer/usage').set('Cookie', w.buyer.cookie);
      expect(usage.body.rows[0]).toMatchObject({ id: w.callId, creditedMicros: UNIT });
      await expectLedgerClean();
    });

    it(`tenancy (${cases.length} cases): B can't claim on or list A's calls`, async () => {
      const a = await world();
      const b = await newBuyer();
      await fileClaim(a.buyer.cookie, {
        callId: a.callId,
        recordKey: 'listings/l-2',
        reason: 'MISSING_FIELD',
      });

      const cross = await fileClaim(b.cookie, {
        callId: a.callId,
        recordKey: 'listings/l-4',
        reason: 'WRONG_VALUE',
      });
      expect(cross.status).toBe(404);
      expect(JSON.stringify(cross.body)).not.toContain(a.callId);
      expect(
        await q(`SELECT id FROM claims WHERE api_call_id = $1 AND buyer_id = $2`, [a.callId, b.id]),
      ).toEqual([]);

      const listB = await listClaims(b.cookie, `?buyerId=${a.buyer.id}`);
      expect(listB.status).toBe(200);
      expect(listB.body.claims).toEqual([]);
      expect((await listClaims(a.buyer.cookie)).body.claims).toHaveLength(1);
    });
  },
);
