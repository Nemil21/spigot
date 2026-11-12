// SP-052b: every 60 s, re-infer LIVE_STALE datasets that have no re-proposal and no attempt in
// the last 5 minutes (≤ 12 attempts a day each). Covers a crash mid-run, a model outage, and drift
// the post-run backstop found after the crawl hook ran. Logic in schema-agent/reinfer.ts.
import { reinferStale } from '../schema-agent/reinfer.js';
import { schemaAgentRuntime } from '../schema-agent/runtime.js';
import type { Job } from './index.js';

const job: Job = {
  name: 'schema-agent-reinfer',
  everyMs: 60_000,
  async run() {
    const rt = schemaAgentRuntime();
    if (!rt) return;
    for (const r of await reinferStale(rt.deps(), { trigger: 'SWEEP' })) {
      if (r.status === 'busy' || r.status === 'existing') continue;
      rt.log.info(
        { datasetId: r.datasetId, status: r.status, modelCalls: r.modelCalls, reason: r.reason },
        'schema agent: re-inference sweep',
      );
    }
  },
};

export default job;
