// Opaque cursors (SP-015). Both bind the dataset id, so a cursor from dataset A used on dataset
// B is a 400 (features/05 §Edge cases). They are positions, not secrets: nothing here is signed,
// and nothing a buyer can put in one reaches SQL except as a typed parameter.
import { z } from 'zod';
import { ApiError } from '../http/errors.js';
import type { SortDirection } from './filters.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`: microseconds, so keyset ties are exact. */
const PG_UTC_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const MAX_CURSOR_LENGTH = 512;

function invalid(what: string): ApiError {
  return new ApiError('VALIDATION_ERROR', `Invalid ${what}.`);
}

function wrongDataset(what: string): ApiError {
  return new ApiError('VALIDATION_ERROR', `This ${what} belongs to a different dataset.`);
}

// ---------------------------------------------------------------------------------------------
// Records: keyset `(updated_at, id)` in the given sort direction.

export interface RecordsPosition {
  datasetId: string;
  /** `records.updated_at` at microsecond precision, UTC (`PG_UTC_MICROS`). */
  updatedAt: string;
  id: string;
  sort: SortDirection;
}

const recordsCursorSchema = z.strictObject({
  d: z.string().regex(UUID),
  u: z.string().regex(PG_UTC_MICROS),
  i: z.string().regex(UUID),
  s: z.enum(['desc', 'asc']),
});

export function encodeRecordsCursor(p: RecordsPosition): string {
  const body = { d: p.datasetId, u: p.updatedAt, i: p.id, s: p.sort };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

/** Decodes and checks a records cursor for `datasetId` and `sort`; throws 400 otherwise. */
export function decodeRecordsCursor(
  cursor: unknown,
  datasetId: string,
  sort: SortDirection,
): RecordsPosition {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw invalid('cursor');
  }
  let parsed: z.infer<typeof recordsCursorSchema>;
  try {
    const json: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    parsed = recordsCursorSchema.parse(json);
  } catch {
    throw invalid('cursor');
  }
  if (parsed.d.toLowerCase() !== datasetId.toLowerCase()) throw wrongDataset('cursor');
  if (parsed.s !== sort) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'This cursor was issued for a different sort; start again without it.',
    );
  }
  return { datasetId: parsed.d, updatedAt: parsed.u, id: parsed.i, sort: parsed.s };
}

// ---------------------------------------------------------------------------------------------
// Changes: `c_<base64url(datasetId:seq)>`. `since=0` (full history) is handled by the reader.

export function encodeChangesCursor(datasetId: string, seq: number): string {
  return `c_${Buffer.from(`${datasetId}:${seq}`, 'utf8').toString('base64url')}`;
}

/** Decodes a changes cursor for `datasetId` to its seq; throws 400 on garbage or another dataset. */
export function decodeChangesCursor(cursor: unknown, datasetId: string): number {
  if (typeof cursor !== 'string' || !cursor.startsWith('c_') || cursor.length > MAX_CURSOR_LENGTH) {
    throw invalid('changes cursor');
  }
  const body = cursor.slice(2);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw invalid('changes cursor');
  const text = Buffer.from(body, 'base64url').toString('utf8');
  const m = /^([0-9a-f-]{36}):(\d{1,16})$/i.exec(text);
  if (!m || !UUID.test(m[1]!)) throw invalid('changes cursor');
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq)) throw invalid('changes cursor');
  if (m[1]!.toLowerCase() !== datasetId.toLowerCase()) throw wrongDataset('changes cursor');
  return seq;
}
