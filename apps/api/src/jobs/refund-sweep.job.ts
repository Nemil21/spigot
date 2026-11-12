import type { Job } from './index.js';
import { refundJobDeps } from '../refunds/deps.js';
import { SWEEP_EVERY_MS, sweepRefunds } from '../refunds/refund.js';

/**
 * SP-049: every 60 s, replay REQUESTED refunds older than 1 min with the same request id, poll
 * PENDING ones with `pp.getRefund`, and post any missing `REFUND_REVERSAL` for FAILED ones.
 */
const job: Job = {
  name: 'refunds.sweep',
  everyMs: SWEEP_EVERY_MS,
  run: async () => {
    const deps = refundJobDeps();
    if (deps) await sweepRefunds(deps);
  },
};

export default job;
