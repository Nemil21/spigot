import type { Job } from './index.js';
import { defaultJobDeps } from './deps.js';
import { ABANDON_EVERY_MS, abandonStaleTopups } from './sweeps.js';

/** Every 5 min: AWAITING_APPROVAL ≥ 30 min → one `getOrder`, then credit or ABANDONED (SP-019). */
const job: Job = {
  name: 'topup-abandon-sweep',
  everyMs: ABANDON_EVERY_MS,
  async run() {
    const deps = defaultJobDeps();
    if (deps) await abandonStaleTopups(deps);
  },
};

export default job;
