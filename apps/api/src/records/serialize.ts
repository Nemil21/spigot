// Hidden fields never leave (data-model rule 13). Everything a buyer sees from `records.data` or
// `record_versions.patch` goes through here, and output is built from the active schema's
// visible fields (allowlist), never by deleting hidden ones (denylist). A field added to `data`
// that the schema doesn't list visible simply doesn't appear.
import type { ServedField } from './fields.js';

/** A `records` row as `query.ts` selects it. */
export interface RecordRow {
  id: string;
  record_key: string;
  data: unknown;
  version: number;
  updated_at: Date;
  crawled_at: Date | null;
  source_lastmod: Date | null;
  /** Source page URL (`pages.url`); public, since it's the page on the publisher's site. */
  url: string | null;
}

export interface SerializeContext {
  datasetSlug: string;
  fields: readonly ServedField[];
  staleSince: Date | null;
}

export type ServedValue = string | number | boolean | null | (string | number | boolean)[];

export interface ServedRecord {
  /** `<dataset-slug>/<stored key>`. */
  key: string;
  /** Visible schema fields, plus `url` and `updated_at` metadata. */
  data: Record<string, ServedValue>;
  version: number;
  freshness: { crawledAt: string | null; sourceLastmod: string | null; staleSince: string | null };
}

export function publicKey(datasetSlug: string, storedKey: string): string {
  return `${datasetSlug}/${storedKey}`;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  );
}

/** Field values are scalars or lists of scalars (SP-011); anything else is served as null. */
function servedValue(v: unknown): ServedValue {
  if (isScalar(v)) return v;
  if (Array.isArray(v) && v.every(isScalar)) return [...v];
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Only the visible schema fields of `data`, in schema order; a missing field is null. */
export function visibleData(
  fields: readonly ServedField[],
  data: unknown,
): Record<string, ServedValue> {
  const src = isPlainObject(data) ? data : {};
  const out: Record<string, ServedValue> = {};
  for (const f of fields) {
    out[f.name] = Object.prototype.hasOwnProperty.call(src, f.name)
      ? servedValue(src[f.name])
      : null;
  }
  return out;
}

export function serializeRecord(ctx: SerializeContext, row: RecordRow): ServedRecord {
  return {
    key: publicKey(ctx.datasetSlug, row.record_key),
    data: {
      ...visibleData(ctx.fields, row.data),
      url: row.url,
      updated_at: row.updated_at.toISOString(),
    },
    version: row.version,
    freshness: {
      crawledAt: iso(row.crawled_at),
      sourceLastmod: iso(row.source_lastmod),
      staleSince: iso(ctx.staleSince),
    },
  };
}

export function serialize(ctx: SerializeContext, rows: readonly RecordRow[]): ServedRecord[] {
  return rows.map((r) => serializeRecord(ctx, r));
}

// ---------------------------------------------------------------------------------------------
// JSON Patch (RFC 6902) stripping for the changes feed.

export interface PatchOp {
  op: string;
  path: string;
  value?: unknown;
  from?: string;
}

/** First segment of a JSON Pointer (`/price_usd/0` → `price_usd`); `''` for the root. */
function topSegment(pointer: string): string | null {
  if (pointer === '') return '';
  if (!pointer.startsWith('/')) return null;
  const end = pointer.indexOf('/', 1);
  const seg = pointer.slice(1, end < 0 ? undefined : end);
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Keeps only patch ops on visible fields. A root op (`path: ''`, the whole-record `add` and
 * `remove`) is kept with an object value reduced to visible fields. Ops on hidden or unknown
 * paths, malformed ops, and `move`/`copy` from a hidden path are dropped.
 */
export function stripPatch(fields: readonly ServedField[], patch: unknown): PatchOp[] {
  if (!Array.isArray(patch)) return [];
  const visible = new Set(fields.map((f) => f.name));
  const out: PatchOp[] = [];
  for (const raw of patch) {
    if (!isPlainObject(raw) || typeof raw.op !== 'string' || typeof raw.path !== 'string') continue;
    const seg = topSegment(raw.path);
    if (seg === null) continue;
    if (raw.from !== undefined) {
      const fromSeg = typeof raw.from === 'string' ? topSegment(raw.from) : null;
      if (fromSeg === null || fromSeg === '' || !visible.has(fromSeg)) continue;
    }
    if (seg === '') {
      const op: PatchOp = { op: raw.op, path: '' };
      if ('value' in raw)
        op.value = isPlainObject(raw.value) ? visibleData(fields, raw.value) : null;
      out.push(op);
      continue;
    }
    if (!visible.has(seg)) continue;
    const op: PatchOp = { op: raw.op, path: raw.path };
    if (raw.from !== undefined) op.from = raw.from as string;
    if ('value' in raw) {
      // A whole-field value: the field is visible, so its value is too (scalars / lists only).
      op.value =
        raw.path === `/${seg}` ? servedValue(raw.value) : isScalar(raw.value) ? raw.value : null;
    }
    out.push(op);
  }
  return out;
}
