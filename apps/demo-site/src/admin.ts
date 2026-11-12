import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { MutationError, parseMutateOptions, type MutateEntry } from './data/mutations.js';
import type { Store } from './data/store.js';

export interface AdminOptions {
  store: Store;
  /** DEMO_ADMIN_TOKEN. createApp doesn't mount this router when it's unset (every /admin path is a 404). */
  token: string;
}

/** What `POST /admin/mutate` and the CLI print: the slugs changed, plus every page whose lastmod moved. */
export function mutateSummary(entry: MutateEntry) {
  return {
    label: 'demo mutation',
    at: entry.at,
    seed: entry.seed,
    focus: entry.focus,
    prices: entry.prices,
    leased: entry.leased,
    added: entry.added.map((l) => l.slug),
    touched: entry.touched,
  };
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/**
 * Demo-site admin endpoints (SP-004b), `Authorization: Bearer $DEMO_ADMIN_TOKEN`:
 * `POST /admin/mutate`, `POST /admin/reset`, `GET /admin/state`. Mounted before spigot-gate so
 * the CLI (a non-browser UA) is never sent a 402; robots.txt already disallows /admin.
 */
export function createAdminRouter({ store, token }: AdminOptions): Router {
  const expected = sha256(token);
  const router = Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
    // Compare fixed-length digests so the check is constant-time whatever the input length.
    if (!m || !timingSafeEqual(sha256(m[1]!.trim()), expected)) {
      res.set('WWW-Authenticate', 'Bearer realm="bluebonnet-admin"');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.use(express.json({ limit: '4kb' }));

  router.post('/mutate', async (req, res) => {
    const opts = parseMutateOptions((req.body ?? {}) as Record<string, unknown>);
    const entry = await store.mutate(opts);
    res.json({ ...mutateSummary(entry), ping: opts.ping ? 'not implemented until SP-055' : undefined, counts: store.counts() });
  });

  router.post('/reset', async (_req, res) => {
    const entry = await store.reset();
    res.json({ at: entry.at, reverted: entry.reverted, removed: entry.removed, counts: store.counts() });
  });

  router.get('/state', (_req, res) => {
    res.json(store.state());
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof MutationError) return void res.status(400).json({ error: 'bad_request', message: err.message });
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
      return void res.status(400).json({ error: 'bad_request', message: 'body is not valid JSON' });
    }
    next(err);
  });

  return router;
}
