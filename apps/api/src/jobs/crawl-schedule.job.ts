import type { Job } from './index.js';
import { RECRAWL_EVERY_MS, recrawlReadySites, scheduleJobDeps } from './schedule.js';

/**
 * SP-061: every 15 min, a `trigger=SCHEDULE` crawl of each READY site (changed URLs only; skipped
 * while a run is live). The tick only starts the runs; they finish on their own.
 */
const job: Job = {
  name: 'crawl.schedule',
  everyMs: RECRAWL_EVERY_MS,
  run: async () => {
    const deps = scheduleJobDeps();
    if (deps) await recrawlReadySites(deps);
  },
};

export default job;
