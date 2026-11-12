// Resumable trigger (SP-012a). The discovery hook runs in-process after the crawl commits, so a
// process killed between "site PROPOSING" and "proposal written" would leave the site stuck.
// Every 60 s this job finds PROPOSING sites (and READY sites whose last run left templates
// failed) with no proposal run started in the last 5 minutes and runs the proposal again. Re-runs are cheap: templates that already have a dataset are
// skipped (no second model call), so it also finishes a run that died half-way.
// Registered by `jobs/schema-agent-resume.job.ts` (the job loader only scans `jobs/`).
import type { Queryable } from '../db/index.js';
import type { Job } from '../jobs/index.js';
import { proposeForSite, type ProposeDeps, type ProposeResult } from './propose.js';
import { logResult, schemaAgentRuntime } from './runtime.js';

export const RESUME_EVERY_MS = 60_000;
/** A run started more recently than this may still be going (or the model is down): wait. */
export const RESUME_QUIET_MS = 5 * 60_000;
const MAX_SITES_PER_TICK = 10;
export const MAX_READY_RETRIES_PER_DAY = 12;

export async function findResumableSites(
  q: Queryable,
  quietMs: number = RESUME_QUIET_MS,
): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT s.id FROM sites s
      WHERE (
          s.status = 'PROPOSING'
          -- READY, but the last run left templates failed (model outage): fill them in, at most
          -- MAX_READY_RETRIES_PER_DAY times a day so a template that always errors can't loop.
          OR (s.status = 'READY'
              AND (SELECT a.data FROM audit_events a
                    WHERE a.entity = 'sites' AND a.entity_id = s.id
                      AND a.action = 'SCHEMA_PROPOSAL_DONE'
                    ORDER BY a.id DESC LIMIT 1) @> '{"templates":[{"status":"failed"}]}'
              AND (SELECT count(*) FROM audit_events a
                    WHERE a.entity = 'sites' AND a.entity_id = s.id
                      AND a.action = 'SCHEMA_PROPOSAL_STARTED'
                      AND a.at > now() - interval '1 day') < $3))
        AND NOT EXISTS (
          SELECT 1 FROM audit_events a
           WHERE a.entity = 'sites' AND a.entity_id = s.id
             AND a.action = 'SCHEMA_PROPOSAL_STARTED'
             AND a.at > now() - make_interval(secs => $1::double precision / 1000))
      ORDER BY s.updated_at
      LIMIT $2`,
    [quietMs, MAX_SITES_PER_TICK, MAX_READY_RETRIES_PER_DAY],
  );
  return rows.map((r) => r.id);
}

/** One resume pass: propose for every stuck site, one at a time. */
export async function resumeProposals(
  deps: ProposeDeps,
  quietMs: number = RESUME_QUIET_MS,
): Promise<ProposeResult[]> {
  const out: ProposeResult[] = [];
  for (const siteId of await findResumableSites(deps.db.pool, quietMs)) {
    out.push(await proposeForSite(deps, siteId, { trigger: 'RESUME' }));
  }
  return out;
}

const job: Job = {
  name: 'schema-agent-resume',
  everyMs: RESUME_EVERY_MS,
  async run() {
    const rt = schemaAgentRuntime();
    if (!rt) return;
    for (const r of await resumeProposals(rt.deps())) logResult(rt.log, r);
  },
};

export default job;
