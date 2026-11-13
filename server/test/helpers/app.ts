import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { pino } from 'pino';
import { buildApp } from '../../src/api/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { testDatabaseUrl } from './test-db.js';

export const silentLogger = pino({ level: 'silent' });

/** A real, validated Config pointed at the TEST database. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: testDatabaseUrl(), LOG_LEVEL: 'silent', ...overrides });
}

export function buildTestApp(pool: pg.Pool, overrides: Record<string, string> = {}): FastifyInstance {
  return buildApp({ config: testConfig(overrides), pool, logger: silentLogger });
}

/**
 * A pool whose server can never be reached (nothing listens on port 1), to exercise the
 * "database down" paths without stopping the real PostgreSQL service. No password in it.
 */
export function unreachablePool(): pg.Pool {
  return createPool({
    connectionString: 'postgresql://relay@127.0.0.1:1/relay_test',
    connectionTimeoutMs: 1_000,
    logger: { error: () => {} },
  });
}
