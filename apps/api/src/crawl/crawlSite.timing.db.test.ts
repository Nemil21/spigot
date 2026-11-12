import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAccessLog } from '../../../demo-site/src/accessLog.js';
import { createApp } from '../../../demo-site/src/app.js';
import { openStore } from '../../../demo-site/src/data/store.js';
import { createDb } from '../db/index.js';
import { twoPools, testDatabaseUrl } from '../db/test-db.js';
import { crawlSite } from './crawlSite.js';
import { resetHostQueues } from './queue.js';

/**
 * SP-009a2's local timing check (run once, numbers go in the PR; CI skips it):
 *   CRAWL_TIMING=1 [CRAWL_TIMING_OUT=/tmp/timing.txt] npx vitest run --project db apps/api/src/crawl/crawlSite.timing.db.test.ts
 * Full-size demo site (DEMO_SEED_SCALE=1, ~2,480 pages), CRAWL_MIN_GAP_MS=25 (the gap for a
 * verified origin running our gate). Target: the discovery crawl finishes in < 4 min.
 */
describe.skipIf(!testDatabaseUrl || process.env.CRAWL_TIMING !== '1')(
  'crawl timing (full demo site)',
  () => {
    it('discovery crawl of ~2,480 pages at a 25 ms gap finishes in < 4 min with ≤ 2 in flight', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'spigot-crawl-timing-'));
      const pools = await twoPools();
      const log = createAccessLog(() => {});
      const app = createApp({ store: await openStore({ dataDir, scale: 1 }), accessLog: log });
      const server = createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resetHostQueues();
      try {
        const pub = await pools.a.query<{ id: string }>(
          `INSERT INTO publishers (name, email, payout_email) VALUES ('P', 'p@x.test', 'p@x.test') RETURNING id`,
        );
        const site = await pools.a.query<{ id: string }>(
          `INSERT INTO sites (publisher_id, origin, verify_token, crawl_key_hash, gate_key_hash, status)
         VALUES ($1, $2, 'v', 'c', 'g', 'VERIFIED') RETURNING id`,
          [pub.rows[0]!.id, origin],
        );

        const t0 = performance.now();
        const result = await crawlSite(
          { siteId: site.rows[0]!.id, trigger: 'CONNECT' },
          {
            db: createDb(pools.a),
            crawlSecret: 'timing-secret'.padEnd(32, 'x'),
            allowLocal: true,
            appBaseUrl: 'http://localhost:3000',
            minGapMs: 25,
          },
        );
        const seconds = (performance.now() - t0) / 1000;
        const stats = log.stats();
        const line =
          `SP-009a2 timing: ${result.counters.pages_total} pages, status ${result.status}, ` +
          `${seconds.toFixed(1)} s, ${(result.counters.pages_total / seconds).toFixed(1)} pages/s, ` +
          `max in flight ${stats.maxInFlight}, requests ${stats.total}`;
        console.log(line);
        if (process.env.CRAWL_TIMING_OUT)
          await writeFile(process.env.CRAWL_TIMING_OUT, `${line}\n`);
        expect(result.status).toBe('SUCCEEDED');
        expect(result.discovery).toBe(true);
        expect(result.counters.pages_fetched).toBe(result.counters.pages_total);
        expect(result.counters.pages_total).toBeGreaterThan(2_400);
        expect(stats.maxInFlight).toBeLessThanOrEqual(2);
        expect(seconds).toBeLessThan(240);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        await pools.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
