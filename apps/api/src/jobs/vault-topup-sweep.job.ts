import type { Job } from './index.js';
import { defaultJobDeps } from './deps.js';
import { sweepOrphanedVaultTopups, VAULT_SWEEP_EVERY_MS } from './vaultTopupSweep.js';

/** Every 30 s: VAULT_MIT top-ups CREATED ≥ 30 s → replay the create (same request id) → credit or FAILED (SP-047c). */
const job: Job = {
  name: 'vault-topup-sweep',
  everyMs: VAULT_SWEEP_EVERY_MS,
  async run() {
    const deps = defaultJobDeps();
    if (deps) await sweepOrphanedVaultTopups(deps);
  },
};

export default job;
