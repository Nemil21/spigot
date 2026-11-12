import type { Job } from './index.js';
import { defaultJobDeps } from './deps.js';
import { POLL_EVERY_MS, pollOpenTopups } from './topupPoller.js';

/** Every 30 s: AWAITING_APPROVAL top-ups under 30 min old → `getOrder` → capture / credit (SP-019). */
const job: Job = {
  name: 'topup-poller',
  everyMs: POLL_EVERY_MS,
  async run() {
    const deps = defaultJobDeps();
    if (deps) await pollOpenTopups(deps);
  },
};

export default job;
