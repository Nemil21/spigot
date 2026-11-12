import { z } from 'zod';

/**
 * API error envelope (api.md §Errors): `{ "error": { "code", "message", "details" } }`.
 * One table of codes and HTTP statuses, shared by the API (which sends them), the MCP server and
 * the web app (which branches on them). 402 bodies add top-level fields next to `error` (`site`,
 * `datasets`, `pay`, `quote`, `balanceMicros`; api.md §The 402 contract).
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNSUPPORTED_FILTER: 400,
  UNAUTHENTICATED: 401,
  KEY_REVOKED: 401,
  /** No balance, or an unauthenticated bot (gate and data API). */
  PAYMENT_REQUIRED: 402,
  INSUFFICIENT_BALANCE: 402,
  PRICE_ABOVE_MAX: 402,
  FORBIDDEN: 403,
  SITE_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 409,
  /** SP-016: same key and request, but the stored response body was purged (24 h). Never re-charges. */
  IDEMPOTENCY_KEY_EXPIRED: 409,
  CRAWL_IN_PROGRESS: 409,
  DATASET_UNPUBLISHED: 410,
  CURSOR_EXPIRED: 410,
  TOPUP_FAILED: 422,
  AUTO_TOPUP_CAP_REACHED: 422,
  REFUND_EXCEEDS_UNUSED: 422,
  RATE_LIMITED: 429,
  /** Unhandled server error; the message is generic and nothing internal is leaked. */
  INTERNAL_ERROR: 500,
  PAYPAL_ERROR: 502,
  ORIGIN_ERROR: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code);
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * Parses an error response on the client side (web, SDK tests, sim scripts). Extra top-level
 * fields (the 402 extras) are kept.
 */
export const errorEnvelopeSchema = z.looseObject({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
