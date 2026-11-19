import { pino, stdSerializers, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './config.js';

// One logger factory for every process (API, worker, scripts), so the same protections apply
// everywhere (CLAUDE.md: never log secrets, API keys or full payloads).
//
// 1. Redaction: the Authorization header (API key) if a request's headers are ever logged.
// 2. Error scrubbing: errors are logged as `{ err }`, and pino's standard serializer copies
//    every field of the error. A PostgreSQL error carries, besides its message:
//      detail         e.g. 'Failing row contains (…)' — the WHOLE row, which can include a
//                     message payload or a consumer's response excerpt, or 'Key (…)=(…)'
//      where          PL/pgSQL / context lines, which can quote values
//      internalQuery  SQL text of an internal query
//    These are dropped, also from nested `cause` errors. What stays (message, code,
//    constraint, table, column, stack) is enough to find the bug.

const SCRUBBED_ERROR_FIELDS = ['detail', 'where', 'internalQuery'] as const;
const MAX_DEPTH = 5;

/** Pure: a serialized error with the data-bearing PostgreSQL fields removed (recursively). */
export function scrubError(value: unknown, depth = 0): unknown {
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => scrubError(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if ((SCRUBBED_ERROR_FIELDS as readonly string[]).includes(key)) continue;
    out[key] = key === 'cause' || key === 'aggregateErrors' ? scrubError(v, depth + 1) : v;
  }
  return out;
}

export function serializeError(err: unknown): unknown {
  return scrubError(err instanceof Error ? stdSerializers.err(err) : err);
}

export const REDACT_PATHS = ['req.headers.authorization', 'headers.authorization'];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: REDACT_PATHS,
    serializers: { err: serializeError, error: serializeError },
  };
  return destination ? pino(options, destination) : pino(options);
}
