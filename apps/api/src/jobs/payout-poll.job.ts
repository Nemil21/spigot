import type { Job } from './index.js';
import { payoutJobDeps } from '../payouts/deps.js';
import { POLL_EVERY_MS, pollRecentBatches } from '../payouts/poll.js';

/**
 * SP-021: poll each PENDING / PROCESSING payout batch every 60 s for 30 min after submit
 * (`pp.getPayoutBatch`), so W09's pill flips Sent → Paid out without webhooks.
 */
const job: Job = {
  name: 'payouts.poll',
  everyMs: POLL_EVERY_MS,
  run: async () => {
    const deps = payoutJobDeps();
    if (deps) await pollRecentBatches(deps);
  },
};

export default job;
