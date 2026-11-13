import type { FastifyInstance } from 'fastify';
import { hashApiKey, looksLikeApiKey } from '../auth/api-keys.js';
import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated application. Set by the auth hook on every /v1 route. */
    appId: string;
  }
}

/**
 * Extract the token from `Authorization: Bearer <token>`.
 * The scheme name is case-insensitive (RFC 7235); the token itself is not.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer +(\S+)$/i.exec(header);
  return match?.[1];
}

/**
 * ONE response for missing, malformed and unknown keys, so a caller can't tell which
 * case they hit (no probing for valid key formats or existing keys).
 */
function unauthorized(): AppError {
  return new AppError(401, 'unauthorized', 'Missing or invalid API key');
}

/**
 * Add API-key authentication to every route of `scope` (an encapsulated plugin, e.g. /v1).
 *
 * Runs in `onRequest`, i.e. BEFORE the body is read and parsed, so an anonymous caller
 * can't make us buffer and parse a 256 KB JSON body.
 *
 * Lookup: SELECT ... WHERE api_key_hash = $1 with SHA-256(presented key). The comparison
 * happens on hashes inside the unique index; the caller can't steer the hash of a guess
 * towards a stored one, so lookup timing reveals nothing useful (no constant-time compare
 * needed). A database failure here surfaces as 503, never as a misleading 401.
 */
export function registerAuth(scope: FastifyInstance, db: Db): void {
  scope.addHook('onRequest', async (request, reply) => {
    const key = bearerToken(request.headers.authorization);
    // Cheap format check first: garbage never costs a DB round trip.
    if (key === undefined || !looksLikeApiKey(key)) {
      reply.header('www-authenticate', 'Bearer');
      throw unauthorized();
    }
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM applications WHERE api_key_hash = $1',
      [hashApiKey(key)],
    );
    const app = rows[0];
    if (!app) {
      reply.header('www-authenticate', 'Bearer');
      throw unauthorized();
    }
    request.appId = app.id;
  });
}
