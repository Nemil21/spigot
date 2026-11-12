// Sample rows and the owner's field view for W05 / W06 (SP-014b; features/13 §2–3, api.md
// §`GET /api/sites/:id/proposals`, §`GET /api/datasets/:id`).
//
// - A proposal's sample rows come from SP-011's extractor (pure, no AI) run on the template's
//   snapshots: the pages the model saw first (`templates.sample_page_ids`), then unseen pages of
//   the same template. Every field is kept, hidden ones included: this is the owner's own data,
//   and W06 shows hidden fields struck through.
// - A LIVE dataset's sample rows are its most recent records.
// Neither path is ever served to a buyer; the buyer read path is `records/fields.ts`.
import { gunzipSync } from 'node:zlib';
import {
  compileExtractor,
  ExtractorSpecError,
  type CompiledExtractor,
  type FieldValue,
  type RecordData,
} from '@spigot/shared';
import { ZodError } from 'zod';
import type { Queryable } from '../db/index.js';
import { re2Engine } from '../extract/adapters.js';
import { AUTO_SCHEMA_LABEL } from '../schema-agent/fallback.js';

export const PROPOSAL_SAMPLE_ROWS = 5;
export const DATASET_SAMPLE_ROWS = 20;

/** Datasets whose sample rows come from `records` rather than an extractor dry run. */
export const RECORD_BACKED_STATUSES: readonly string[] = ['LIVE', 'LIVE_STALE', 'UNPUBLISHED'];

export type SourceBadge = 'JSON-LD' | 'CSS' | 'auto (no AI)';

export interface FieldView {
  name: string;
  type: string;
  description: string | null;
  visible: boolean;
  pii: boolean;
  rightsFlag: boolean;
  filterable: string[];
  nullRate: number | null;
  example: FieldValue | null;
}

// --- extractor dry run -------------------------------------------------------------------------

const LATEST_SNAPSHOT = `
  JOIN LATERAL (
    SELECT s.html_gz FROM snapshots s
     WHERE s.page_id = p.id AND s.http_status = 200 AND s.html_gz IS NOT NULL
     ORDER BY s.id DESC LIMIT 1
  ) snap ON true`;

/** Compile a stored `schema_versions.extractor`; null when it no longer parses. */
export function compileStored(extractor: unknown): CompiledExtractor | null {
  try {
    return compileExtractor(extractor, { regex: re2Engine });
  } catch (err) {
    if (err instanceof ExtractorSpecError || err instanceof ZodError) return null;
    throw err;
  }
}

interface PageHtml {
  id: string;
  url: string;
  html_gz: Buffer;
}

/**
 * Up to `n` rows from running `extractor` on the template's pages: the seen samples first (in
 * stored order), then unseen live pages of the template (by id, deterministic). Pages where the
 * extractor yields no record (a required field missing) are skipped, so a few extra unseen pages
 * are read to make up the count.
 */
export async function extractSampleRows(
  q: Queryable,
  args: { templateId: string | null; samplePageIds: readonly string[]; extractor: unknown },
  n: number,
): Promise<RecordData[]> {
  const compiled = compileStored(args.extractor);
  if (!compiled || n <= 0) return [];
  const seenIds = args.samplePageIds.slice(0, n);

  const seen = seenIds.length
    ? (
        await q.query<PageHtml>(
          `SELECT p.id, p.url, snap.html_gz FROM pages p ${LATEST_SNAPSHOT}
            WHERE p.id = ANY($1::uuid[])`,
          [seenIds],
        )
      ).rows
    : [];
  const byId = new Map(seen.map((r) => [r.id, r]));
  const pages: PageHtml[] = seenIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));

  if (args.templateId && pages.length < n) {
    const { rows } = await q.query<PageHtml>(
      `SELECT p.id, p.url, snap.html_gz FROM pages p ${LATEST_SNAPSHOT}
        WHERE p.template_id = $1 AND p.removed_at IS NULL AND NOT (p.id = ANY($2::uuid[]))
        ORDER BY p.id
        LIMIT $3`,
      [args.templateId, seenIds, (n - pages.length) * 2],
    );
    pages.push(...rows);
  }

  const out: RecordData[] = [];
  for (const p of pages) {
    if (out.length >= n) break;
    const rec = compiled.extract(gunzipSync(p.html_gz).toString('utf8'), p.url);
    if (rec) out.push(rec.data);
  }
  return out;
}

