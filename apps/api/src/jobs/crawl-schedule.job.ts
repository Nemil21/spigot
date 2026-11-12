import type { Job } from './index.js';
import { RECRAWL_EVERY_MS, recrawlReadySites, scheduleJobDeps } from './schedule.js';

/**
 * SP-061: every 15 min, a `trigger=SCHEDULE` crawl of each READY site (changed URLs only; skipped
 * while a run is live). The tick only starts the runs; they finish on their own. The tick is the
 * schedule slot: one SCHEDULE run per site per slot, however many processes or jobs scan it.
 */
const job: Job = {
  name: 'crawl.schedule',
  everyMs: RECRAWL_EVERY_MS,
  run: async (tick) => {
    const deps = scheduleJobDeps();
    if (deps) await recrawlReadySites(deps, { slot: tick });
  },
};

export default job;
