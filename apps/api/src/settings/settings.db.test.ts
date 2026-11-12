import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { classify } from '../../../../packages/gate/src/classify.js';
import {
  POLICY_INTERVAL_MS,
  startPolicyRefresher,
  type FetchLike,
  type PolicyRefresher,
} from '../../../../packages/gate/src/refresher.js';
import { loadConfig } from '../config.js';
import { crawlKeyHash, deriveCrawlKey } from '../crawl/crawlKey.js';
import { crawlSite } from '../crawl/crawlSite.js';
import { clearCrawlHooks } from '../crawl/hooks.js';
import { resetHostQueues } from '../crawl/queue.js';
import type { SafeResponse } from '../crawl/safeFetch.js';
import { createDb } from '../db/index.js';
import { transition } from '../db/transition.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../db/test-db.js';
import { getOrCreateAccount, platformAccounts } from '../ledger/accounts.js';
import { post } from '../ledger/ledger.js';
import { chargeEntries, topupEntries } from '../ledger/postings.js';
import { FakePayPalExtras } from '../paypal/fake/extras.js';
import { moneyOut } from '../paypal/moneyOut.js';
import { buildBatch } from '../payouts/buildBatch.js';
import { payoutRun } from '../payouts/payoutRun.js';
import { cases } from '../security/tenancy/settings.cases.js';
import { buildServer } from '../server.js';
import { generateSiteSecrets, sha256Hex } from '../sites/keys.js';
import { REQUIRED_ENV } from '../test/env.js';

/**
 * SP-034 integration (ticket §Test plan): the three W16 endpoints through the real routes and
 * Postgres, plus the acceptance criteria end to end:
 * - AI_AGENT → PASS reaches a real `spigot-gate` policy refresher on its next 60 s tick, and the
 *   gate's own `classify` then passes `ChatGPT-User`;
 * - a crawl-key rotation makes the next real crawl send the new key, which that gate counts as
 *   SPIGOT_CRAWLER after its next refresh, while the old key matches nothing;
 * - a payout email change leaves a built batch's `receiver_email` (and what FakePayPal receives
 *   when that batch is submitted) on the old address.
 */

const APP_ORIGIN = REQUIRED_ENV.APP_BASE_URL!;
const SECRET = REQUIRED_ENV.SESSION_SECRET!;
const CHATGPT_USER =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';