/** The dataset's `n` most recently changed live records (all fields; owner view). */
export async function recentRecordRows(
  q: Queryable,
  datasetId: string,
  n: number,
): Promise<RecordData[]> {
  const { rows } = await q.query<{ data: RecordData }>(
    `SELECT data FROM records
      WHERE dataset_id = $1 AND removed_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT $2`,
    [datasetId, n],
  );
  return rows.map((r) => r.data);
}

// --- field view --------------------------------------------------------------------------------

interface StatsFields {
  fields?: Record<string, { nullRate?: unknown; example?: unknown }>;
}

const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && !v.length);

/**
 * The owner's field list: stored schema fields (snake or camel `rights_flag`), with null rate and
 * example from `sample_stats` when it has them, else computed on the sample rows. The guard
 * leaves examples of hidden fields out of `sample_stats`; the sample rows still carry them (the
 * owner sees them struck through), so the example falls back to the rows.
 */
export function fieldView(
  storedFields: unknown,
  sampleStats: unknown,
  rows: readonly RecordData[],
): FieldView[] {
  if (!Array.isArray(storedFields)) return [];
  const stats = ((sampleStats as StatsFields | null)?.fields ?? {}) as NonNullable<
    StatsFields['fields']
  >;
  return storedFields.flatMap((raw): FieldView[] => {
    const f = raw as Record<string, unknown> | null;
    if (!f || typeof f.name !== 'string') return [];
    const name = f.name;
    const s = Object.hasOwn(stats, name) ? stats[name] : undefined;
    const values = rows.map((r) => r[name]);
    const present = values.filter((v) => !isEmpty(v));
    const nullRate =
      typeof s?.nullRate === 'number'
        ? s.nullRate
        : rows.length
          ? Math.round(((rows.length - present.length) / rows.length) * 1000) / 1000
          : null;
    const example = (!isEmpty(s?.example) ? s!.example : (present[0] ?? null)) as FieldValue;
    return [
      {
        name,
        type: typeof f.type === 'string' ? f.type : 'string',
        description: typeof f.description === 'string' ? f.description : null,
        // Same rule as the buyer path: only `visible === true` counts as visible.
        visible: f.visible === true,
        pii: f.pii === true,
        rightsFlag: f.rights_flag === true || f.rightsFlag === true,
        filterable: Array.isArray(f.filterable)
          ? f.filterable.filter((op): op is string => typeof op === 'string')
          : [],
        nullRate,
        example: example ?? null,
      },
    ];
  });
}

// --- source badge ------------------------------------------------------------------------------

/** SP-012b's JSON-LD-only fallback stores `ai_model = AUTO_SCHEMA_LABEL` ("auto (no AI)"). */
export function isAutoSchema(v: { ai_model: string | null; proposed_by: string | null }): boolean {
  return v.proposed_by !== 'OWNER' && v.ai_model === AUTO_SCHEMA_LABEL;
}

/** `{ badge: 'JSON-LD', source: 'JSON-LD (Apartment, Offer) + 2 CSS fields' }`. */
export function sourceOf(
  extractor: unknown,
  jsonldTypes: readonly string[] | null,
  version: { ai_model: string | null; proposed_by: string | null },
): { badge: SourceBadge; source: string } {
  const fields = ((extractor as { fields?: unknown } | null)?.fields ?? []) as {
    source?: Record<string, unknown>;
  }[];
  const jsonld = fields.filter((f) => f.source && 'jsonld' in f.source).length;
  const css = fields.filter((f) => f.source && 'css' in f.source).length;
  const types = (jsonldTypes ?? []).filter(Boolean);
  const plural = (k: number) => `${k} CSS field${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (jsonld) parts.push(types.length ? `JSON-LD (${types.join(', ')})` : 'JSON-LD');
  if (css) parts.push(jsonld ? plural(css) : `CSS (${plural(css)})`);
  const detail = parts.join(' + ') || 'no fields';
  if (isAutoSchema(version)) {
    return { badge: AUTO_SCHEMA_LABEL, source: `${AUTO_SCHEMA_LABEL}: ${detail}` };
  }
  return { badge: jsonld ? 'JSON-LD' : 'CSS', source: detail };
}
