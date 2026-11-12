// Wires the schema agent into the API process (SP-012a): `plugins/60-schema-agent.ts` calls
// `startSchemaAgent` at boot, which subscribes to the crawler's `onDiscoveryDone` hook (SP-009a2)
// and makes the deps available to the resume job (`resume.job.ts`). Without a started runtime
// (unit tests, a process that never built the app) the hook isn't registered and the job no-ops.
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { defaultCrawlDeps } from '../crawl/deps.js';
import { onDiscoveryDone } from '../crawl/hooks.js';
import { prepareTemplateRender } from '../crawl/render.js';
import type { Db } from '../db/index.js';
import { schemaModelFor, type SchemaModel } from './claude.js';
import { proposeForSite, type ProposeDeps, type ProposeResult } from './propose.js';

type Log = Pick<FastifyBaseLogger, 'info' | 'error'>;

export interface SchemaAgentRuntime {
  deps(): ProposeDeps;
  log: Log;
}

let current: SchemaAgentRuntime | null = null;

export function schemaAgentRuntime(): SchemaAgentRuntime | null {
  return current;
}

export interface StartOptions {
  db: Db;
  config: Config;
  log: Log;
  /** Tests inject a model; otherwise `SCHEMA_AGENT_MODE` picks recorded or live (lazily). */
  model?: SchemaModel;
}

export function logResult(log: Log, r: ProposeResult): void {
  if (r.status !== 'done') return;
  log.info(
    {
      siteId: r.siteId,
      runId: r.runId,
      proposals: r.proposals,
      aiCalls: r.aiCalls,
      siteStatus: r.siteStatus,
      templates: r.templates.map((t) => `${t.pathPattern}:${t.status}`),
    },
    'schema agent: proposal run finished',
  );
}

/** Register the discovery hook and the job runtime. Returns a stop function (onClose). */
export function startSchemaAgent(opts: StartOptions): () => void {
  let model = opts.model;
  const runtime: SchemaAgentRuntime = {
    // Lazy: a live-mode process without an AI key (Anthropic or OpenAI) still boots; proposing throws then.
    deps: () => ({
      db: opts.db,
      model: (model ??= schemaModelFor(opts.config)),
      prepareRender:
        opts.config.CRAWL_RENDER === 'browser'
          ? (templateId) => prepareTemplateRender(defaultCrawlDeps(), templateId)
          : undefined,
    }),
    log: opts.log,
  };
  current = runtime;
  const unsubscribe = onDiscoveryDone(async (siteId, runId) => {
    const result = await proposeForSite(runtime.deps(), siteId, { trigger: 'DISCOVERY', runId });
    logResult(opts.log, result);
  });
  return () => {
    unsubscribe();
    if (current === runtime) current = null;
  };
}
