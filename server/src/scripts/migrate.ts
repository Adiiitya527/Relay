import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { ConfigError, loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';

// Usage: npm run migrate -w server   (applies server/migrations/*.sql to DATABASE_URL)

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({ level: config.logLevel });

  // Note: deliberately NOT createPool(): the runner opens its own connection with
  // statement_timeout disabled (plan A1).
  const result = await migrate({
    connection: { connectionString: config.databaseUrl },
    dir: MIGRATIONS_DIR,
    logger,
  });
  logger.info(
    { applied: result.applied, previously_applied: result.alreadyApplied },
    result.applied.length ? 'migrations applied' : 'database is up to date',
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    // pino is not available if config failed, so the fallback is plain stderr.
    // pg errors never contain the connection string, so this does not leak the password.
    console.error('migration failed:', err);
  }
  process.exitCode = 1;
});
