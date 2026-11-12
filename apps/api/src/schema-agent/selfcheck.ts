// Self-check and repair (SP-012b; features/04 §4). The pipeline is fixed:
//   model output → Zod → dry run → PII / rights guard → selfCheck() → persist → `proposal.ready`
// so nothing is stored or announced before the extractor has been run on pages the model never saw.
//
//  1. Run the extractor on 20 pages of the template: the ≤ 5 samples the model saw + 15 unseen
//     (spread evenly over the template's pages, so the pick is deterministic).
//  2. Per field: null rate, type conformance (the source matched but the value didn't coerce),
//     distinct values → `sample_stats`.
//  3. A required field empty on > 5% of pages, or any field on > 30% → one `repair_fields` call
//     with every failing field, its values found and 3 failing pages. A patch is kept per field
//     only if it lowers that field's null rate. Max 2 rounds (≤ 2 extra model calls).
//  4. Fields still failing are dropped, with a note in `ai_rationale`; no field left → rejected.
//  5. The PII / rights guard runs again on all 20 pages (it can only hide more, never show).
import {
  compileExtractor,
  ExtractorSpecError,
  type ExtractorField,
  type ExtractorSpec,
  type FieldValue,
} from '@spigot/shared';
import { ZodError } from 'zod';
import { re2Engine } from '../extract/adapters.js';
import {
  RecordedProposalMissingError,
  ZERO_USAGE,
  type SchemaModel,
  type TokenUsage,
} from './claude.js';
import { dryRun, type DryRun, type SampleStats, type SamplePage } from './dryrun.js';
import { guardFields, type GuardFlag, type StoredField } from './pii.js';
import {
  applyPatches,
  buildRepairPrompt,
  MAX_REPAIR_ROUNDS,
  parseRepair,
  type FailingField,
  type RepairPatch,
} from './repair.js';
import type { Proposal } from './tool.js';

export const SELFCHECK_PAGES = 20;
/** A required field may be empty on at most 5% of checked pages, any field on 30%. */
export const REQUIRED_MAX_NULL_RATE = 0.05;
export const ANY_MAX_NULL_RATE = 0.3;

export interface FieldCheckStats {
  nullRate: number;
  /** Of the pages where the source matched something, the share that coerced to the type. */
  typeConformance: number;
  distinct: number;
  /** One non-null value (omitted for fields the guard hides). */
  example?: FieldValue;
}

export interface DroppedField {
  name: string;
  nullRate: number;
  reason: string;
}

/** `schema_versions.sample_stats` after the self-check (data-model: "the 20-page check"). */
export interface SelfCheckStats {
  source: 'selfcheck';
  sampled: number;
  seen: number;
  unseen: number;
  recordRate: number;
  repairRounds: number;
  repaired: string[];
  dropped: DroppedField[];
  fields: Record<string, FieldCheckStats>;
}

/** A validated, guarded proposal on its way to `persist`. */
export interface CheckedProposal {
  proposal: Proposal;
  /** Parsed extractor spec (defaults applied): `schema_versions.extractor`. */
  spec: ExtractorSpec;
  fields: StoredField[];
  sampleStats: SampleStats | SelfCheckStats;
  flags: GuardFlag[];
  /** Human-readable notes for the audit row (dropped fields, retries, …). */
  notes: string[];
}

export interface SelfCheckContext {
  pathPattern: string;
  /** Every page of the template (unseen pages are picked from these). */
  pageIds: readonly string[];
  /** The pages the model saw. */
  samples: readonly SamplePage[];
  jsonldTypes: readonly string[];
  /** Latest snapshot HTML of these pages (missing ones are skipped). */
  loadPages(ids: readonly string[]): Promise<SamplePage[]>;
  /** `null`: no repair rounds (the JSON-LD-only auto-schema runs while the model is down). */
  model: SchemaModel | null;
  /** Call once per extra model call (keeps `crawl_runs.ai_calls` exact). */
  recordModelCall(usage: TokenUsage): Promise<void>;
}

/** Every field failed the check (or was dropped): there is nothing left to propose. */
export class SelfCheckRejectedError extends Error {
  override name = 'SelfCheckRejectedError';
}

/** `n` ids spread evenly over the sorted unseen ids (deterministic, covers the whole template). */
export function pickUnseen(
  pageIds: readonly string[],
  seen: ReadonlySet<string>,
  n: number,
): string[] {
  const rest = [...new Set(pageIds)].filter((id) => !seen.has(id)).sort();
  if (rest.length <= n) return rest;
  return Array.from({ length: n }, (_, i) => rest[Math.floor((i * rest.length) / n)]!);
}

