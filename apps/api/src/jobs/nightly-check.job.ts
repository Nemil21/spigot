import type { Job } from './index.js';
import { NIGHTLY_EVERY_MS, nightlyCheck, nightlySlot, scheduleJobDeps } from './schedule.js';

/**
 * SP-061: nightly (the 00:00 UTC tick), sitemap re-check of READY sites and the recorded ledger
 * check. A mismatch writes an ALERT audit row and turns `/admin/health` degraded. Its re-crawl
 * claims the 00:00 schedule slot, the one `crawl.schedule` also ticks at that moment.
 */
const job: Job = {
  name: 'nightly.check',
  everyMs: NIGHTLY_EVERY_MS,
  run: async (tick) => {
    const deps = scheduleJobDeps();
    if (deps)
      await nightlyCheck(deps, { slot: tick === undefined ? undefined : nightlySlot(tick) });
  },
};

export default job;
