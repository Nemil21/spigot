import { gunzipSync } from 'node:zlib';
import jsonpatch, { type Operation } from 'fast-json-patch';
import { compileStored } from '../datasets/samples.js';
import type { Queryable } from '../db/index.js';
import { dataAtHash, parseServedKeys, type ClaimReason, type VersionRow } from './checks.js';

/**
 * The evidence the claims triage agent sees for one OPEN claim (features/10 §Claims 3; SP-048b):
 * the claim text, the record as served, the record now, its version history and the latest page
 * snapshot re-extracted for the cited fields. **Visible fields only**: a hidden field (PII,
 * rights-flagged) was never served, so it is never evidence and never leaves Spigot.
 */

export interface TriageField {
  name: string;
  type: string;
  required: boolean;
}

export interface TriageVersion {
  version: number;
  op: 'add' | 'update' | 'remove';
  changedAt: string;
  data: Record<string, unknown> | null;
}

export interface TriageContext {
  claimId: string;
  reason: ClaimReason;
  note: string | null;
  /** `<dataset>/<key>`, as served. */
  recordKey: string;
  typeName: string;
  unitPriceMicros: number;
  fields: TriageField[];
  /** The record as served (visible fields), or null when the served version can't be rebuilt. */
  served: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  removedAt: string | null;
  /** Last `MAX_VERSIONS` versions, oldest first. */
  versions: TriageVersion[];
  changedFields: string[];
  citedFields: string[];
  snapshot: {
    fetchedAt: string;
    httpStatus: number | null;
    pageRemoved: boolean;
    /** The cited fields as the active extractor reads them from the snapshot now. */
    values: Record<string, unknown> | null;
  } | null;
  /** Tries already recorded in `ai_recommendation` (failed ones). */
  previousAttempts: number;
}

export const MAX_VERSIONS = 5;
const MAX_CITED = 10;

interface ClaimRow {
  id: string;
  reason: ClaimReason;
  note: string | null;
  aiRecommendation: { attempts?: unknown } | null;
  servedRecordKeys: unknown;
  unitPriceMicros: number | null;
  recordId: string;
  recordKey: string;
  data: unknown;
  removedAt: Date | null;
  pageId: string | null;
  datasetSlug: string;
  typeName: string;
  fields: unknown;
  extractor: unknown;
}

function visibleFields(stored: unknown): TriageField[] {
  if (!Array.isArray(stored)) return [];
  const out: TriageField[] = [];
  for (const f of stored) {
    if (typeof f !== 'object' || f === null) continue;
    const { name, type, required, visible } = f as Record<string, unknown>;
    if (typeof name !== 'string' || visible !== true) continue;
    out.push({
      name,
      type: typeof type === 'string' ? type : 'string',
      required: required === true,
    });
  }
  return out;
}

function pick(data: unknown, names: readonly string[]): Record<string, unknown> | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  return Object.fromEntries(names.map((n) => [n, rec[n] ?? null]));
}

/** Every version's data (replayed patches), oldest first. */
function replay(versions: readonly (VersionRow & { changedAt: Date })[]): TriageVersion[] {
  let doc: unknown = null;
  const out: TriageVersion[] = [];
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    if (v.op !== 'remove' && Array.isArray(v.patch)) {
      try {
        doc = jsonpatch.applyPatch(
          jsonpatch.deepClone(doc),
          v.patch as Operation[],
          false,
          false,
        ).newDocument;
      } catch {
        doc = null;
      }
    }
    out.push({
      version: v.version,
      op: v.op,
      changedAt: v.changedAt.toISOString(),
      data: v.op === 'remove' ? null : (doc as Record<string, unknown> | null),
    });
  }
  return out;
}

/** Fields the buyer names in the note (`price_usd` or "price usd"), case-insensitive. */
export function fieldsNamedIn(note: string | null, names: readonly string[]): string[] {
  if (!note) return [];
  const text = note.toLowerCase();
  return names.filter((n) => {
    const lower = n.toLowerCase();
    return text.includes(lower) || text.includes(lower.replace(/_/g, ' '));
  });
}

/**
 * The context for an OPEN claim still needing a recommendation, or `null` if it doesn't exist,
 * was decided, or already has a READY one (so a repeat never spends a model call).
 */