// --- measuring ---------------------------------------------------------------------------------

interface Measured {
  run: DryRun;
  fields: Record<string, FieldCheckStats>;
  /** Per field, the page indexes where it was null. */
  nullAt: Record<string, number[]>;
  /** Per field, how many pages the source matched but the value didn't coerce. */
  unconverted: Record<string, number>;
}

const isEmpty = (v: FieldValue) => v === null || (Array.isArray(v) && v.length === 0);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Raw presence of a field's source: same source, no transforms, read as text. */
function rawExtractor(f: ExtractorField) {
  return compileExtractor(
    {
      recordKey: { from: 'url' },
      fields: [
        {
          name: f.name,
          type: f.type === 'string[]' ? 'string[]' : 'string',
          source: f.source,
          transforms: [],
          required: false,
        },
      ],
    },
    { regex: re2Engine },
  );
}

class InvalidSpecError extends Error {}

function measure(proposal: Proposal, pages: readonly SamplePage[]): Measured {
  const dry = dryRun(proposal, pages);
  if (!dry.ok) throw new InvalidSpecError(dry.problems.join('; '));
  const run = dry.run;
  const n = pages.length;
  const fields: Record<string, FieldCheckStats> = {};
  const nullAt: Record<string, number[]> = {};
  const unconverted: Record<string, number> = {};
  for (const f of run.spec.fields) {
    const raw = rawExtractor(f);
    const values = run.values[f.name]!;
    const nulls: number[] = [];
    let matched = 0;
    let bad = 0;
    values.forEach((v, i) => {
      const r = raw.extract(pages[i]!.html, pages[i]!.url);
      const rawHit = r !== null && !isEmpty(r.data[f.name] ?? null);
      if (rawHit) matched++;
      if (isEmpty(v)) {
        nulls.push(i);
        if (rawHit) bad++;
      }
    });
    const present = values.filter((v) => !isEmpty(v));
    nullAt[f.name] = nulls;
    unconverted[f.name] = bad;
    fields[f.name] = {
      nullRate: n ? round3(nulls.length / n) : 1,
      typeConformance: matched ? round3((matched - bad) / matched) : 1,
      distinct: new Set(present.map((v) => JSON.stringify(v))).size,
      ...(present.length ? { example: present[0] } : {}),
    };
  }
  return { run, fields, nullAt, unconverted };
}

