import { pino } from 'pino';
import { applicationNameSchema, createApplication } from '../applications/repo.js';
import { ConfigError, loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

// Usage: npm run create-app -w server -- <name>
//
// Prints the new API key to STDOUT exactly once. It is deliberately NOT passed to the
// logger: log output is often collected and shipped elsewhere, and CLAUDE.md forbids
// logging API keys. stdout goes only to the operator's terminal.

const USAGE = 'Usage: npm run create-app -w server -- <name>';

async function main(): Promise<void> {
  const parsedName = applicationNameSchema.safeParse(process.argv.slice(2).join(' '));
  if (!parsedName.success) {
    console.error(`Application name must be 1-200 characters.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(process.env);
  const logger = pino({ level: config.logLevel });
  const pool = createPool({
    connectionString: config.databaseUrl,
    logger,
    max: 1,
    statementTimeoutMs: config.db.statementTimeoutMs,
    idleInTxTimeoutMs: config.db.idleInTxTimeoutMs,
    applicationName: 'relay-create-app',
  });

  try {
    const app = await createApplication(pool, parsedName.data);
    logger.info({ app_id: app.id }, 'application created'); // id only, never the key
    console.log(
      [
        '',
        'Application created',
        `  id:      ${app.id}`,
        `  name:    ${app.name}`,
        `  API key: ${app.apiKey}`,
        '',
        'Store this key now. It is shown only once and cannot be recovered',
        '(only its SHA-256 hash is stored). Use it as: Authorization: Bearer <key>',
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exitCode = 1;
});
