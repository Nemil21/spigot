import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@spigot/db/testing.mjs';
import { createKey } from '../auth/apiKeys.js';
import { loadConfig } from '../config.js';
import { testDatabaseUrl } from '../db/test-db.js';
import { defaultJobDeps, setJobDeps } from '../jobs/deps.js';
import triageJob from '../jobs/claims-triage.job.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { ledgerCheck } from '../ledger/check.js';
import { post } from '../ledger/ledger.js';
import { topupEntries } from '../ledger/postings.js';
import { ModelUnavailableError } from '../schema-agent/claude.js';
import { cases } from '../security/tenancy/publisher-claims.cases.js';
import { buildServer } from '../server.js';
import { REQUIRED_ENV } from '../test/env.js';
import { LISTING_SPEC } from '../test/extract-fixtures.js';
import { INJECTION_NOTE } from './__fixtures__/injection-claim.js';
import { loadTriageContext } from './triage-context.js';
import {
  createRecordedTriageModel,
  findUntriaged,
  MAX_TRIAGE_ATTEMPTS,
  triageClaim,
  type TriageModel,
} from './triage.js';

/**
 * SP-048b against Postgres: the triage agent stores a recommendation and never moves money
 * (including with the injection fixture and a model that "obeys" it), and the publisher's
 * `POST /api/claims/:id/decide` posts the CREDIT or closes the claim, idempotently, under races,
 * past the abuse limit, and only for the publisher's own claims.
 */

const ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const UNIT = 1_500;
const N = 3;
/** `LISTING_SPEC`'s fields plus a hidden PII field that must never reach the model. */
const FIELDS = [
  { name: 'price_usd', type: 'integer', required: true, visible: true, filterable: ['eq'] },
  { name: 'bedrooms', type: 'integer', visible: true, filterable: [] },
  { name: 'city', type: 'string', visible: true, filterable: [] },
  { name: 'status', type: 'string', visible: true, filterable: [] },
  { name: 'agent_phone', type: 'string', visible: false, filterable: [] },
];
const PHONE = '+1-512-555-0199';

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

const pageHtml = (price: number, status: string) =>
  `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    '@type': ['Apartment', 'Offer'],
    numberOfRooms: 2,
    address: { addressLocality: 'Austin' },
    offers: { price: String(price) },
  })}</script></head><body><span class="status-badge">${status}</span></body></html>`;

