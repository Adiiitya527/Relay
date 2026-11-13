import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/pool.js';

/**
 * GET /healthz — unauthenticated readiness probe.
 * 200 { status: "ok" } if Postgres answers `SELECT 1`. If it doesn't, the query error goes
 * to the central error handler, which turns connection failures into 503
 * `database_unavailable`. The pool's statement_timeout bounds how long this can hang.
 */
export function registerHealthRoutes(app: FastifyInstance, db: Db): void {
  app.get('/healthz', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });
}
