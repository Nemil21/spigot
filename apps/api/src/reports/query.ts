import { z } from 'zod';
import { ApiError } from '../http/errors.js';

/**
 * Query-string pieces shared by the read APIs in `reports/` (SP-030a). Everything a caller puts
 * here reaches SQL only as a typed parameter.
 */

/** `YYYY-MM-DD`, or a date-time with an optional zone (`Z` or `±HH:MM`). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** `?from=` / `?to=`: an ISO date or date-time. `from` is inclusive, `to` exclusive. */
const instant = z
  .string()
  .trim()
  .max(40)
  .regex(ISO_INSTANT, 'Expected an ISO date or date-time.')
  .transform((s, ctx) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Expected an ISO date or date-time.' });
      return z.NEVER;
    }
    return d;
  });

/** `?includeSim=`: `true` / `false` (also `1` / `0`); anything else is a 400. */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const rangeQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
});

export const includeSimQuery = z.object({
  includeSim: bool.default(true),
});

export interface Range {
  from?: Date;
  to?: Date;
}

export function checkRange(r: Range): void {
  if (r.from && r.to && r.from >= r.to) {
    throw new ApiError('VALIDATION_ERROR', '`from` must be before `to`.');
  }
}

/** `col >= $from AND col < $to` for whichever bounds are set; pushes them onto `params`. */
export function rangeSql(col: string, r: Range, params: unknown[]): string {
  const parts: string[] = [];
  if (r.from) {
    params.push(r.from);
    parts.push(`${col} >= $${params.length}`);
  }
  if (r.to) {
    params.push(r.to);
    parts.push(`${col} < $${params.length}`);
  }
  return parts.length ? parts.join(' AND ') : 'true';
}

const MAX_CURSOR_LENGTH = 256;

/** Opaque keyset cursor: base64url JSON checked by `schema`; a bad one is a 400. */
export function encodeCursor(body: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function decodeCursor<S extends z.ZodType>(schema: S, cursor: string): z.infer<S> {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) throw badCursor();
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw badCursor();
  }
}

function badCursor(): ApiError {
  return new ApiError('VALIDATION_ERROR', 'Invalid cursor.');
}

/** `to_char` pattern for an exact (microsecond) UTC timestamp, for keyset cursors. */
export const PG_UTC_MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export const UTC_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
