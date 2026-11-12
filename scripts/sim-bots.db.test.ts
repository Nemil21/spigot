// SP-037 acceptance: a 7-day SIM backfill through the real `POST /api/gate/hits` (SP-008b's
// 1 MB body limit, schema and 1-post-per-5-s rate limiter, real clock) completes in under a
// minute with no 429, and lands in `bot_hits` as SIM rows only.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config.js';
import { testDatabaseUrl, twoPools, type TwoPools } from '../apps/api/src/db/test-db.js';
import { buildServer } from '../apps/api/src/server.js';
import { generateSiteSecrets } from '../apps/api/src/sites/keys.js';
import { REQUIRED_ENV } from '../apps/api/src/test/env.js';
import {
  DEFAULT_DECISIONS,
  assertValidBatches,
  buildAgents,
  buildBackfill,
  fetchDecisions,
  mulberry32,
  packBatches,
  parseDuration,
  postBatches,
} from './sim-bots.lib.js';

describe.skipIf(!testDatabaseUrl)(
  'sim:bots --backfill 7d against the real gate-hits endpoint',
  () => {
    let pools: TwoPools;
    let app: FastifyInstance;
    let apiBase: string;
    let siteId: string;
    let gateKey: string;

    beforeAll(async () => {
      pools = await twoPools();
      app = await buildServer(loadConfig({ ...REQUIRED_ENV, DATABASE_URL: pools.db.url }), {
        logStream: new Writable({ write: (_c, _e, cb) => cb() }),
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

      const signup = await fetch(`${apiBase}/api/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: REQUIRED_ENV.APP_BASE_URL! },
        body: JSON.stringify({
          name: 'Bluebonnet',
          email: `p-${randomUUID()}@example.com`,
          password: 'correct horse',
          payoutEmail: 'payouts@example.com',
        }),
      });
      expect(signup.status).toBe(201);
      const { publisherId } = (await signup.json()) as { publisherId: string };
      siteId = randomUUID();
      const s = generateSiteSecrets(siteId, REQUIRED_ENV.SESSION_SECRET!);
      gateKey = s.gateKey;
      await pools.a.query(
        `INSERT INTO sites (id, publisher_id, origin, slug, verify_token, crawl_key_hash, gate_key_hash,
                          status, policy)
       VALUES ($1, $2, 'https://bluebonnet.example.com', $3, $4, $5, $6, 'READY',
               '{"SEARCH":"PASS","AI_TRAINING":"QUOTE","AI_AGENT":"QUOTE","SCRAPER_TOOL":"QUOTE","UNKNOWN":"PASS","gated_paths":[]}')`,
        [
          siteId,
          publisherId,
          `site-${siteId.slice(0, 8)}`,
          s.verifyToken,
          s.crawlKeyHash,
          s.gateKeyHash,
        ],
      );
    });
    afterAll(async () => {
      await app?.close();
      await pools?.close();
    });

    it(
      'posts a week of SIM buckets in under a minute with no 429',
      { timeout: 90_000 },
      async () => {
        expect(await fetchDecisions(apiBase, gateKey)).toEqual(DEFAULT_DECISIONS);

        const now = Date.now();
        const buckets = buildBackfill({
          agents: buildAgents(mulberry32(1), [2, 5], 60),
          now,
          durationMs: parseDuration('7d'),
          stepMinutes: 10,
          decisions: DEFAULT_DECISIONS,
          rng: mulberry32(2),
        });
        const batches = packBatches(buckets, new Date(now).toISOString());
        assertValidBatches(batches);
        expect(batches.length).toBeGreaterThan(1); // exercises the 5-s spacing for real

        const t0 = Date.now();
        const r = await postBatches(batches, { apiBase, gateKey, maxRetries: 0 });
        expect(Date.now() - t0).toBeLessThan(60_000);
        expect(r).toMatchObject({ posts: batches.length, buckets: buckets.length, rateLimited: 0 });

        const { rows } = await pools.a.query<{ sim: boolean; n: number; hits: number }>(
          `SELECT is_simulated AS sim, count(*) AS n, sum(hits) AS hits
         FROM bot_hits WHERE site_id = $1 GROUP BY is_simulated`,
          [siteId],
        );
        expect(rows.map((r) => ({ sim: r.sim, n: Number(r.n), hits: Number(r.hits) }))).toEqual([
          { sim: true, n: buckets.length, hits: buckets.reduce((n, b) => n + b.hits, 0) },
        ]);
      },
    );
  },
);
