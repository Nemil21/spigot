import { createHash } from 'node:crypto';
import type { Queryable } from '../db/index.js';
import { servedFields, type ServedField } from '../records/fields.js';
import { fieldExpr } from '../records/filters.js';

/**
 * Filter indexes (SP-014a; data-model §records indexes). At approve, every visible field the
 * approved schema marks filterable gets an expression index on `records`, spelled with SP-015's
 * `fieldExpr` so it is exactly the expression the buyer query filters on (any other spelling
 * isn't used by the planner).
 *
 * One index per (field name, expression), shared by every dataset with that field: the index
 * leads with `dataset_id`, which every records query pins, so another dataset's rows cost
 * nothing at query time. Hidden fields are never indexed (`servedFields` drops them), so a
 * hidden field can never become filterable through an index either.
 *
 * `CREATE INDEX CONCURRENTLY` can't run in a transaction: call this on the pool, after the
 * approve transaction committed. A failed concurrent build leaves an INVALID index behind; it is
 * dropped and rebuilt on the next call (`IF NOT EXISTS` alone would keep the broken one).
 */

export interface FilterIndex {
  name: string;
  field: string;
  expr: string;
}

/** Index name: readable, ≤ 63 bytes, and distinct per expression (the type is part of it). */
export function filterIndexName(field: string, expr: string): string {
  const h = createHash('sha256').update(expr).digest('hex').slice(0, 8);
  return `records_f_${field.slice(0, 40)}_${h}`;
}

/** The indexes the stored schema `fields` call for. */
export function filterIndexesFor(storedFields: unknown): FilterIndex[] {
  const seen = new Set<string>();
  const out: FilterIndex[] = [];
  for (const f of servedFields(storedFields).filter((x: ServedField) => x.filterable.length > 0)) {
    const expr = fieldExpr(f.name, f.type);
    const name = filterIndexName(f.name, expr);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, field: f.name, expr });
  }
  return out;
}

/**
 * Create the filter indexes for `storedFields`. `concurrently: false` builds them with a plain
 * `CREATE INDEX` (usable inside a transaction, e.g. a test that wraps everything in one).
 * Returns the index names (existing ones included).
 */
export async function ensureFilterIndexes(
  q: Queryable,
  storedFields: unknown,
  opts: { concurrently?: boolean } = {},
): Promise<string[]> {
  const concurrently = opts.concurrently ?? true;
  const indexes = filterIndexesFor(storedFields);
  for (const ix of indexes) {
    const { rows } = await q.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1 AND pg_table_is_visible(c.oid)`,
      [ix.name],
    );
    if (rows[0]?.valid) continue;
    if (rows[0]) {
      await q.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ${ix.name}`);
    }
    await q.query(
      `CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${ix.name}
         ON records (dataset_id, (${ix.expr}))`,
    );
  }
  return indexes.map((i) => i.name);
}
