/**
 * Error handling.
 *
 * Every failure the client is meant to react to is an `ApiError` with a stable machine
 * code. Anything else that escapes a handler is treated as a bug: it is logged in full
 * server-side and reported to the client as a bare 500, so internal details (SQL text,
 * file paths, stack traces) never leak.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'INVALID_TOKEN'
  | 'FORBIDDEN'
  | 'MISSING_PERMISSIONS'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ALREADY_EXISTS'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'REGISTRATION_DISABLED'
  | 'EMAIL_NOT_VERIFIED'
  | 'BANNED'
  | 'INTERNAL_ERROR';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, string[]>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = 'Bad request', details?: Record<string, string[]>) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'You must be signed in') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static invalidCredentials(message = 'Incorrect username or password') {
    return new ApiError(401, 'INVALID_CREDENTIALS', message);
  }
  static forbidden(message = 'You do not have access to this') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static missingPermissions(message = 'You are missing permissions to do that') {
    return new ApiError(403, 'MISSING_PERMISSIONS', message);
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message = 'That conflicts with something that already exists') {
    return new ApiError(409, 'CONFLICT', message);
  }
  static alreadyExists(message = 'That already exists') {
    return new ApiError(409, 'ALREADY_EXISTS', message);
  }
  static tooLarge(message = 'That file is too large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', message);
  }
  static unsupportedMedia(message = 'That file type is not allowed') {
    return new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
  static rateLimited(message = 'You are doing that too fast. Slow down.') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }
  static emailNotVerified(message = 'Confirm your email address to sign in') {
    return new ApiError(403, 'EMAIL_NOT_VERIFIED', message);
  }
}

/** Flatten a ZodError into `{ fieldPath: [messages] }` for inline form errors. */
export function zodDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

export function fromZodError(error: ZodError): ApiError {
  return new ApiError(
    400,
    'VALIDATION_FAILED',
    'Some fields need fixing',
    zodDetails(error),
  );
}

/** Human phrasing for a wait in seconds. */
function describeWait(seconds: number): string {
  if (seconds <= 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

function rateLimitMessage(reply: FastifyReply): string {
  const header = reply.getHeader('retry-after');
  const raw = Number(Array.isArray(header) ? header[0] : header);
  if (!Number.isFinite(raw) || raw <= 0) return 'You are doing that too fast. Slow down.';

  /*
   * Older releases of @fastify/rate-limit reported Retry-After in milliseconds rather
   * than seconds, and the two are indistinguishable from the value alone. Anything above
   * an hour is far outside every limit configured here, so it is the millisecond form.
   */
  const seconds = raw > 3600 ? raw / 1000 : raw;
  return `Too many attempts. Try again in ${describeWait(seconds)}.`;
}

/**
 * Fastify's global error handler. Registered once in `app.ts` so that no route needs its
 * own try/catch just to produce a sane response body.
 */
export function errorHandler(
  error: FastifyError | ApiError | ZodError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof ApiError) {
    reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  if (error instanceof ZodError) {
    const apiError = fromZodError(error);
    reply.status(apiError.statusCode).send({
      error: { code: apiError.code, message: apiError.message, details: apiError.details },
    });
    return;
  }

  const fastifyError = error as FastifyError;

  // @fastify/rate-limit and @fastify/multipart raise their own typed errors; translate
  // them into our vocabulary so clients only ever parse one error shape.
  if (fastifyError.statusCode === 429) {
    /*
     * Say how long, not just "slow down".
     *
     * Without a number this is indistinguishable from a permanent failure, and the honest
     * reaction to it is to keep clicking -- which is the one thing that makes it worse.
     */
    reply.status(429).send({
      error: { code: 'RATE_LIMITED', message: rateLimitMessage(reply) },
    });
    return;
  }
  if (fastifyError.code === 'FST_REQ_FILE_TOO_LARGE' || fastifyError.statusCode === 413) {
    reply.status(413).send({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is too large' },
    });
    return;
  }
  if (fastifyError.statusCode && fastifyError.statusCode < 500) {
    reply.status(fastifyError.statusCode).send({
      error: {
        code: 'BAD_REQUEST',
        message: fastifyError.message || 'Bad request',
      },
    });
    return;
  }

  request.log.error(
    { err: error, url: request.url, method: request.method },
    'unhandled error',
  );
  reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our end' },
  });
}
