import { MissingFeatureConfigError, type Config } from '../config.js';
import { triageModelFor, triagePending, type TriageModel } from '../claims/triage.js';
import type { Job } from './index.js';
import { defaultJobDeps } from './deps.js';

/**
 * SP-048b: every 15 s, give up to 5 OPEN claims without a recommendation one `recommend` call
 * each (`claims/triage.ts`). Failed tries are retried after 2 min, 3 tries at most; after that the
 * publisher decides without one. Writes only `claims.ai_recommendation`; never moves money.
 * Live mode without `ANTHROPIC_API_KEY`: the job does nothing (claims are decided without a
 * recommendation) rather than failing every tick.
 */
export const TRIAGE_EVERY_MS = 15_000;

const models = new WeakMap<Config, TriageModel | null>();

function modelFor(config: Config): TriageModel | null {
  if (!models.has(config)) {
    try {
      models.set(config, triageModelFor(config));
    } catch (err) {
      if (!(err instanceof MissingFeatureConfigError)) throw err;
      models.set(config, null);
    }
  }
  return models.get(config) ?? null;
}

const job: Job = {
  name: 'claims-triage',
  everyMs: TRIAGE_EVERY_MS,
  run: async () => {
    const deps = defaultJobDeps();
    if (!deps) return;
    const model = modelFor(deps.config);
    if (model) await triagePending({ db: deps.db, model });
  },
};

export default job;
