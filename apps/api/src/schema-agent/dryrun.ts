// Dry run of a proposed extractor on the template's sample pages (SP-012a): the same pure
// `compileExtractor` that SP-013 runs on every page. It turns "the model wrote a selector that
// matches nothing" into a validation error before anything is stored, and gives the PII / rights
// guard the actual sample values to look at.
import * as cheerio from 'cheerio';
import {
  compileExtractor,
  ExtractorSpecError,
  type ExtractedRecord,
  type ExtractorSpec,
  type FieldValue,
} from '@spigot/shared';
import { ZodError } from 'zod';
import { re2Engine } from '../extract/adapters.js';
import { formatIssues, type Proposal } from './tool.js';

export interface SamplePage {
  id: string;
  url: string;
  html: string;
}

export interface FieldSampleStats {
  nullRate: number;
  distinct: number;
  /** One non-null sample value (omitted for fields the guard hides). */
  example?: FieldValue;
}

/** `schema_versions.sample_stats` for an AI proposal: computed on the 3–5 samples the model saw. */
export interface SampleStats {
  source: 'samples';
  sampled: number;
  recordRate: number;
  fields: Record<string, FieldSampleStats>;
}

export interface DryRun {
  spec: ExtractorSpec;
  records: (ExtractedRecord | null)[];
  /** Coerced value of each field on each sample, in sample order. */
  values: Record<string, FieldValue[]>;
  /** Raw text of each CSS field's matched element(s) and of their parent, per sample. */
  rawText: Record<string, string[]>;
  nearbyText: Record<string, string[]>;
  /** Problems that make the proposal invalid (empty = valid). */
  problems: string[];
  /** Fields with no value on any sample (also listed in `problems`). */
  emptyFields: string[];
  stats: SampleStats;
}

export type DryRunResult = { ok: true; run: DryRun } | { ok: false; problems: string[] };

function specErrors(err: unknown): string[] {
  if (err instanceof ZodError) return formatIssues(err);
  if (err instanceof ExtractorSpecError) return [err.message];
  throw err;
}

/** Compile the proposal's extractor and run it on every sample. */
export function dryRun(proposal: Proposal, samples: readonly SamplePage[]): DryRunResult {
  const specInput = { recordKey: proposal.recordKey, fields: proposal.fields };
  let compiled;
  try {
    compiled = compileExtractor(specInput, { regex: re2Engine });
  } catch (err) {
    return { ok: false, problems: specErrors(err) };
  }
  const spec = compiled.spec;
  // One single-field extractor per field: a field's value even when the record gate drops it.
  const single = spec.fields.map((f) =>
    compileExtractor(
      { recordKey: { from: 'url' }, fields: [{ ...f, required: false }] },
      { regex: re2Engine },
    ),
  );

  const values: Record<string, FieldValue[]> = {};
  const rawText: Record<string, string[]> = {};
  const nearbyText: Record<string, string[]> = {};
  for (const f of spec.fields) {
    values[f.name] = [];
    rawText[f.name] = [];
    nearbyText[f.name] = [];
  }
  const records: (ExtractedRecord | null)[] = [];

  for (const page of samples) {
    records.push(compiled.extract(page.html, page.url));
    const $ = cheerio.load(page.html);
    spec.fields.forEach((f, i) => {
      const rec = single[i]!.extract(page.html, page.url);
      values[f.name]!.push(rec ? (rec.data[f.name] ?? null) : null);
      if ('css' in f.source) {
        const hit = $(f.source.css);
        const first = f.source.all ? hit : hit.first();
        rawText[f.name]!.push(first.text().replace(/\s+/g, ' ').trim());
        nearbyText[f.name]!.push(first.parent().text().replace(/\s+/g, ' ').trim());
      }
    });
  }

  const n = samples.length;
  const problems: string[] = [];
  const emptyFields: string[] = [];
  const fields: Record<string, FieldSampleStats> = {};
  for (const f of spec.fields) {
    const vs = values[f.name]!;
    const present = vs.filter((v) => v !== null && !(Array.isArray(v) && v.length === 0));
    const distinct = new Set(present.map((v) => JSON.stringify(v))).size;
    fields[f.name] = {
      nullRate: n ? round((n - present.length) / n) : 1,
      distinct,
      ...(present.length ? { example: present[0] } : {}),
    };
    if (n && present.length === 0) {
      emptyFields.push(f.name);
      const where =
        'jsonld' in f.source ? `JSON-LD path ${f.source.jsonld}` : `selector ${f.source.css}`;
      problems.push(
        `field "${f.name}": no value on any of the ${n} sample pages (${where} matches nothing usable)`,
      );
    }
  }
  const recordCount = records.filter(Boolean).length;
  if (n && recordCount === 0) {
    problems.push(
      'the extractor produced no record on any sample page (required fields all empty)',
    );
  }

  return {
    ok: true,
    run: {
      spec,
      records,
      values,
      rawText,
      nearbyText,
      problems,
      emptyFields,
      stats: { source: 'samples', sampled: n, recordRate: n ? round(recordCount / n) : 0, fields },
    },
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