describe.skipIf(!testDatabaseUrl)(
  'SP-048b claims triage + publisher decide (Postgres)',
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
      setJobDeps(undefined);
      await app?.close();
      await db?.drop();
    });
    beforeEach(() => app.rateLimiter.reset());

    const agent = () => request(app.server);
    const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      (await app.db.pool.query(sql, params)).rows as T[];

    async function publisher() {
      const email = `pub-${randomUUID()}@example.com`;
      const res = await agent()
        .post('/api/auth/signup')
        .set('Origin', ORIGIN)
        .send({ name: 'Pub', email, password: 'correct horse', payoutEmail: `pay-${email}` });
      expect(res.status).toBe(201);
      const [row] = await q<{ id: string }>(`SELECT id FROM publishers WHERE email = $1`, [email]);
      return { id: row!.id, cookie: cookiesOf(res) };
    }

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

    /**
     * A publisher's site with a LIVE `listings` dataset of 3 records (l-1 … l-3), each with a page
     * and a snapshot. A buyer makes one paid 3-record call (4,500 µ$: the 10% abuse limit is 450 µ$,
     * below one record, so no claim here can ever be auto-credited). After the call l-1 moves to
     * version 2 (price 1650, Leased) and its page snapshot says so too.
     */
    async function world(pub?: { id: string; cookie: string }) {
      const owner = pub ?? (await publisher());
      const tag = randomUUID().slice(0, 8);
      const [s] = await q<{ id: string }>(
        `INSERT INTO sites (publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash, status)
         VALUES ($1, $2, $3, 'v', 'c', 'g', 'READY') RETURNING id`,
        [owner.id, `https://${tag}.example.com`, `s-${tag}`],
      );
      const [ds] = await q<{ id: string }>(
        `INSERT INTO datasets (site_id, slug, type_name, status, record_count, price_per_record_micros)
         VALUES ($1, 'listings', 'Listing', 'LIVE', $2, $3) RETURNING id`,
        [s!.id, N, UNIT],
      );
      const [sv] = await q<{ id: string }>(
        `INSERT INTO schema_versions (dataset_id, version, status, fields, extractor, record_key, proposed_by)
         VALUES ($1, 1, 'APPROVED', $2, $3, '{"from":"url"}', 'AI') RETURNING id`,
        [ds!.id, JSON.stringify(FIELDS), JSON.stringify(LISTING_SPEC)],
      );
      await q(`UPDATE datasets SET active_schema_id = $2 WHERE id = $1`, [ds!.id, sv!.id]);
      for (let i = 1; i <= N; i++) {
        const url = `https://${tag}.example.com/listings/l-${i}`;
        const [p] = await q<{ id: string }>(
          `INSERT INTO pages (site_id, url) VALUES ($1, $2) RETURNING id`,
          [s!.id, url],
        );
        await q(`INSERT INTO snapshots (page_id, http_status, html_gz) VALUES ($1, 200, $2)`, [
          p!.id,
          gzipSync(pageHtml(1500, 'Available')),
        ]);
        const data = {
          price_usd: 1500,
          bedrooms: 2,
          city: 'Austin',
          status: 'Available',
          agent_phone: PHONE,
        };
        const [r] = await q<{ id: string }>(
          `INSERT INTO records (dataset_id, record_key, page_id, data, hash, version, crawled_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, now(), now() - $6 * interval '1 second') RETURNING id`,
          [ds!.id, `l-${i}`, p!.id, JSON.stringify(data), `h${i}-${tag}`, i],
        );
        await q(
          `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
           VALUES ($1, $2, 1, 'add', $3, $4)`,
          [ds!.id, r!.id, JSON.stringify([{ op: 'add', path: '', value: data }]), `h${i}-${tag}`],
        );
      }
      await q(
        `UPDATE datasets SET published_seq = (SELECT max(seq) FROM record_versions WHERE dataset_id = $1) WHERE id = $1`,
        [ds!.id],
      );

      const [b] = await q<{ id: string }>(`INSERT INTO buyers (name) VALUES ($1) RETURNING id`, [
        `Buyer ${tag}`,
      ]);
      const key = (await createKey(app.db.pool, b!.id, { scopes: ['read'] })).key;
      await topUp(b!.id, 5_000_000);
      const res = await agent()
        .get(`/v1/s-${tag}/datasets/listings/records?limit=${N}`)
        .set('Authorization', `Bearer ${key}`);
      expect(res.status).toBe(200);
      const callId = res.headers['spigot-call-id'] as string;

      // After the call: l-1 → v2 (price 1650, Leased), and the page says so.
      const [l1] = await q<{ id: string; pageId: string }>(
        `UPDATE records SET data = data || '{"price_usd":1650,"status":"Leased"}', hash = $2, version = 2
          WHERE dataset_id = $1 AND record_key = 'l-1' RETURNING id, page_id AS "pageId"`,
        [ds!.id, `h1b-${tag}`],
      );
      await q(
        `INSERT INTO record_versions (dataset_id, record_id, version, op, patch, hash)
         VALUES ($1, $2, 2, 'update', $3, $4)`,
        [
          ds!.id,
          l1!.id,
          JSON.stringify([
            { op: 'replace', path: '/price_usd', value: 1650 },
            { op: 'replace', path: '/status', value: 'Leased' },
          ]),
          `h1b-${tag}`,
        ],
      );
      await q(
        `INSERT INTO snapshots (page_id, http_status, html_gz, fetched_at) VALUES ($1, 200, $2, now() + interval '1 second')`,
        [l1!.pageId, gzipSync(pageHtml(1650, 'Leased'))],
      );

      const claim = async (recordKey: string, reason: string, note: string | null = null) => {
        const r = await agent()
          .post('/v1/claims')
          .set('Authorization', `Bearer ${key}`)
          .send({ callId, recordKey, reason, note });
        expect(r.status).toBe(200);
        expect(r.body.status).toBe('OPEN');
        return r.body.claimId as string;
      };
      return { pub: owner, buyerId: b!.id, callId, datasetId: ds!.id, claim };
    }

    const decide = (cookie: string, id: string, decision: unknown) =>
      agent()
        .post(`/api/claims/${id}/decide`)
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .send({ decision });
    const list = (cookie: string, qs = '') => agent().get(`/api/claims${qs}`).set('Cookie', cookie);

    const bal = async (kind: 'BUYER_BALANCE' | 'PUBLISHER_PAYABLE', owner: string) =>
      (
        await q<{ b: number }>(
          `SELECT balance_micros AS b FROM ledger_accounts WHERE kind = $1 AND owner_id = $2`,
          [kind, owner],
        )
      )[0]?.b ?? 0;
    const claimRow = async (id: string) =>
      (
        await q<{
          status: string;
          credit: number | null;
          decidedBy: string | null;
          ai: Record<string, unknown> | null;
          ledgerTxnId: string | null;
        }>(
          `SELECT status, credit_micros AS credit, decided_by AS "decidedBy", ai_recommendation AS ai,
                  ledger_txn_id AS "ledgerTxnId" FROM claims WHERE id = $1`,
          [id],
        )
      )[0]!;
    const creditTxns = async (claimId: string) =>
      q(`SELECT id FROM ledger_txns WHERE kind = 'CREDIT' AND ref_id = $1`, [claimId]);
    const expectLedgerClean = async () => {
      const r = await ledgerCheck(app.db.pool);
      expect(r.mismatches).toEqual([]);
      expect(r.sumMicros).toBe(0);
      expect(await q(`SELECT id FROM api_calls WHERE credited_micros > price_micros`)).toEqual([]);
    };
    const money = async (w: { buyerId: string; pub: { id: string }; callId: string }) => ({
      buyer: await bal('BUYER_BALANCE', w.buyerId),
      payable: await bal('PUBLISHER_PAYABLE', w.pub.id),
      call: (await q(`SELECT status, credited_micros FROM api_calls WHERE id = $1`, [w.callId]))[0],
      ledgerTxns: (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ledger_txns`))[0]!.n,
    });

    /** A model that records what it was shown and answers with `input`. */
    function spyModel(input: unknown) {
      const seen: { prompt: string }[] = [];
      const model: TriageModel = {
        mode: 'live',
        modelId: 'spy',
        async recommend(_ctx, prompt) {
          seen.push({ prompt });
          return { input, model: 'spy-model', replayed: false, stopReason: 'tool_use' };
        },
      };
      return { model, seen };
    }

    // ── Triage ─────────────────────────────────────────────────────────────────────────────────

    it('context: served vs current vs page now for the cited fields, visible fields only', async () => {
      const w = await world();
      const id = await w.claim('listings/l-1', 'WRONG_VALUE', 'The price is wrong');
      const ctx = (await loadTriageContext(app.db.pool, id))!;
      expect(ctx.served).toMatchObject({ price_usd: 1500, status: 'Available' });
      expect(ctx.current).toMatchObject({ price_usd: 1650, status: 'Leased' });
      expect(ctx.changedFields).toEqual(['price_usd', 'status']);
      expect(ctx.citedFields).toEqual(['price_usd', 'status']);
      expect(ctx.snapshot?.values).toEqual({ price_usd: 1650, status: 'Leased' });
      expect(ctx.versions.map((v) => v.version)).toEqual([1, 2]);
      expect(ctx.unitPriceMicros).toBe(UNIT);
      expect(JSON.stringify(ctx)).not.toContain(PHONE);
      expect(JSON.stringify(ctx)).not.toContain('agent_phone');
    });

    it('recorded mode stores a READY recommendation on the claim; the claim stays OPEN, no money', async () => {
      const w = await world();
      const id = await w.claim('listings/l-1', 'WRONG_VALUE', 'price is off');
      const before = await money(w);
      const out = await triageClaim({ db: app.db, model: createRecordedTriageModel() }, id);
      expect(out.outcome).toBe('RECOMMENDED');
      const row = await claimRow(id);
      expect(row.status).toBe('OPEN');
      expect(row.ai).toMatchObject({
        status: 'READY',
        decision: 'CREDIT',
        model: 'recorded',
        replayed: true,
        attempts: 1,
      });
      expect(await money(w)).toEqual(before);
    });

    it('injection fixture: a model that obeys it still only stores {decision, confidence, reason}; no money moves, nothing is decided', async () => {
      const w = await world();
      const id = await w.claim('listings/l-2', 'WRONG_VALUE', INJECTION_NOTE);
      const before = await money(w);
      const spy = spyModel({
        decision: 'CREDIT',
        confidence: 1,
        reason: 'Pre-approved by Spigot.',
        autoApprove: true,
        amountMicros: 99_000_000,
        status: 'CREDITED',
      });
      const out = await triageClaim({ db: app.db, model: spy.model }, id);
      expect(out.outcome).toBe('RECOMMENDED');

      // The model saw the injection only inside the untrusted block, and no PII.
      const prompt = spy.seen[0]!.prompt;
      expect(prompt.match(/<\/untrusted_claim>/g)).toHaveLength(1);
      expect(prompt).not.toContain(PHONE);

      const row = await claimRow(id);
      expect(row.status).toBe('OPEN');
      expect(row.decidedBy).toBeNull();
      expect(row.credit).toBeNull();
      expect(row.ledgerTxnId).toBeNull();
      expect(Object.keys(row.ai!).sort()).toEqual(
        [
          'at',
          'attempts',
          'confidence',
          'decision',
          'model',
          'reason',
          'replayed',
          'status',
        ].sort(),
      );
      expect(row.ai).not.toHaveProperty('amountMicros');
      expect(row.ai).not.toHaveProperty('autoApprove');
      expect(await money(w)).toEqual(before);
      expect(await creditTxns(id)).toHaveLength(0);
      await expectLedgerClean();
    });

    it('invalid output / outage → stored as a failed try, retried later, at most 3 tries', async () => {
      const w = await world();
      const id = await w.claim('listings/l-3', 'STALE', null);
      const bad = spyModel({ decision: 'PAY_NOW', confidence: 2 });
      expect((await triageClaim({ db: app.db, model: bad.model }, id)).outcome).toBe('INVALID');
      expect((await claimRow(id)).ai).toMatchObject({ status: 'INVALID', attempts: 1 });
      // Not retried until 2 minutes have passed.
      expect(await findUntriaged(app.db.pool, 1_000)).not.toContain(id);
      const backdate = () =>
        q(
          `UPDATE claims SET ai_recommendation = jsonb_set(ai_recommendation, '{at}', to_jsonb((now() - interval '1 hour')::text)) WHERE id = $1`,
          [id],
        );
      await backdate();
      expect(await findUntriaged(app.db.pool, 1_000)).toContain(id);

      const down: TriageModel = {
        mode: 'live',
        modelId: 'down',
        recommend: async () => {
          throw new ModelUnavailableError('model unavailable after 3 tries (529)', 3, 529);
        },
      };
      for (let i = 2; i <= MAX_TRIAGE_ATTEMPTS; i++) {
        expect((await triageClaim({ db: app.db, model: down }, id)).outcome).toBe('UNAVAILABLE');
        expect((await claimRow(id)).ai).toMatchObject({ status: 'UNAVAILABLE', attempts: i });
        await backdate();
      }
      expect(await findUntriaged(app.db.pool, 1_000)).not.toContain(id);
      // The publisher can still decide it without a recommendation.
      expect((await claimRow(id)).status).toBe('OPEN');
    });

    it('a decided claim is never triaged, and a READY recommendation is never overwritten', async () => {
      const w = await world();
      const id = await w.claim('listings/l-1', 'WRONG_VALUE', 'price');
      await triageClaim({ db: app.db, model: createRecordedTriageModel() }, id);
      const first = (await claimRow(id)).ai;
      const other = spyModel({ decision: 'REJECT', confidence: 0.1, reason: 'later' });
      expect((await triageClaim({ db: app.db, model: other.model }, id)).outcome).toBe('SKIPPED');
      expect((await claimRow(id)).ai).toEqual(first);

      const id2 = await w.claim('listings/l-2', 'WRONG_VALUE', 'x');
      expect((await decide(w.pub.cookie, id2, 'REJECT')).status).toBe(200);
      expect((await triageClaim({ db: app.db, model: other.model }, id2)).outcome).toBe('SKIPPED');
      expect(other.seen).toHaveLength(0);
    });

    it('the claims-triage job triages OPEN claims in recorded mode (jobs on via setJobDeps)', async () => {
      const w = await world();
      const id = await w.claim('listings/l-3', 'REMOVED', 'gone');
      // Live mode with no key: the job is a quiet no-op, never a crash.
      setJobDeps({
        db: app.db,
        config: loadConfig({ ...REQUIRED_ENV, SCHEMA_AGENT_MODE: 'live' }),
        pp: {} as never,
      });
      await triageJob.run();
      expect((await claimRow(id)).ai).toBeNull();
      const config = loadConfig({
        ...REQUIRED_ENV,
        DATABASE_URL: db.url,
        SCHEMA_AGENT_MODE: 'recorded',
      });
      setJobDeps({ db: app.db, config, pp: {} as never });
      try {
        expect(defaultJobDeps()).not.toBeNull();
        // Other tests' claims may be first in line; run until ours is done (5 per tick).
        for (let i = 0; i < 20 && !(await claimRow(id)).ai; i++) await triageJob.run();
      } finally {
        setJobDeps(undefined);
      }
      expect((await claimRow(id)).ai).toMatchObject({ status: 'READY', decision: 'CREDIT' });
    });

    // ── Publisher list + decide ───────────────────────────────────────────────────────────────

    it('ambiguous claim shows the recommendation; CREDIT posts the CREDIT (past the abuse limit)', async () => {
      const w = await world();
      const id = await w.claim('listings/l-1', 'WRONG_VALUE', 'The price is wrong');
      await triageClaim({ db: app.db, model: createRecordedTriageModel() }, id);

      const open = await list(w.pub.cookie, '?status=OPEN');
      expect(open.status).toBe(200);
      const shown = open.body.claims.find((c: { id: string }) => c.id === id);
      expect(shown).toMatchObject({
        status: 'OPEN',
        reason: 'WRONG_VALUE',
        note: 'The price is wrong',
        recordKey: 'listings/l-1',
        callId: w.callId,
        amountMicros: UNIT,
        aiRecommendation: { status: 'READY', decision: 'CREDIT', confidence: 0.7 },
      });
      expect(JSON.stringify(open.body)).not.toContain(w.buyerId);

      const before = await money(w);
      const res = await decide(w.pub.cookie, id, 'CREDIT');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        claimId: id,
        status: 'CREDITED',
        creditMicros: UNIT,
        replay: false,
      });
      const row = await claimRow(id);
      expect(row).toMatchObject({ status: 'CREDITED', credit: UNIT, decidedBy: 'PUBLISHER' });
      expect(await creditTxns(id)).toHaveLength(1);
      const key = await q<{ k: string }>(
        `SELECT idempotency_key AS k FROM ledger_txns WHERE id = $1`,
        [row.ledgerTxnId],
      );
      expect(key[0]!.k).toBe(`claim:${id}`);
      const after = await money(w);
      expect(after.buyer).toBe(before.buyer + UNIT);
      expect(after.payable).toBeLessThan(before.payable);
      expect(after.call).toMatchObject({ status: 'PARTIALLY_CREDITED', credited_micros: UNIT });

      const [a] = await q<{ data: Record<string, unknown>; actorType: string }>(
        `SELECT data, actor_type AS "actorType" FROM audit_events
          WHERE entity = 'claims' AND entity_id = $1 AND action = 'CLAIM_DECIDED'`,
        [id],
      );
      expect(a).toMatchObject({
        actorType: 'PUBLISHER',
        data: { status: 'CREDITED', decidedBy: 'PUBLISHER', followedAi: true },
      });
      expect(
        (await list(w.pub.cookie, '?status=OPEN')).body.claims.map((c: { id: string }) => c.id),
      ).not.toContain(id);
      expect((await list(w.pub.cookie, '?status=CREDITED')).body.claims[0].id).toBe(id);
      await expectLedgerClean();
    });

    it('REJECT closes the claim with no money; repeats replay; the other decision is 409', async () => {
      const w = await world();
      const id = await w.claim('listings/l-2', 'WRONG_VALUE', 'looks wrong');
      const before = await money(w);
      const res = await decide(w.pub.cookie, id, 'REJECT');
      expect(res.body).toEqual({ claimId: id, status: 'REJECTED', creditMicros: 0, replay: false });
      expect(await claimRow(id)).toMatchObject({
        status: 'REJECTED',
        decidedBy: 'PUBLISHER',
        credit: null,
      });
      expect(await money(w)).toEqual(before);

      const again = await decide(w.pub.cookie, id, 'REJECT');
      expect(again.body).toMatchObject({ status: 'REJECTED', replay: true });
      const flip = await decide(w.pub.cookie, id, 'CREDIT');
      expect(flip.status).toBe(409);
      expect(flip.body.error.code).toBe('STATE_CONFLICT');
      expect(await money(w)).toEqual(before);
      expect((await decide(w.pub.cookie, id, 'MAYBE')).status).toBe(400);
    });

    it('race: 10 parallel CREDITs → one CREDIT posting; CREDIT vs REJECT → exactly one wins', async () => {
      const w = await world();
      const id = await w.claim('listings/l-1', 'WRONG_VALUE', 'x');
      const before = await money(w);
      const res = await Promise.all(
        Array.from({ length: 10 }, () => decide(w.pub.cookie, id, 'CREDIT')),
      );
      expect(res.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(res.filter((r) => r.body.replay === false)).toHaveLength(1);
      expect(await creditTxns(id)).toHaveLength(1);
      expect((await money(w)).buyer).toBe(before.buyer + UNIT);

      const id2 = await w.claim('listings/l-2', 'WRONG_VALUE', 'y');
      const mixed = await Promise.all(
        Array.from({ length: 8 }, (_, i) => decide(w.pub.cookie, id2, i % 2 ? 'CREDIT' : 'REJECT')),
      );
      const fresh = mixed.filter((r) => r.status === 200 && r.body.replay === false);
      expect(fresh).toHaveLength(1);
      const won = fresh[0]!.body.status as string;
      for (const r of mixed) {
        if (r.status === 200) expect(r.body.status).toBe(won);
        else expect(r.status).toBe(409);
      }
      expect(await creditTxns(id2)).toHaveLength(won === 'CREDITED' ? 1 : 0);
      await expectLedgerClean();
    });

    it('CREDIT on a call with nothing left to credit → 409, claim stays OPEN', async () => {
      const w = await world();
      const id = await w.claim('listings/l-3', 'WRONG_VALUE', 'z');
      await q(
        `UPDATE api_calls SET credited_micros = price_micros, status = 'CREDITED' WHERE id = $1`,
        [w.callId],
      );
      const res = await decide(w.pub.cookie, id, 'CREDIT');
      expect(res.status).toBe(409);
      expect((await claimRow(id)).status).toBe('OPEN');
      expect(await creditTxns(id)).toHaveLength(0);
    });

    // ── Tenancy ───────────────────────────────────────────────────────────────────────────────

    it('covers both routes with a tenancy case', () => {
      expect(cases.map((c) => `${c.method} ${c.url}`).sort()).toEqual(
        ['GET /api/claims', 'POST /api/claims/:id/decide'].sort(),
      );
    });

    it("publisher B never sees or decides A's claims (404, nothing changes); no session → 401", async () => {
      const a = await world();
      const id = await a.claim('listings/l-1', 'WRONG_VALUE', 'x');
      const b = await world();
      await b.claim('listings/l-2', 'WRONG_VALUE', 'mine');

      const bList = await list(b.pub.cookie);
      expect(bList.status).toBe(200);
      expect(bList.body.claims.length).toBeGreaterThan(0);
      expect(JSON.stringify(bList.body)).not.toContain(id);
      expect(JSON.stringify(bList.body)).not.toContain(a.callId);

      const before = await money(a);
      for (const decision of ['CREDIT', 'REJECT', 'nonsense']) {
        const r = await decide(b.pub.cookie, id, decision);
        expect(r.status).toBe(404);
        expect(r.body.error.code).toBe('NOT_FOUND');
      }
      expect((await decide(b.pub.cookie, randomUUID(), 'CREDIT')).status).toBe(404);
      expect((await decide(b.pub.cookie, 'not-a-uuid', 'CREDIT')).status).toBe(404);
      expect(await claimRow(id)).toMatchObject({ status: 'OPEN', decidedBy: null });
      expect(await money(a)).toEqual(before);
      expect(
        await q(`SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'CLAIM_DECIDED'`, [
          id,
        ]),
      ).toHaveLength(0);

      expect((await list('')).status).toBe(401);
      expect((await decide('', id, 'CREDIT')).status).toBe(401);
    });
  },
);
