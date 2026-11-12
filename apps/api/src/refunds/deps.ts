import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { defaultJobDeps } from '../jobs/deps.js';
import { createPayPalClient, type MoneyOutClient } from '../paypal/index.js';

/**
 * The PayPal refunds client and db SP-049's route and sweep use. One client per config
 * (`PAYPAL_MODE=stub` → the process-wide FakePayPal, so captures made by top-ups are refundable).
 * Jobs get no arguments from the loader, so they take SP-019's `defaultJobDeps()` (off under vitest
 * until a test calls `setRefundDeps`). Tests swap both with `setRefundDeps`.
 */
export type RefundsPayPal = Pick<MoneyOutClient, 'refundCapture' | 'getRefund'>;

export interface RefundDeps {
  db: Db;
  pp: RefundsPayPal;
  /** Clock for the sweep's age cut-off and the 180-day window. Default `Date.now`. */
  now?: () => number;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

let override: RefundDeps | undefined;
let overridePp: RefundsPayPal | undefined;
const clients = new WeakMap<Config, RefundsPayPal>();

export function refundPayPal(config: Config): RefundsPayPal {
  if (overridePp) return overridePp;
  let pp = clients.get(config);
  if (!pp) {
    pp = createPayPalClient(config);
    clients.set(config, pp);
  }
  return pp;
}

/** Deps for `jobs/refund-sweep.job.ts`, or `null` when jobs are off. */
export function refundJobDeps(): RefundDeps | null {
  if (override) return override;
  const deps = defaultJobDeps();
  return deps && { db: deps.db, pp: refundPayPal(deps.config) };
}

/** Tests: use `deps` for the sweep, and `deps.pp` for routes (`undefined` restores the defaults). */
export function setRefundDeps(deps: RefundDeps | undefined): void {
  override = deps;
  overridePp = deps?.pp;
}

export function nowOf(deps: Pick<RefundDeps, 'now'>): number {
  return deps.now ? deps.now() : Date.now();
}
