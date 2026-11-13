import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Every error response has the shape { "error": { "code": "snake_case", "message": "..." } }
 * (CLAUDE.md). Route code throws AppError for expected failures; everything else is mapped
 * here in ONE place, so no handler can accidentally leak a stack trace or a raw DB message.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

// --- Is the database unreachable / overloaded? --------------------------------------------
// Those are 503s (the client should retry later), not 500s (a bug on our side).

/** Node socket errors seen when Postgres can't be reached or the connection drops. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * SQLSTATEs meaning "the database can't serve you right now":
 *   class 08 connection_exception · 57P01 admin_shutdown (incl. pg_terminate_backend)
 *   57P02 crash_shutdown · 57P03 cannot_connect_now (starting up)
 *   53300 too_many_connections · 57014 query_canceled (our statement_timeout fired)
 */
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300', '57014']);

/** pg / pg-pool raise these as plain Errors without a code, so match on the message. */
const UNAVAILABLE_MESSAGES = [
  /^Connection terminated/, // socket closed under an active query
  /timeout exceeded when trying to connect/, // pool connectionTimeoutMillis
  /^Cannot use a pool after calling end/, // request racing graceful shutdown
];

export function isDatabaseUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code)) return true;
    if (/^08[0-9A-Z]{3}$/.test(code)) return true;
  }
  if (UNAVAILABLE_MESSAGES.some((re) => re.test(err.message))) return true;
  // Node's happy-eyeballs connect (localhost -> ::1 and 127.0.0.1) reports an AggregateError.
  if (err instanceof AggregateError) return err.errors.some(isDatabaseUnavailable);
  return false;
}

// --- Fastify's own request errors -----------------------------------------------------------
// Mapped by code to fixed messages. We never forward a JSON parser's message: V8's
// SyntaxError text quotes a slice of the request body.
const FASTIFY_ERRORS: Record<string, [status: number, code: string, message: string]> = {
  FST_ERR_CTP_BODY_TOO_LARGE: [413, 'payload_too_large', 'Request body is too large'],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [
    415,
    'unsupported_media_type',
    'Content-Type must be application/json',
  ],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, 'invalid_json', 'Request body is not valid JSON'],
  FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'invalid_json', 'Request body is empty'],
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: [
    400,
    'bad_request',
    'Request body size did not match Content-Length',
  ],
};

export function formatZodIssues(error: z.ZodError, where?: string): string {
  // Zod issue messages describe the rule ("expected string"), not the received value.
  return error.issues
    .map((i) => {
      const path = [where, ...i.path.map(String)].filter(Boolean).join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}

/** Install the error and 404 handlers on the ROOT instance (child plugins inherit them). */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | Error>((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorBody(err.code, err.message));
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send(errorBody('validation_failed', formatZodIssues(err)));
    }
    const known = 'code' in err && typeof err.code === 'string' ? FASTIFY_ERRORS[err.code] : undefined;
    if (known) {
      const [status, code, message] = known;
      return reply.status(status).send(errorBody(code, message));
    }
    if (isDatabaseUnavailable(err)) {
      request.log.warn({ err }, 'database unavailable');
      return reply
        .status(503)
        .header('retry-after', '5')
        .send(errorBody('database_unavailable', 'Database temporarily unavailable; retry later'));
    }
    // Any other client error Fastify raised itself (it sets statusCode 4xx on those).
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send(errorBody('bad_request', 'Bad request'));
    }
    // Everything else is a bug. Log it fully; tell the client nothing about internals.
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send(errorBody('internal_error', 'Internal server error'));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send(errorBody('not_found', `Route ${request.method} ${request.url.split('?')[0]} not found`));
  });
}
