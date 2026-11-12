import type { Job } from './index.js';
import { payoutJobDeps } from '../payouts/deps.js';
import { runWeeklyPayout, WEEKLY_EVERY_MS } from '../payouts/weekly.js';

/**
 * SP-060: every 5 min, check for this week's Monday 09:00 PT payout and run it once
 * (`payoutRun('SCHEDULE')`, unique per `period_end`; see `payouts/weekly.ts`).
 */
const job: Job = {
  name: 'payouts.weekly',
  everyMs: WEEKLY_EVERY_MS,
  run: async () => {
    const deps = payoutJobDeps();
    if (deps) await runWeeklyPayout(deps);
  },
};

export default job;