export async function loadTriageContext(
  q: Queryable,
  claimId: string,
): Promise<TriageContext | null> {
  const { rows } = await q.query<ClaimRow>(
    `SELECT c.id, c.reason, c.note, c.ai_recommendation AS "aiRecommendation",
            a.served_record_keys AS "servedRecordKeys", a.unit_price_micros AS "unitPriceMicros",
            r.id AS "recordId", r.record_key AS "recordKey", r.data, r.removed_at AS "removedAt",
            r.page_id AS "pageId", d.slug AS "datasetSlug", d.type_name AS "typeName",
            sv.fields, sv.extractor
       FROM claims c
       JOIN api_calls a ON a.id = c.api_call_id
       JOIN records r ON r.id = c.record_id
       JOIN datasets d ON d.id = r.dataset_id
       LEFT JOIN schema_versions sv ON sv.id = d.active_schema_id
      WHERE c.id = $1 AND c.status = 'OPEN'
        AND (c.ai_recommendation IS NULL OR c.ai_recommendation->>'status' <> 'READY')`,
    [claimId],
  );
  const row = rows[0];
  if (!row) return null;

  const fields = visibleFields(row.fields);
  const names = fields.map((f) => f.name);
  const recordKey = `${row.datasetSlug}/${row.recordKey}`;

  const versionRows = await q.query<VersionRow & { changedAt: Date }>(
    `SELECT version, op, patch, hash, changed_at AS "changedAt"
       FROM record_versions WHERE record_id = $1 ORDER BY version`,
    [row.recordId],
  );
  const servedHash = parseServedKeys(row.servedRecordKeys).find((s) => s.key === recordKey)?.hash;
  const served =
    servedHash === undefined ? null : pick(dataAtHash(versionRows.rows, servedHash), names);
  const current = row.removedAt ? null : pick(row.data, names);
  const versions = replay(versionRows.rows)
    .slice(-MAX_VERSIONS)
    .map((v) => ({ ...v, data: v.data && pick(v.data, names) }));

  const changedFields =
    served && current
      ? names.filter((n) => JSON.stringify(served[n]) !== JSON.stringify(current[n]))
      : [];
  const named = fieldsNamedIn(row.note, names);
  let citedFields = [...new Set([...named, ...changedFields])];
  if (citedFields.length === 0) citedFields = names;
  citedFields = citedFields.slice(0, MAX_CITED);

  const attempts = Number(row.aiRecommendation?.attempts);
  return {
    claimId: row.id,
    reason: row.reason,
    note: row.note,
    recordKey,
    typeName: row.typeName,
    unitPriceMicros: row.unitPriceMicros ?? 0,
    fields,
    served,
    current,
    removedAt: row.removedAt?.toISOString() ?? null,
    versions,
    changedFields,
    citedFields,
    snapshot: await snapshotExcerpt(q, row.pageId, row.extractor, citedFields),
    previousAttempts: Number.isFinite(attempts) ? attempts : 0,
  };
}

/** The latest snapshot of the record's page, re-extracted with the active extractor. */
async function snapshotExcerpt(
  q: Queryable,
  pageId: string | null,
  extractor: unknown,
  cited: readonly string[],
): Promise<TriageContext['snapshot']> {
  if (!pageId) return null;
  const { rows } = await q.query<{
    url: string;
    pageRemovedAt: Date | null;
    fetchedAt: Date;
    httpStatus: number | null;
    html: Buffer | null;
  }>(
    `SELECT p.url, p.removed_at AS "pageRemovedAt", s.fetched_at AS "fetchedAt",
            s.http_status AS "httpStatus", s.html_gz AS html
       FROM pages p
       JOIN LATERAL (
         SELECT fetched_at, http_status, html_gz FROM snapshots
          WHERE page_id = p.id ORDER BY fetched_at DESC, id DESC LIMIT 1
       ) s ON true
      WHERE p.id = $1`,
    [pageId],
  );
  const snap = rows[0];
  if (!snap) return null;
  let values: Record<string, unknown> | null = null;
  const ok = snap.httpStatus === null || (snap.httpStatus >= 200 && snap.httpStatus < 300);
  const compiled = ok && snap.html ? compileStored(extractor) : null;
  if (compiled && snap.html) {
    try {
      const rec = compiled.extract(gunzipSync(snap.html).toString('utf8'), snap.url);
      values = rec ? pick(rec.data, cited) : null;
    } catch {
      values = null;
    }
  }
  return {
    fetchedAt: snap.fetchedAt.toISOString(),
    httpStatus: snap.httpStatus,
    pageRemoved: snap.pageRemovedAt !== null,
    values,
  };
}
