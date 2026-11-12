import type pg from 'pg';
import { loadConfig, type Config } from '../config.js';
import { createPool } from '../db/pool.js';
import { createPayPalClient, type MoneyOutClient } from '../paypal/index.js';

/**
 * The PayPal payouts client and pool SP-021's routes and jobs use. One client per config
 * (`PAYPAL_MODE=stub` → the process-wide FakePayPal, shared with seeds and run-now). Jobs get no
 * arguments from the loader, so they build their own small pool from `process.env` on first use.
 * Tests swap both with `setPayoutDeps`.
 */
export type PayoutsPayPal = Pick<MoneyOutClient, 'payout' | 'getPayoutBatch'>;

export interface PayoutDeps {
  pool: pg.Pool;
  pp: PayoutsPayPal;
}

let override: PayoutDeps | undefined;
let overridePp: PayoutsPayPal | undefined;
const clients = new WeakMap<Config, PayoutsPayPal>();
let jobDeps: PayoutDeps | undefined;

export function payoutPayPal(config: Config): PayoutsPayPal {
  if (overridePp) return overridePp;
  let pp = clients.get(config);
  if (!pp) {
    pp = createPayPalClient(config);
    clients.set(config, pp);
  }
  return pp;
}

/** Deps for background jobs (`jobs/payout-*.job.ts`). */
export function payoutJobDeps(): PayoutDeps {
  if (override) return override;
  if (!jobDeps) {
    const config = loadConfig(process.env);
    jobDeps = {
      pool: createPool(config.DATABASE_URL, { max: 2, applicationName: 'spigot-payout-poll' }),
      pp: payoutPayPal(config),
    };
  }
  return jobDeps;
}

/** Tests: use `deps` for jobs, and `deps.pp` for routes (`undefined` restores the defaults). */
export function setPayoutDeps(deps: PayoutDeps | undefined): void {
  override = deps;
  overridePp = deps?.pp;
}
