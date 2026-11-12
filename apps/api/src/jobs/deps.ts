import { loadConfig, type Config } from '../config.js';
import { createDb, createPool, type Db } from '../db/index.js';
import type { PayPalOrdersClient } from '../paypal/index.js';
import { topupPayPal } from '../topups/deps.js';

/**
 * What the money / retention jobs need (SP-019). `jobs/*.job.ts` files are started by `main.ts`
 * with no arguments, so they get `defaultJobDeps()`: the process config and one small pool of their
 * own (like `defaultCrawlDeps()`). The PayPal client is `topupPayPal(config)`, the same one the
 * top-up endpoints use (`PAYPAL_MODE=stub` → the shared FakePayPal).
 *
 * Jobs are off in tests unless enabled: under vitest a job's `run` does nothing until a test
 * injects deps with `setJobDeps` (so no test ever reaches `DATABASE_URL` from the environment).
 */
export interface JobDeps {
  db: Db;
  config: Config;
  pp: PayPalOrdersClient;
  /** Clock for age cut-offs (tests use fake timers). Default `Date.now`. */
  now?: () => number;
}

let override: JobDeps | undefined;
let cached: { db: Db; config: Config } | undefined;

/** The deps for a job tick, or `null` when jobs are off (vitest without `setJobDeps`). */
export function defaultJobDeps(
  env: Record<string, string | undefined> = process.env,
): JobDeps | null {
  if (override) return override;
  if (env.VITEST) return null;
  if (!cached) {
    const config = loadConfig(env);
    const pool = createPool(config.DATABASE_URL, { max: 2, applicationName: 'spigot-jobs-work' });
    cached = { db: createDb(pool), config };
  }
  return { ...cached, pp: topupPayPal(cached.config) };
}

/** Tests: enable the jobs against `deps` (`undefined` turns them off again). */
export function setJobDeps(deps: JobDeps | undefined): void {
  override = deps;
}

export function nowOf(deps: Pick<JobDeps, 'now'>): number {
  return deps.now ? deps.now() : Date.now();
}
