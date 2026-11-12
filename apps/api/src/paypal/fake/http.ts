/** Types and helpers shared by the SP-001c fake modules (refunds, payouts, webhooks). */

export const FAKE_PAYPAL_BASE = 'https://fake.paypal.local';

/** One request as a fake module sees it. `rawBody` is the exact text the client sent. */
export interface FakeRequest {
  method: string;
  path: string;
  headers: Headers;
  rawBody: string;
  /** `PayPal-Request-Id`, if sent. */
  requestId: string | null;
}

/** A fake answer. No `body` → an empty body (like S7's 403 decline). */
export interface Handled {
  http: number;
  body?: unknown;
}

let debugSeq = 0;

/** A fake PayPal `debug_id`. */
export function fakeDebugId(): string {
  return `fake${(++debugSeq).toString(16).padStart(8, '0')}`;
}

/** A PayPal-style error body: `{name, message, debug_id, details: [{issue, description}]}`. */
export function fakeError(
  http: number,
  name: string,
  issue?: string,
  description?: string,
  extra: Record<string, unknown> = {},
): Handled {
  return {
    http,
    body: {
      name,
      message: description ?? name,
      debug_id: fakeDebugId(),
      ...(issue ? { details: [{ issue, ...(description ? { description } : {}) }] } : {}),
      ...extra,
    },
  };
}

export const notFound = (): Handled =>
  fakeError(
    404,
    'RESOURCE_NOT_FOUND',
    'INVALID_RESOURCE_ID',
    'Specified resource ID does not exist.',
  );

/** Parse a request body; anything that isn't a JSON object is `{}`. */
export function parseBody(rawBody: string): Record<string, unknown> {
  if (!rawBody) return {};
  try {
    const v: unknown = JSON.parse(rawBody);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A PayPal-looking id: prefix + 13 upper-case base-36 characters, counting up from `seqStart`. */
export function makeIdFactory(seqStart = 0): (prefix: string) => string {
  let seq = seqStart;
  return (prefix) =>
    `${prefix}${(++seq)
      .toString(36)
      .toUpperCase()
      .padStart(13 - prefix.length, '0')}`;
}
