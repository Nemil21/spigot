// Self-check seam (SP-012a → SP-012b). The pipeline is fixed:
//   model output → Zod → PII / rights guard → selfCheck() → persist → `proposal.ready`
// so self-check always runs before anything is stored or announced. SP-012a ships the identity;
// SP-012b replaces this file with the 20-page check + `repair_fields` rounds (+ JSON-LD-only
// fallback), keeping the export name and signature.
import type { ExtractorSpec } from '@spigot/shared';
import type { Db } from '../db/index.js';
import type { SchemaModel, TokenUsage } from './claude.js';
import type { SampleStats, SamplePage } from './dryrun.js';
import type { GuardFlag, StoredField } from './pii.js';
import type { Proposal } from './tool.js';

/** A validated, guarded proposal on its way to `persist`. */
export interface CheckedProposal {
  proposal: Proposal;
  /** Parsed extractor spec (defaults applied): `schema_versions.extractor`. */
  spec: ExtractorSpec;
  fields: StoredField[];
  sampleStats: SampleStats;
  flags: GuardFlag[];
  /** Human-readable notes for the audit row (dropped fields, retries, …). */
  notes: string[];
}

export interface SelfCheckContext {
  db: Db;
  siteId: string;
  templateId: string;
  pageIds: readonly string[];
  samples: readonly SamplePage[];
  jsonldTypes: readonly string[];
  model: SchemaModel;
  /** Call once per extra model call (keeps `crawl_runs.ai_calls` exact). */
  recordModelCall(usage: TokenUsage): Promise<void>;
}

export async function selfCheck(
  checked: CheckedProposal,
  _ctx: SelfCheckContext,
): Promise<CheckedProposal> {
  return checked;
}
