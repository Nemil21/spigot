import type { Job } from './index.js';
import { defaultJobDeps } from './deps.js';
import { RETENTION_EVERY_MS, retentionSweep } from './sweeps.js';

/** Hourly: null `api_calls.response_body` after 24 h; delete `record_versions` after 30 days (SP-019). */
const job: Job = {
  name: 'retention-sweep',
  everyMs: RETENTION_EVERY_MS,
  async run() {
    const deps = defaultJobDeps();
    if (deps) await retentionSweep(deps);
  },
};

export default job;
