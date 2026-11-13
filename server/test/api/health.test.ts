import { describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { buildTestApp, unreachablePool } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { testDatabaseUrl } from '../helpers/test-db.js';

const db = useTestDb();

describe('GET /healthz', () => {
  it('200 { status: "ok" } when the database answers', async () => {
    const app = buildTestApp(db());
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('503 database_unavailable when the database cannot be reached', async () => {
    const pool = unreachablePool();
    const app = buildTestApp(pool);
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('database_unavailable');
    } finally {
      await app.close();
      await pool.end();
    }
  });

  it('after pg_terminate_backend kills its connections, the app recovers (no restart)', async () => {
    // A dedicated pool with a unique application_name so we kill only ITS sessions.
    const appName = `relay-health-test-${process.pid}`;
    const poolErrors = vi.fn();
    const pool = createPool({
      connectionString: testDatabaseUrl(),
      applicationName: appName,
      logger: { error: poolErrors },
    });
    const app = buildTestApp(pool);
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect(pool.idleCount).toBe(1);

      const { rows } = await db().query<{ killed: boolean }>(
        `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name = $1`,
        [appName],
      );
      expect(rows).toEqual([{ killed: true }]);

      // The pool hears about the dead idle client asynchronously, logs it and drops it.
      await vi.waitFor(() => expect(poolErrors).toHaveBeenCalled(), { timeout: 3_000 });
      expect(pool.idleCount).toBe(0);

      // The next request opens a fresh connection and succeeds.
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
