import { z } from 'zod';
import type { Db, Queryable } from '../db/index.js';
import { bumpPolicyVersion, SOLD_DATASET_STATUSES } from '../gate/policy.js';
import { ApiError } from '../http/errors.js';
import { FILTER_OPS, OPS_BY_TYPE, type FilterOp } from '../records/fields.js';
import { forPublisher } from '../tenancy.js';

/**
 * `PATCH /api/datasets/:id` (SP-014a; api.md). The owner edits a proposal before approving it.
 *
 * - `fields[{ name, visible?, filterable? }]`: changes to the latest schema version's fields make
 *   a NEW immutable `schema_versions` row (`PROPOSED`, `proposed_by: OWNER`, version + 1) with the
 *   same extractor and record key; the response returns it. Only fields the extractor already
 *   produces can be edited. A hidden field is never filterable: hiding a field clears its ops,
 *   and asking for a hidden field to be filterable is a 400.
 * - `perRecordMicros`, `perChangeMicros` (100–100,000) and `slug` apply to the dataset row.
 *   The slug is free to change (record keys don't contain it, SP-011); on a sold dataset a slug
 *   or price change bumps the gate policy (it lists slugs and prices).
 *
 * Field edits are allowed while the dataset is PROPOSED or LIVE_STALE (the versions approve can
 * take); a LIVE dataset's served schema changes only through a new approve, so field edits on it
 * are a 409. REJECTED / UNPUBLISHED datasets can't be edited.
 */

export const PRICE_MIN_MICROS = 100;
export const PRICE_MAX_MICROS = 100_000;

const price = z.number().int().min(PRICE_MIN_MICROS).max(PRICE_MAX_MICROS);