function cookiesOf(res: request.Response): string {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

interface Site {
  id: string;
  publisherId: string;
  origin: string;
  gateKey: string;
  cookie: string;
}

describe.skipIf(!testDatabaseUrl)('SP-034 W16 settings (Postgres)', { timeout: 30_000 }, () => {
  let pools: TwoPools;
  let pool: pg.Pool;
  let app: FastifyInstance;
  const refreshers: PolicyRefresher[] = [];

  beforeAll(async () => {
    pools = await twoPools();
    pool = pools.a;
    app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: pools.db.url }), {
      logStream: new Writable({ write: (_c, _e, cb) => cb() }),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await pools?.close();
  });
  beforeEach(() => app.rateLimiter.reset());
  afterEach(() => {
    for (const r of refreshers.splice(0)) r.stop();
    vi.useRealTimers();
  });

  const agent = () => request(app.server);
  const patchMe = (cookie: string, body: unknown) =>
    agent()
      .patch('/api/publishers/me')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .send(body as object);
  const patchPolicy = (siteId: string, cookie: string, body: unknown) =>
    agent()
      .patch(`/api/sites/${siteId}/policy`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .send(body as object);
  const rotate = (siteId: string, cookie: string, kind: string) =>
    agent()
      .post(`/api/sites/${siteId}/keys/rotate`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .send({ kind });
  const siteRow = async (id: string) =>
    (
      await pool.query<{
        policy: Record<string, unknown>;
        policy_version: number;
        crawl_key_hash: string;
        gate_key_hash: string;
        crawl_key_version: number;
      }>(
        `SELECT policy, policy_version, crawl_key_hash, gate_key_hash, crawl_key_version
           FROM sites WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const auditRows = async (entityId: string, action: string) =>
    (
      await pool.query<{ data: Record<string, unknown> }>(
        'SELECT data FROM audit_events WHERE entity_id = $1 AND action = $2 ORDER BY id',
        [entityId, action],
      )
    ).rows;

  async function newPublisher(payoutEmail = 'payouts@example.com') {
    const res = await agent()
      .post('/api/auth/signup')
      .set('Origin', APP_ORIGIN)
      .send({
        name: 'Bluebonnet',
        email: `p-${randomUUID()}@example.com`,
        password: 'correct horse',
        payoutEmail,
      });
    expect(res.status).toBe(201);
    return { publisherId: res.body.publisherId as string, cookie: cookiesOf(res) };
  }

  /** A publisher (through signup) with one READY site; the site row is a fixture with fresh keys. */
  async function newSite(gatedPaths: string[] = ['^/listings/']): Promise<Site> {
    const { publisherId, cookie } = await newPublisher();
    const id = randomUUID();
    const slug = `site-${id.slice(0, 8)}`;
    const origin = `https://${slug}.example.com`;
    const s = generateSiteSecrets(id, SECRET);
    await pool.query(
      `INSERT INTO sites (id, publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash,
                          status, policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY', $8::jsonb)`,
      [
        id,
        publisherId,
        origin,
        slug,
        s.verifyToken,
        s.crawlKeyHash,
        s.gateKeyHash,
        JSON.stringify({
          SEARCH: 'PASS',
          AI_TRAINING: 'QUOTE',
          AI_AGENT: 'QUOTE',
          SCRAPER_TOOL: 'QUOTE',
          UNKNOWN: 'PASS',
          gated_paths: gatedPaths,
        }),
      ],
    );
    return { id, publisherId, origin, gateKey: s.gateKey, cookie };
  }

  /** The gate's own fetch, answered in-process by the API (no socket). */
  const inProcessFetch: FetchLike = async (url, init) => {
    const res = await app.inject({
      method: 'GET',
      url: new URL(url).pathname,
      headers: init.headers as Record<string, string>,
    });
    return new Response(res.statusCode === 304 ? null : res.body, { status: res.statusCode });
  };

  /**
   * A real `spigot-gate` policy refresher for `site` on its default 60 s interval, with
   * `setInterval` faked so a test can step to the next tick.
   */
  async function startGate(site: Site): Promise<PolicyRefresher> {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const r = startPolicyRefresher({
      apiBase: APP_ORIGIN,
      gateKey: site.gateKey,
      fetch: inProcessFetch,
      logger: { info: () => {}, warn: () => {} },
    });
    refreshers.push(r);
    await vi.waitFor(() => expect(r.current).not.toBeNull());
    return r;
  }

  /** Advance the gate to its next background refresh (≤ 60 s from now) and let it load. */
  async function nextTick(r: PolicyRefresher, version: number): Promise<void> {
    vi.advanceTimersByTime(POLICY_INTERVAL_MS);
    await vi.waitFor(() => expect(r.current?.policy.policyVersion).toBe(version));
  }

  const ask = (
    r: PolicyRefresher,
    ua: string,
    path: string,
    headers: Record<string, string> = {},
  ) =>
    classify(
      { ua, ip: '203.0.113.9', path, headers: { 'user-agent': ua, ...headers } },
      r.current!.policy,
    );

  // -------------------------------------------------------------------------------------------
  describe('PATCH /api/sites/:id/policy', () => {
    it('AC: AI_AGENT → PASS; the gate passes ChatGPT-User on its next 60 s refresh', async () => {
      const site = await newSite();
      const gate = await startGate(site);
      const v1 = gate.current!.policy.policyVersion;
      expect(ask(gate, CHATGPT_USER, '/listings/42')).toMatchObject({
        decision: 'QUOTE',
        category: 'AI_AGENT',
      });

      const res = await patchPolicy(site.id, site.cookie, { decisions: { AI_AGENT: 'PASS' } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        siteId: site.id,
        decisions: {
          SEARCH: 'PASS',
          AI_TRAINING: 'QUOTE',
          AI_AGENT: 'PASS',
          SCRAPER_TOOL: 'QUOTE',
          UNKNOWN: 'PASS',
        },
        gatedPaths: ['^/listings/'],
        policyVersion: v1 + 1,
      });

      // Until the next tick the gate keeps its loaded policy; one tick later it passes.
      expect(ask(gate, CHATGPT_USER, '/listings/42').decision).toBe('QUOTE');
      await nextTick(gate, v1 + 1);
      expect(ask(gate, CHATGPT_USER, '/listings/42')).toMatchObject({
        decision: 'PASS',
        category: 'AI_AGENT',
      });
      // Other categories are untouched.
      expect(ask(gate, 'Mozilla/5.0 (compatible; GPTBot/1.1)', '/listings/42').decision).toBe(
        'QUOTE',
      );

      const [a] = await auditRows(site.id, 'SETTINGS_CHANGED');
      expect(a!.data).toMatchObject({
        policyVersion: v1 + 1,
        decisions: { AI_AGENT: { from: 'QUOTE', to: 'PASS' } },
      });
    });

    it('replaces the gated paths; the gate gates the new paths after its refresh', async () => {
      const site = await newSite([]);
      const gate = await startGate(site);
      const v1 = gate.current!.policy.policyVersion;
      const bot = 'Mozilla/5.0 (compatible; GPTBot/1.1)';
      expect(ask(gate, bot, '/recipes/pie').decision).toBe('PASS');

      const res = await patchPolicy(site.id, site.cookie, {
        gatedPaths: [' ^/recipes/ ', '^/menu$', '^/recipes/'],
      });
      expect(res.status).toBe(200);
      expect(res.body.gatedPaths).toEqual(['^/recipes/', '^/menu$']);
      expect((await siteRow(site.id)).policy.gated_paths).toEqual(['^/recipes/', '^/menu$']);
      await nextTick(gate, v1 + 1);
      expect(ask(gate, bot, '/recipes/pie').decision).toBe('QUOTE');
      expect(ask(gate, bot, '/robots.txt').decision).toBe('PASS');
    });

    it('rejects an invalid regex, SEARCH → QUOTE, unknown fields and an empty body; nothing changes', async () => {
      const site = await newSite();
      const before = await siteRow(site.id);
      const bad = [
        { gatedPaths: ['^/ok/', '^/broken/(', ''] },
        { decisions: { SEARCH: 'QUOTE' } },
        { decisions: { AI_AGENT: 'BLOCK' } },
        { decisions: { HUMAN: 'QUOTE' } },
        { gatedPaths: Array.from({ length: 51 }, (_, i) => `^/p${i}/`) },
        { gatedPaths: ['x'.repeat(501)] },
        { policyVersion: 99 },
        {},
      ];
      for (const body of bad) {
        const res = await patchPolicy(site.id, site.cookie, body);
        expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const res = await patchPolicy(site.id, site.cookie, bad[0]);
      const paths = res.body.error.details.issues.map((i: { path: string }) => i.path);
      expect(paths).toEqual(['gatedPaths.1', 'gatedPaths.2']);
      expect(await siteRow(site.id)).toEqual(before);
    });

    it('is idempotent: the same change again keeps the version and writes no audit row', async () => {
      const site = await newSite();
      const body = { decisions: { AI_AGENT: 'PASS' }, gatedPaths: ['^/listings/'] };
      const first = await patchPolicy(site.id, site.cookie, body);
      const second = await patchPolicy(site.id, site.cookie, body);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect((await siteRow(site.id)).policy_version).toBe(first.body.policyVersion);
      expect(await auditRows(site.id, 'SETTINGS_CHANGED')).toHaveLength(1);
    });

    it('race: two concurrent edits of different categories from two API processes both land', async () => {
      const site = await newSite();
      const before = (await siteRow(site.id)).policy_version;
      const appB = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: pools.db.url }), {
        logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      });
      await appB.ready();
      try {
        const viaB = (body: unknown) =>
          request(appB.server)
            .patch(`/api/sites/${site.id}/policy`)
            .set('Origin', APP_ORIGIN)
            .set('Cookie', site.cookie)
            .send(body as object);
        const [a, b] = await Promise.all([
          patchPolicy(site.id, site.cookie, { decisions: { AI_AGENT: 'PASS' } }),
          viaB({ decisions: { SCRAPER_TOOL: 'PASS' } }),
        ]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect([a.body.policyVersion, b.body.policyVersion].sort()).toEqual([
          before + 1,
          before + 2,
        ]);
      } finally {
        await appB.close();
      }
      const row = await siteRow(site.id);
      expect(row.policy).toMatchObject({
        AI_AGENT: 'PASS',
        SCRAPER_TOOL: 'PASS',
        AI_TRAINING: 'QUOTE',
      });
      expect(row.policy_version).toBe(before + 2);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('POST /api/sites/:id/keys/rotate', () => {
    /**
     * A stub origin for the crawler: every request goes through the gate's `classify` with the
     * gate's current policy (what the middleware would decide), and the decision is recorded.
     */
    function gatedOrigin(
      site: Site,
      gate: PolicyRefresher,
      seen: { path: string; key?: string; decision: string; botName: string }[],
    ) {
      return async (
        url: string,
        opts: { headers?: Record<string, string> },
      ): Promise<SafeResponse> => {
        const u = new URL(url);
        const headers = Object.fromEntries(
          Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        );
        const r = ask(gate, headers['user-agent'] ?? '', u.pathname, headers);
        seen.push({
          path: u.pathname,
          key: headers['x-spigot-key'],
          decision: r.decision,
          botName: r.botName,
        });
        const body =
          u.pathname === '/sitemap.xml'
            ? `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${site.origin}/listings/1</loc></url></urlset>`
            : '<html><body>listing</body></html>';
        return {
          url,
          status: 200,
          headers: {
            'content-type': u.pathname === '/sitemap.xml' ? 'application/xml' : 'text/html',
          },
          body: Buffer.from(body),
          redirects: [],
          address: '203.0.113.10',
        };
      };
    }

    it('AC: crawl key → next crawl sends the new key, counted SPIGOT_CRAWLER after the refresh; the old key is not recognised', async () => {
      const site = await newSite(['^/listings/']);
      const gate = await startGate(site);
      const v1 = gate.current!.policy.policyVersion;
      const oldKey = deriveCrawlKey(site.id, SECRET);
      const crawlBot = (key: string) =>
        ask(gate, 'SpigotCrawler/1.0 (+http://spigot.test/crawler)', '/listings/1', {
          'x-spigot-key': key,
        });
      expect(crawlBot(oldKey).decision).toBe('SPIGOT_CRAWLER');

      const res = await rotate(site.id, site.cookie, 'crawl');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const newKey = res.body.key as string;
      expect(res.body).toEqual({
        siteId: site.id,
        kind: 'crawl',
        key: newKey,
        envVar: 'SPIGOT_CRAWL_KEY',
        policyVersion: v1 + 1,
      });
      expect(newKey).toMatch(/^ck_/);
      expect(newKey).not.toBe(oldKey);
      expect(newKey).toBe(deriveCrawlKey(site.id, SECRET, 2));
      const row = await siteRow(site.id);
      expect(row).toMatchObject({ crawl_key_version: 2, crawl_key_hash: crawlKeyHash(newKey) });

      // The gate picks up the new hash on its next refresh (≤ 60 s).
      await nextTick(gate, v1 + 1);
      expect(gate.current!.policy.wire.crawlKeySha256).toBe(crawlKeyHash(newKey));
      expect(crawlBot(oldKey).decision).not.toBe('SPIGOT_CRAWLER');

      // The next real crawl derives the key for the new version.
      clearCrawlHooks();
      resetHostQueues();
      const seen: { path: string; key?: string; decision: string; botName: string }[] = [];
      const result = await crawlSite(
        { siteId: site.id, trigger: 'MANUAL' },
        {
          db: createDb(pool),
          crawlSecret: SECRET,
          allowLocal: false,
          appBaseUrl: 'http://spigot.test',
          minGapMs: 0,
          sleep: async () => {},
          fetch: gatedOrigin(site, gate, seen),
        },
      );
      expect(result.status).toBe('SUCCEEDED');
      expect(seen.map((s) => s.path)).toEqual(['/sitemap.xml', '/listings/1']);
      for (const s of seen) {
        expect(s).toMatchObject({
          key: newKey,
          decision: 'SPIGOT_CRAWLER',
          botName: 'SpigotCrawler',
        });
      }

      const [a] = await auditRows(site.id, 'SITE_KEY_ROTATED');
      expect(a!.data).toEqual({ kind: 'crawl', crawlKeyVersion: 2, policyVersion: v1 + 1 });
      expect(JSON.stringify(a!.data)).not.toContain(newKey);
    });

    it('gate key → the new key pulls the policy, the old one gets 401', async () => {
      const site = await newSite();
      const before = await siteRow(site.id);
      const res = await rotate(site.id, site.cookie, 'gate');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        siteId: site.id,
        kind: 'gate',
        envVar: 'SPIGOT_GATE_KEY',
        policyVersion: before.policy_version,
      });
      expect(res.body.key).toMatch(/^gk_/);
      const after = await siteRow(site.id);
      expect(after.gate_key_hash).toBe(sha256Hex(res.body.key));
      expect(after.crawl_key_hash).toBe(before.crawl_key_hash);

      const pull = (key: string) =>
        agent().get('/api/gate/policy').set('Authorization', `Bearer ${key}`);
      expect((await pull(site.gateKey)).status).toBe(401);
      expect((await pull(res.body.key)).status).toBe(200);
    });

    it('race: two concurrent crawl rotations from two API processes → versions 2 and 3; only the later key is recognised', async () => {
      const site = await newSite();
      const v0 = (await siteRow(site.id)).policy_version;
      const appB = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: pools.db.url }), {
        logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      });
      await appB.ready();
      let results: request.Response[];
      try {
        results = await Promise.all([
          rotate(site.id, site.cookie, 'crawl'),
          request(appB.server)
            .post(`/api/sites/${site.id}/keys/rotate`)
            .set('Origin', APP_ORIGIN)
            .set('Cookie', site.cookie)
            .send({ kind: 'crawl' }),
        ]);
      } finally {
        await appB.close();
      }
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const keys = results.map((r) => r.body.key as string);
      expect(new Set(keys).size).toBe(2);
      const row = await siteRow(site.id);
      expect(row.crawl_key_version).toBe(3);
      expect(row.policy_version).toBe(v0 + 2);
      expect(row.crawl_key_hash).toBe(crawlKeyHash(deriveCrawlKey(site.id, SECRET, 3)));
      expect(keys).toContain(deriveCrawlKey(site.id, SECRET, 2));
      expect(keys).toContain(deriveCrawlKey(site.id, SECRET, 3));
    });

    it('rejects an unknown kind', async () => {
      const site = await newSite();
      for (const kind of ['verify', '', 'GATE']) {
        const res = await rotate(site.id, site.cookie, kind);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('PATCH /api/publishers/me', () => {
    it('updates name and payout email; /api/auth/me shows them; the change is audited', async () => {
      const { publisherId, cookie } = await newPublisher('old@example.com');
      const res = await patchMe(cookie, {
        name: '  Bluebonnet Realty ',
        payoutEmail: ' New@Example.com ',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: publisherId,
        name: 'Bluebonnet Realty',
        payoutEmail: 'new@example.com',
      });
      const me = await agent().get('/api/auth/me').set('Cookie', cookie);
      expect(me.body.publisher).toMatchObject({
        name: 'Bluebonnet Realty',
        payoutEmail: 'new@example.com',
      });
      const [a] = await auditRows(publisherId, 'SETTINGS_CHANGED');
      expect(a!.data).toEqual({
        changed: {
          name: { from: 'Bluebonnet', to: 'Bluebonnet Realty' },
          payoutEmail: { from: 'old@example.com', to: 'new@example.com' },
        },
      });
      // The same values again: nothing to audit.
      await patchMe(cookie, { payoutEmail: 'new@example.com' });
      expect(await auditRows(publisherId, 'SETTINGS_CHANGED')).toHaveLength(1);
    });

    it('rejects a bad email, an empty name, the login email, commission and an empty body', async () => {
      const { publisherId, cookie } = await newPublisher('keep@example.com');
      for (const body of [
        { payoutEmail: 'not-an-email' },
        { name: '   ' },
        { email: 'x@example.com' },
        { commissionBps: 0 },
        {},
      ]) {
        const res = await patchMe(cookie, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const { rows } = await pool.query(
        'SELECT payout_email, commission_bps FROM publishers WHERE id = $1',
        [publisherId],
      );
      expect(rows[0]).toEqual({ payout_email: 'keep@example.com', commission_bps: 2000 });
    });

    it('needs a publisher session', async () => {
      const res = await agent()
        .patch('/api/publishers/me')
        .set('Origin', APP_ORIGIN)
        .send({ name: 'X' });
      expect(res.status).toBe(401);
    });

    it("AC: a payout email change doesn't alter a built batch's receiver_email; the next batch uses the new one (FakePayPal)", async () => {
      const { publisherId, cookie } = await newPublisher('before@payee.example');
      const fake = new FakePayPalExtras({ payouts: { merchantEmail: 'merchant@spigot.example' } });
      const deps = {
        pool,
        pp: moneyOut(fake.transport({ timeoutMs: 100 }), undefined),
        retryDelayMs: 0,
      };

      // A batch is built (BUILDING, items snapshotted) and the process dies before submitting it.
      await charge(publisherId, 20_000_000);
      const client = await pool.connect();
      const built = await buildBatch(client, { trigger: 'MANUAL_DEMO' }).finally(() =>
        client.release(),
      );
      expect(built.kind).toBe('BUILT');
      if (built.kind !== 'BUILT') return;

      // The owner changes the payout email while that batch is in flight.
      expect((await patchMe(cookie, { payoutEmail: 'after@payee.example' })).status).toBe(200);

      const item = async (batchId: string) =>
        (
          await pool.query<{ receiver_email: string }>(
            'SELECT receiver_email FROM payout_items WHERE batch_id = $1 AND publisher_id = $2',
            [batchId, publisherId],
          )
        ).rows[0]!.receiver_email;
      expect(await item(built.batchId)).toBe('before@payee.example');

      // The resumed run submits the built batch: PayPal is paid to the snapshot, not the new email.
      const resumed = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps);
      expect(resumed).toMatchObject({ outcome: 'PENDING', resumed: true, batchId: built.batchId });
      const ppBatch = fake.payouts.batchBySenderId(built.batchId)!;
      expect(fake.payouts.itemsOf(ppBatch.id).map((i) => i.receiver)).toEqual([
        'before@payee.example',
      ]);
      expect(await item(built.batchId)).toBe('before@payee.example');

      // Once that item is paid out (SP-021's poll; here the same guarded transition), the next
      // batch goes to the new address.
      const [{ id: itemId }] = (
        await pool.query<{ id: string }>('SELECT id FROM payout_items WHERE batch_id = $1', [
          built.batchId,
        ])
      ).rows as [{ id: string }];
      await createDb(pool).tx((tx) => transition(tx, 'payout_items', itemId, 'PENDING', 'SUCCESS'));
      await charge(publisherId, 20_000_000);
      const next = await payoutRun({ trigger: 'MANUAL_DEMO' }, deps);
      expect(next.outcome).toBe('PENDING');
      if (next.outcome !== 'PENDING') return;
      expect(next.batchId).not.toBe(built.batchId);
      expect(await item(next.batchId)).toBe('after@payee.example');
    });

    /** One charged API call of `priceMicros` (20% commission) for `publisherId`. */
    async function charge(publisherId: string, priceMicros: number): Promise<void> {
      await createDb(pool).tx(async (tx) => {
        const platform = await platformAccounts(tx);
        const [b] = (await tx.query(`INSERT INTO buyers (name) VALUES ('B') RETURNING id`)).rows;
        const [k] = (
          await tx.query(
            `INSERT INTO api_keys (buyer_id, prefix, key_hash) VALUES ($1, 'sk_test', $2) RETURNING id`,
            [b.id, randomUUID()],
          )
        ).rows;
        const buyer = await getOrCreateAccount(tx, 'BUYER_BALANCE', b.id);
        const publisher = await getOrCreateAccount(tx, 'PUBLISHER_PAYABLE', publisherId);
        await post(tx, {
          kind: 'TOPUP',
          idempotencyKey: `topup:${randomUUID()}`,
          entries: topupEntries({ buyer, paypalCash: platform.paypalCash }, priceMicros),
        });
        const callId = randomUUID();
        const charged = await post(tx, {
          kind: 'CHARGE',
          idempotencyKey: `charge:${callId}`,
          refType: 'api_call',
          refId: callId,
          entries: chargeEntries(
            { buyer, publisher, platformRevenue: platform.platformRevenue },
            priceMicros,
            2000,
          ),
        });
        await tx.query(
          `INSERT INTO api_calls (id, buyer_id, api_key_id, channel, idempotency_key, status,
                                  records_returned, price_micros, commission_bps, charge_txn_id)
           VALUES ($1, $2, $3, 'REST', $4, 'CHARGED', 1000, $5, 2000, $6)`,
          [callId, b.id, k.id, callId, priceMicros, charged.txn.id],
        );
      });
    }
  });

  // -------------------------------------------------------------------------------------------
  describe('tenancy (settings.cases.ts)', () => {
    it('covers every SP-034 route', () => {
      expect(cases.map((c) => `${c.method} ${c.url}`).sort()).toEqual([
        'PATCH /api/publishers/me',
        'PATCH /api/sites/:id/policy',
        'POST /api/sites/:id/keys/rotate',
      ]);
    });

    it("A's session can't touch B's site (404) or B's account", async () => {
      const a = await newSite();
      const b = await newSite();
      const before = await siteRow(b.id);
      const p = await patchPolicy(b.id, a.cookie, { decisions: { AI_AGENT: 'PASS' } });
      expect(p.status).toBe(404);
      expect(p.body.error.code).toBe('NOT_FOUND');
      for (const kind of ['gate', 'crawl']) {
        const r = await rotate(b.id, a.cookie, kind);
        expect(r.status).toBe(404);
        expect(r.body).not.toHaveProperty('key');
      }
      expect((await rotate('not-a-uuid', a.cookie, 'gate')).status).toBe(404);
      expect(await siteRow(b.id)).toEqual(before);

      // PATCH /me with B's id smuggled in is rejected and changes nobody.
      const me = await patchMe(a.cookie, {
        publisherId: b.publisherId,
        payoutEmail: 'evil@example.com',
      });
      expect(me.status).toBe(400);
      const { rows } = await pool.query('SELECT payout_email FROM publishers WHERE id = ANY($1)', [
        [a.publisherId, b.publisherId],
      ]);
      expect(rows.map((r) => r.payout_email)).toEqual([
        'payouts@example.com',
        'payouts@example.com',
      ]);
    });

    it('every route needs a session', async () => {
      const site = await newSite();
      const anon = [
        agent()
          .patch(`/api/sites/${site.id}/policy`)
          .set('Origin', APP_ORIGIN)
          .send({ decisions: { AI_AGENT: 'PASS' } }),
        agent()
          .post(`/api/sites/${site.id}/keys/rotate`)
          .set('Origin', APP_ORIGIN)
          .send({ kind: 'crawl' }),
      ];
      for (const res of await Promise.all(anon)) expect(res.status).toBe(401);
    });
  });
});
