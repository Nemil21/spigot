import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ERROR_STATUS, errorEnvelope, type ErrorCode } from '@spigot/shared';

/**
 * The api.md error envelope `{ error: { code, message, details } }` (SP-001a). Throw an
 * `ApiError` anywhere in a handler or hook; the error handler turns it, Zod errors and Fastify's
 * own 4xx errors into the envelope. Anything else is a 500 with no internal detail.
 * The HTTP status always comes from `ERROR_STATUS` (@spigot/shared), so code and status agree.
 * `headers` are set on the error response (e.g. `Retry-After` on a 429 from `http/rateLimit.ts`).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string | number>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
  }
}

export function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  if (err.headers) reply.headers(err.headers);
  return reply.code(err.status).send(errorEnvelope(err.code, err.message, err.details));
}

/** Zod issues as `{ path, message }` pairs, safe to return to the client. */
function issuesOf(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Validate `data` with `schema`; throws `400 VALIDATION_ERROR` with the issues on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown, what = 'request'): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', `Invalid ${what}.`, { issues: issuesOf(result.error) });
  }
  return result.data;
}

/**
 * Fastify's own 4xx errors (malformed JSON, wrong content type, body too large, …) mapped to a
 * shared code. Statuses without their own code become 400 VALIDATION_ERROR, so the status sent is
 * always `ERROR_STATUS[code]`.
 */
const FASTIFY_4XX: Partial<Record<number, ErrorCode>> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError | z.ZodError | Error, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    if (err instanceof z.ZodError) {
      return sendError(
        reply,
        new ApiError('VALIDATION_ERROR', 'Invalid request.', { issues: issuesOf(err) }),
      );
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = FASTIFY_4XX[status] ?? 'VALIDATION_ERROR';
      return sendError(
        reply,
        new ApiError(code, code === 'RATE_LIMITED' ? 'Too many requests.' : err.message),
      );
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send(errorEnvelope('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.'));
  });

  app.setNotFoundHandler((req, reply) =>
    sendError(reply, new ApiError('NOT_FOUND', `No route for ${req.method} ${req.url}.`)),
  );
}
