import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

/**
 * The api.md error envelope `{ error: { code, message, details } }` (SP-001a). Throw an
 * `ApiError` anywhere in a handler or hook; the error handler turns it, Zod errors and Fastify's
 * own 4xx errors into the envelope. Anything else is a 500 with no internal detail.
 * SP-007a extends this (shared error-code union from @spigot/shared, auth / CSRF / rate limits).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function envelope(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return { error: details ? { code, message, details } : { code, message } };
}

export function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  return reply.code(err.status).send(envelope(err.code, err.message, err.details));
}

/** Zod issues as `{ path, message }` pairs, safe to return to the client. */
function issuesOf(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Validate `data` with `schema`; throws `400 VALIDATION_ERROR` with the issues on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown, what = 'request'): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Invalid ${what}.`, {
      issues: issuesOf(result.error),
    });
  }
  return result.data;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError | z.ZodError | Error, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    if (err instanceof z.ZodError) {
      return sendError(
        reply,
        new ApiError(400, 'VALIDATION_ERROR', 'Invalid request.', { issues: issuesOf(err) }),
      );
    }
    // Fastify's own client errors: malformed JSON, wrong content type, body too large.
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      if (status === 429) {
        return sendError(reply, new ApiError(429, 'RATE_LIMITED', 'Too many requests.'));
      }
      return sendError(reply, new ApiError(status, 'VALIDATION_ERROR', err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send(envelope('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.'));
  });

  app.setNotFoundHandler((req, reply) =>
    sendError(reply, new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.url}.`)),
  );
}
