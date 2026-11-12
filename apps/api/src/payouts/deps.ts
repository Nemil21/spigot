import type pg from 'pg';
import type { Config } from '../config.js';
import { defaultJobDeps } from '../jobs/deps.js';
import { createPayPalClient, type MoneyOutClient } from '../paypal/index.js';

/**
 * The PayPal payouts client and pool SP-021's routes and jobs use. One client per config
 * (`PAYPAL_MODE=stub` → the process-wide FakePayPal, shared with seeds and run-now). Jobs get no
 * arguments from the loader, so they take SP-019's `defaultJobDeps()` (its pool and config; off
 * under vitest until `setJobDeps`). Tests swap both with `setPayoutDeps`.
 */
export type PayoutsPayPal = Pick<MoneyOutClient, 'payout' | 'getPayoutBatch'>;

export interface PayoutDeps {
  pool: pg.Pool;
  pp: PayoutsPayPal;
}

let override: PayoutDeps | undefined;
let overridePp: PayoutsPayPal | undefined;
const clients = new WeakMap<Config, PayoutsPayPal>();

export function payoutPayPal(config: Config): PayoutsPayPal {
  if (overridePp) return overridePp;
  let pp = clients.get(config);
  if (!pp) {
    pp = createPayPalClient(config);
    clients.set(config, pp);
  }
  return pp;
}

/** Deps for background jobs (`jobs/payout-*.job.ts`), or `null` when jobs are off. */
export function payoutJobDeps(): PayoutDeps | null {
  if (override) return override;
  const deps = defaultJobDeps();
  return deps && { pool: deps.db.pool, pp: payoutPayPal(deps.config) };
}

/** Tests: use `deps` for jobs, and `deps.pp` for routes (`undefined` restores the defaults). */
export function setPayoutDeps(deps: PayoutDeps | undefined): void {
  override = deps;
  overridePp = deps?.pp;
}