function tryMeasure(proposal: Proposal, pages: readonly SamplePage[]): Measured | null {
  try {
    return measure(proposal, pages);
  } catch (err) {
    if (err instanceof InvalidSpecError || err instanceof ZodError) return null;
    if (err instanceof ExtractorSpecError) return null;
    throw err;
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function failingFields(m: Measured, n: number): FailingField[] {
  const out: FailingField[] = [];
  for (const f of m.run.spec.fields) {
    const s = m.fields[f.name]!;
    const limit = f.required ? REQUIRED_MAX_NULL_RATE : ANY_MAX_NULL_RATE;
    if (s.nullRate <= limit) continue;
    const bad = m.unconverted[f.name]!;
    let reason = `empty on ${pct(s.nullRate)} of ${n} pages (limit ${pct(limit)}${f.required ? ' for a required field' : ''})`;
    if (bad)
      reason += `; on ${bad} of them the source matched but the value didn't convert to ${f.type}`;
    const seen = new Set<string>();
    const found: FieldValue[] = [];
    for (const v of m.run.values[f.name]!) {
      if (isEmpty(v) || seen.has(JSON.stringify(v))) continue;
      seen.add(JSON.stringify(v));
      found.push(v);
    }
    out.push({
      field: f,
      nullRate: s.nullRate,
      typeConformance: s.typeConformance,
      reason,
      found,
      failingPages: m.nullAt[f.name]!,
    });
  }
  return out;
}

// --- self-check --------------------------------------------------------------------------------

export async function selfCheck(
  checked: CheckedProposal,
  ctx: SelfCheckContext,
): Promise<CheckedProposal> {
  const seenIds = new Set(ctx.samples.map((s) => s.id));
  const unseenWanted = Math.max(0, SELFCHECK_PAGES - ctx.samples.length);
  const unseen = unseenWanted
    ? await ctx.loadPages(pickUnseen(ctx.pageIds, seenIds, unseenWanted))
    : [];
  const pages: SamplePage[] = [...ctx.samples, ...unseen.filter((p) => !seenIds.has(p.id))];
  const n = pages.length;
  const notes = [...checked.notes];

  let proposal = checked.proposal;
  let m = measure(proposal, pages);
  const repaired = new Set<string>();
  let rounds = 0;

  for (let round = 1; round <= MAX_REPAIR_ROUNDS && ctx.model; round++) {
    const failing = failingFields(m, n);
    if (!failing.length) break;
    rounds = round;
    let input: unknown;
    try {
      const turn = await ctx.model.repair({
        pathPattern: ctx.pathPattern,
        round,
        userPrompt: buildRepairPrompt({
          pathPattern: ctx.pathPattern,
          round,
          checked: n,
          failing,
          pages,
        }),
      });
      await ctx.recordModelCall(turn.usage);
      input = turn.input;
    } catch (err) {
      if (!(err instanceof RecordedProposalMissingError)) await ctx.recordModelCall(ZERO_USAGE);
      notes.push(
        `repair round ${round} unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }

    const names = failing.map((f) => f.field.name);
    const parsed = parseRepair(input, names);
    if (!parsed.ok) {
      notes.push(`repair round ${round} answer rejected: ${parsed.problems.join('; ')}`);
      continue;
    }
    if (parsed.ignored.length)
      notes.push(
        `repair round ${round} ignored fields that weren't failing: ${parsed.ignored.join(', ')}`,
      );

    // Fields extract independently, so each patch is judged on its own field: kept only if it
    // compiles and lowers that field's null rate.
    const kept = new Map<string, RepairPatch>();
    for (const [name, patch] of parsed.patches) {
      const one = tryMeasure(applyPatches(proposal, new Map([[name, patch]])), pages);
      if (!one) {
        notes.push(`repair round ${round}: invalid source for "${name}"`);
        continue;
      }
      if (one.fields[name]!.nullRate < m.fields[name]!.nullRate) kept.set(name, patch);
      else notes.push(`repair round ${round}: new source for "${name}" didn't help`);
    }
    if (kept.size) {
      proposal = applyPatches(proposal, kept);
      m = measure(proposal, pages);
      for (const name of kept.keys()) repaired.add(name);
    }
  }

  const stillFailing = failingFields(m, n);
  const dropped: DroppedField[] = stillFailing.map((f) => ({
    name: f.field.name,
    nullRate: f.nullRate,
    reason: f.reason,
  }));
  const dropNames = new Set(dropped.map((d) => d.name));
  for (const name of dropNames) repaired.delete(name);
  if (dropNames.size) {
    const fields = proposal.fields.filter((f) => !dropNames.has(f.name));
    if (!fields.length) {
      throw new SelfCheckRejectedError(
        `self-check: every field failed on ${n} pages (${dropped.map((d) => `${d.name}: ${d.reason}`).join('; ')})`,
      );
    }
    proposal = { ...proposal, fields };
    m = measure(proposal, pages);
  }

  // Owner-facing summary in ai_rationale (only when something changed).
  const summary: string[] = [];
  const after = rounds ? ` after ${rounds} repair round${rounds > 1 ? 's' : ''}` : '';
  if (repaired.size) summary.push(`repaired ${[...repaired].join(', ')}`);
  if (dropped.length) {
    summary.push(
      `dropped ${dropped.map((d) => `${d.name} (empty on ${pct(d.nullRate)} of pages)`).join(', ')}${after}`,
    );
  }
  if (summary.length) {
    proposal = {
      ...proposal,
      rationale: `${proposal.rationale}\n\nSelf-check on ${n} pages (${ctx.samples.length} seen, ${n - ctx.samples.length} unseen): ${summary.join('; ')}.`,
    };
    notes.push(`self-check: ${summary.join('; ')}`);
  }

  // The guard again, on every checked page: a repaired source may pull new values.
  const guarded = guardFields(proposal, m.run, { jsonldTypes: ctx.jsonldTypes });
  const hidden = new Set(guarded.fields.filter((f) => !f.visible).map((f) => f.name));
  const fields: Record<string, FieldCheckStats> = {};
  for (const [name, s] of Object.entries(m.fields)) {
    const { example, ...rest } = s;
    fields[name] = hidden.has(name) || example === undefined ? rest : { ...rest, example };
  }
  const recordRate = n ? round3(m.run.records.filter(Boolean).length / n) : 0;

  return {
    proposal,
    spec: m.run.spec,
    fields: guarded.fields,
    flags: guarded.flags,
    notes,
    sampleStats: {
      source: 'selfcheck',
      sampled: n,
      seen: ctx.samples.length,
      unseen: n - ctx.samples.length,
      recordRate,
      repairRounds: rounds,
      repaired: [...repaired],
      dropped,
      fields,
    },
  };
}
