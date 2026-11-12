// The served-field allowlist (SP-015; data-model rule 13). `schema_versions.fields` is jsonb
// written by the schema agent (SP-012a) and owner edits (SP-014a); this is the only reader on
// the paid path. Anything that doesn't parse cleanly is treated as hidden: a malformed entry can
// make a field disappear from the output, never make a hidden one appear.
import { z } from 'zod';
import { fieldNameSchema, fieldTypeSchema, type FieldType } from '@spigot/shared';

export const FILTER_OPS = ['eq', 'lt', 'lte', 'gt', 'gte', 'in'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Ops that make sense for each type; a field's `filterable` list is intersected with this. */
export const OPS_BY_TYPE: Record<FieldType, readonly FilterOp[]> = {
  string: ['eq', 'in'],
  url: ['eq', 'in'],
  integer: ['eq', 'lt', 'lte', 'gt', 'gte'],
  number: ['eq', 'lt', 'lte', 'gt', 'gte'],
  date: ['eq', 'lt', 'lte', 'gt', 'gte'],
  datetime: ['eq', 'lt', 'lte', 'gt', 'gte'],
  boolean: ['eq'],
  'string[]': [],
};

export interface ServedField {
  name: string;
  type: FieldType;
  description?: string;
  /** Only `visible` fields are ever filtered, serialized or patched out to a buyer. */
  visible: true;
  /** Ops a buyer may use; empty when the field isn't filterable. */
  filterable: FilterOp[];
}

const storedFieldSchema = z.object({
  name: fieldNameSchema,
  type: fieldTypeSchema,
  description: z.string().optional(),
  visible: z.boolean().optional(),
  filterable: z.unknown().optional(),
});

function filterableOps(raw: unknown, type: FieldType): FilterOp[] {
  if (!Array.isArray(raw)) return [];
  const allowed = OPS_BY_TYPE[type] ?? [];
  return [...new Set(raw)].filter((op): op is FilterOp => allowed.includes(op as FilterOp));
}

/**
 * The visible fields of a stored schema, in schema order. A field counts as visible only when
 * `visible === true` (missing or anything else = hidden), and duplicate names are dropped
 * entirely (we can't tell which entry is meant).
 */
export function servedFields(stored: unknown): ServedField[] {
  if (!Array.isArray(stored)) return [];
  const counts = new Map<string, number>();
  for (const f of stored) {
    const name = (f as { name?: unknown } | null)?.name;
    if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const out: ServedField[] = [];
  for (const raw of stored) {
    const parsed = storedFieldSchema.safeParse(raw);
    if (!parsed.success || parsed.data.visible !== true) continue;
    const f = parsed.data;
    if (counts.get(f.name) !== 1) continue;
    out.push({
      name: f.name,
      type: f.type,
      ...(f.description === undefined ? {} : { description: f.description }),
      visible: true,
      filterable: filterableOps(f.filterable, f.type),
    });
  }
  return out;
}
