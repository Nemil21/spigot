import type { FastifyPluginAsync } from 'fastify';
import type { CrawlDeps } from '../crawl/deps.js';
import { authenticateCrawlKey, PING_BODY_LIMIT, pingBody, requestPing } from '../crawl/pingApi.js';
import { parse } from '../http/errors.js';
import { enforceRate } from '../http/rateLimit.js';
import { handOffToWorkflows } from '../workflows/dispatch.js';

/**
 * CMS ping (SP-055; api.md §`POST /api/sites/:id/ping`). Crawl-key auth only (`Bearer ck_…`),
 * never a cookie, so CSRF doesn't apply.
 *
 * `POST /api/sites/:id/ping` `{ urls: [...] }` (≤ 500, on the site's origin) → `202
 * { crawlRunId, workflowRunId, joined, urls }`. 1 ping / 10 s / site (`429 RATE_LIMITED`); a
 * site that isn't READY → 409 (PENDING_VERIFY → 403). The URLs join the site's live run, or start
 * a PING run that fetches only them (crawl/ping.ts).
 */

/** How long `app.close()` waits for in-process PING runs to stop after aborting them. */
const CLOSE_WAIT_MS = 5_000;

const pingRoutes: FastifyPluginAsync = async (app) => {
  const abort = new AbortController();
  const crawlDeps: CrawlDeps = {
    db: app.db,
    crawlSecret: app.config.SESSION_SECRET,
    allowLocal: app.config.ALLOW_LOCAL_ORIGINS,
    appBaseUrl: app.config.APP_BASE_URL,
    // Same rule as routes/crawl.ts: only an explicit CRAWL_MIN_GAP_MS overrides the adaptive gap.
    minGapMs: process.env.CRAWL_MIN_GAP_MS?.trim() ? app.config.CRAWL_MIN_GAP_MS : undefined,
    signal: abort.signal,
    // SP-041a: WORKFLOWS_MODE=workflows starts a new PING run on Render Workflows.
    handOff: (args) => handOffToWorkflows('crawlSite', args, { db: app.db, log: app.log }),
  };
  const running = new Set<Promise<unknown>>();
  const track = (done: Promise<unknown>) => {
    const p = done.catch(() => {}).finally(() => running.delete(p));
    running.add(p);
  };

  app.addHook('onClose', async () => {
    // Stop runs where they are; queued pings stay for the run that adopts them.
    abort.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...running]),
      new Promise((r) => {
        timer = setTimeout(r, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  });

  app.post<{ Params: { id: string } }>(
    '/api/sites/:id/ping',
    { bodyLimit: PING_BODY_LIMIT, config: { csrf: false } },
    async (req, reply) => {
      const site = await authenticateCrawlKey(
        app.db.pool,
        req.headers.authorization,
        req.params.id,
      );
      enforceRate(reply, app.rateLimiter.take('ping', site.id));
      const body = parse(pingBody, req.body, 'ping');
      const accepted = await requestPing(crawlDeps, site, body, track);
      return reply.code(202).send(accepted);
    },
  );
};

export default pingRoutes;
