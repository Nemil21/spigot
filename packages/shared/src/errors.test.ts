import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_STATUS,
  errorEnvelope,
  errorEnvelopeSchema,
  errorStatus,
  isErrorCode,
} from './errors.js';

/** `| 402 | \`A\`, \`B\` |` rows from api.md §Errors. */
function specCodes(): Record<string, number> {
  const md = readFileSync(new URL('../../../docs/spec/api.md', import.meta.url), 'utf8');
  const out: Record<string, number> = {};
  for (const row of md.matchAll(/^\| (\d{3}) \| (.+) \|$/gm)) {
    for (const code of row[2]!.matchAll(/`([A-Z_]+)`/g)) out[code[1]!] = Number(row[1]);
  }
  return out;
}

describe('error codes', () => {
  it('covers every api.md code with its HTTP status, plus the ticket additions', () => {
    expect(ERROR_STATUS).toEqual({
      ...specCodes(),
      IDEMPOTENCY_KEY_EXPIRED: 409,
      INTERNAL_ERROR: 500,
    });
  });

  it('builds and parses the envelope', () => {
    const e = errorEnvelope('INSUFFICIENT_BALANCE', 'This call costs…', { balanceMicros: 12_000 });
    expect(e).toEqual({
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message: 'This call costs…',
        details: { balanceMicros: 12_000 },
      },
    });
    expect(errorEnvelope('NOT_FOUND', 'Not found')).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    expect(errorStatus('IDEMPOTENCY_KEY_EXPIRED')).toBe(409);
  });

  it('keeps 402 extras and rejects unknown codes', () => {
    const body = { ...errorEnvelope('PAYMENT_REQUIRED', 'Pay'), site: 'Bluebonnet Rentals' };
    expect(errorEnvelopeSchema.parse(body)).toEqual(body);
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(
      false,
    );
  });

  it('isErrorCode', () => {
    expect(ERROR_CODES.every(isErrorCode)).toBe(true);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode(402)).toBe(false);
  });
});