export const patchBody = z
  .object({
    fields: z
      .array(
        z
          .object({
            name: z.string().min(1).max(63),
            visible: z.boolean().optional(),
            /** `true` = every op the type supports, `false` = none, or an explicit op list. */
            filterable: z.union([z.boolean(), z.array(z.enum(FILTER_OPS)).max(6)]).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    perRecordMicros: price.optional(),
    perChangeMicros: price.optional(),
    slug: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes')
      .optional(),
  })
  .strict();

export type PatchBody = z.infer<typeof patchBody>;

/** One entry of `schema_versions.fields` as stored (see schema-agent/pii.ts `StoredField`). */
export interface StoredFieldRow {
  name: string;
  type: keyof typeof OPS_BY_TYPE;
  visible?: boolean;
  filterable?: unknown;
  [k: string]: unknown;
}

export interface SchemaVersionView {
  id: string;
  datasetId: string;
  version: number;
  status: string;
  proposedBy: string | null;
  fields: unknown;
}

export interface PatchResult {
  dataset: {
    id: string;
    slug: string;
    status: string;
    perRecordMicros: number;
    perChangeMicros: number;
  };
  /** The schema version created by this edit, or null when no field changed. */
  schemaVersion: SchemaVersionView | null;
}

export const EDITABLE_FIELD_STATUSES = ['PROPOSED', 'LIVE_STALE'] as const;
const EDITABLE_STATUSES = ['PROPOSED', 'LIVE', 'LIVE_STALE'];

interface DatasetRow {
  id: string;
  site_id: string;
  slug: string;
  status: string;
  price_per_record_micros: string;
  price_per_change_micros: string;
}

interface VersionRow {
  id: string;
  version: number;
  fields: StoredFieldRow[];
  extractor: unknown;
  record_key: unknown;
  sample_stats: unknown;
  ai_model: string | null;
  ai_rationale: string | null;
}

const opsEqual = (a: unknown, b: readonly FilterOp[]) =>
  Array.isArray(a) && a.length === b.length && a.every((op, i) => op === b[i]);

/** Apply the edits to `base`; returns null when nothing changed. Throws 400 on a bad edit. */
export function applyFieldEdits(
  base: readonly StoredFieldRow[],
  edits: NonNullable<PatchBody['fields']>,
): StoredFieldRow[] | null {
  const byName = new Map(base.map((f) => [f.name, f]));
  const seen = new Set<string>();
  const next = new Map(base.map((f) => [f.name, { ...f }]));
  for (const e of edits) {
    if (seen.has(e.name)) {
      throw new ApiError('VALIDATION_ERROR', `Field ${e.name} is listed twice.`, {
        field: e.name,
      });
    }
    seen.add(e.name);
    const cur = byName.get(e.name);
    if (!cur) {
      throw new ApiError('VALIDATION_ERROR', `No field named ${e.name} in this schema.`, {
        field: e.name,
      });
    }
    const f = next.get(e.name)!;
    if (e.visible !== undefined) f.visible = e.visible;
    const supported = OPS_BY_TYPE[cur.type] ?? [];
    if (e.filterable !== undefined) {
      let ops: FilterOp[];
      if (e.filterable === true) {
        // Keep the proposal's own op list when it has one, else every supported op.
        const own = Array.isArray(cur.filterable)
          ? supported.filter((op) => (cur.filterable as unknown[]).includes(op))
          : [];
        ops = own.length ? own : [...supported];
      } else if (e.filterable === false) {
        ops = [];
      } else {
        ops = supported.filter((op) => (e.filterable as FilterOp[]).includes(op));
        const bad = e.filterable.filter((op) => !supported.includes(op));
        if (bad.length) {
          throw new ApiError(
            'VALIDATION_ERROR',
            `${e.name} (${cur.type}) can't be filtered with ${bad.join(', ')}.`,
            { field: e.name, supported },
          );
        }
      }
      if (ops.length > 0 && supported.length === 0) {
        throw new ApiError('VALIDATION_ERROR', `${e.name} (${cur.type}) can't be filterable.`, {
          field: e.name,
        });
      }
      f.filterable = ops;
    }
    if (f.visible !== true) {
      const wanted = Array.isArray(f.filterable) && f.filterable.length > 0;
      if (wanted && e.filterable !== undefined) {
        throw new ApiError('VALIDATION_ERROR', `A hidden field can't be filterable: ${e.name}.`, {
          field: e.name,
        });
      }
      f.filterable = []; // hiding a field clears its filters
    }
  }

  const out = base.map((f) => next.get(f.name)!);
  const changed = out.some((f, i) => {
    const b = base[i]!;
    const bOps = Array.isArray(b.filterable) ? (b.filterable as FilterOp[]) : [];
    const fOps = Array.isArray(f.filterable) ? (f.filterable as FilterOp[]) : [];
    return (b.visible === true) !== (f.visible === true) || !opsEqual(bOps, fOps);
  });
  return changed ? out : null;
}

async function latestVersion(q: Queryable, datasetId: string): Promise<VersionRow> {
  const { rows } = await q.query<VersionRow>(
    `SELECT id, version, fields, extractor, record_key, sample_stats, ai_model, ai_rationale
       FROM schema_versions WHERE dataset_id = $1 ORDER BY version DESC LIMIT 1`,
    [datasetId],
  );
  if (!rows[0]) throw new ApiError('STATE_CONFLICT', 'This dataset has no schema to edit yet.');
  return rows[0];
}

export async function patchDataset(
  db: Db,
  publisherId: string,
  datasetId: string,
  body: PatchBody,
): Promise<PatchResult> {
  const scope = forPublisher(publisherId);
  return db.tx(async (tx) => {
    const ds = await scope.get<DatasetRow>(tx, 'datasets', datasetId, { forUpdate: true });
    if (!EDITABLE_STATUSES.includes(ds.status)) {
      throw new ApiError('STATE_CONFLICT', `A ${ds.status} dataset can't be edited.`, {
        status: ds.status,
      });
    }

    let schemaVersion: SchemaVersionView | null = null;
    if (body.fields && body.fields.length > 0) {
      const base = await latestVersion(tx, ds.id);
      const fields = applyFieldEdits(base.fields, body.fields);
      if (fields) {
        if (!(EDITABLE_FIELD_STATUSES as readonly string[]).includes(ds.status)) {
          throw new ApiError(
            'STATE_CONFLICT',
            'Fields of a live dataset change only through a new approved schema.',
            { status: ds.status },
          );
        }
        const { rows } = await tx.query<{ id: string; version: number; status: string }>(
          `INSERT INTO schema_versions
             (dataset_id, version, status, fields, extractor, record_key, sample_stats, ai_model,
              ai_rationale, proposed_by)
           VALUES ($1, $2, 'PROPOSED', $3, $4, $5, $6, $7, $8, 'OWNER')
           RETURNING id, version, status`,
          [
            ds.id,
            base.version + 1,
            JSON.stringify(fields),
            JSON.stringify(base.extractor),
            JSON.stringify(base.record_key),
            base.sample_stats == null ? null : JSON.stringify(base.sample_stats),
            base.ai_model,
            base.ai_rationale,
          ],
        );
        const r = rows[0]!;
        schemaVersion = {
          id: r.id,
          datasetId: ds.id,
          version: r.version,
          status: r.status,
          proposedBy: 'OWNER',
          fields,
        };
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [ds.id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.perRecordMicros !== undefined) set('price_per_record_micros', body.perRecordMicros);
    if (body.perChangeMicros !== undefined) set('price_per_change_micros', body.perChangeMicros);
    if (body.slug !== undefined && body.slug !== ds.slug) {
      const taken = await tx.query(
        'SELECT 1 FROM datasets WHERE site_id = $1 AND slug = $2 AND id <> $3',
        [ds.site_id, body.slug, ds.id],
      );
      if (taken.rowCount) {
        throw new ApiError(
          'VALIDATION_ERROR',
          `Another dataset on this site is already called ${body.slug}.`,
          {
            field: 'slug',
          },
        );
      }
      set('slug', body.slug);
    }

    let row = ds;
    if (sets.length) {
      const { rows } = await tx.query<DatasetRow>(
        `UPDATE datasets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1
         RETURNING id, site_id, slug, status, price_per_record_micros, price_per_change_micros`,
        params,
      );
      row = rows[0]!;
      const policyChanged =
        row.slug !== ds.slug || row.price_per_record_micros !== ds.price_per_record_micros;
      if (policyChanged && (SOLD_DATASET_STATUSES as readonly string[]).includes(row.status)) {
        await bumpPolicyVersion(tx, row.site_id);
      }
    }

    return {
      dataset: {
        id: row.id,
        slug: row.slug,
        status: row.status,
        perRecordMicros: Number(row.price_per_record_micros),
        perChangeMicros: Number(row.price_per_change_micros),
      },
      schemaVersion,
    };
  });
}
