import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { testDatabaseUrl } from './helpers/test-db.js';

/**
 * Runs once before the whole test run, in the main Vitest process (env is already
 * loaded by vitest.config.ts). Applies the real migrations to relay_test with the
 * same runner production uses, so tests always run against the real schema.
 *
 * testDatabaseUrl() is the safety guard: it refuses anything not named *_test or
 * identical to DATABASE_URL, before any SQL runs.
 */
export default async function setup(): Promise<void> {
  const result = await migrate({
    connection: { connectionString: testDatabaseUrl() },
    dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
    logger: { info: () => undefined },
  });
  if (result.applied.length > 0) {
    console.log(`[global-setup] applied to test database: ${result.applied.join(', ')}`);
  }
}
