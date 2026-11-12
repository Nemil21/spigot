import type { Job } from './index.js';
import { payoutJobDeps } from '../payouts/deps.js';
import { DAILY_MS, pollStaleBatches } from '../payouts/poll.js';

/**
 * SP-021: once a day, poll every payout batch still in flight after its 30-min window (PENDING /
 * PROCESSING, or with an UNCLAIMED item), so `UNCLAIMED → SUCCESS | RETURNED` resolves without
 * webhooks and a publisher with an UNCLAIMED item becomes eligible again.
 */
const job: Job = {
  name: 'payouts.daily',
  everyMs: DAILY_MS,
  run: async () => {
    await pollStaleBatches(payoutJobDeps());
  },
};

export default job;
