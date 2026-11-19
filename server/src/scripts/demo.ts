import { createApplication } from '../applications/repo.js';
import { ConfigError, loadConfig } from '../config.js';
import { createLogger } from '../logging.js';
import { createPool } from '../db/pool.js';
import { DemoError, runDemo } from '../demo/run-demo.js';

// Usage: npm run demo -w server
//
// Needs, already running with the same .env: the API (npm run dev:api -w server), the
// worker (npm run dev:worker -w server) and the mock consumer (npm run dev -w mock-consumer).
// The .env must allow the local http:// consumer: ALLOW_HTTP_ENDPOINTS=true and
// RELAY_ALLOW_PRIVATE_NETWORKS=true. For a fast run also set e.g. RETRY_BASE_MS=500,
// CIRCUIT_FAILURE_THRESHOLD=3, CIRCUIT_COOLDOWN_MS=5000, HTTP_TIMEOUT_MS=2000, LEASE_MS=10000.
//
//   DEMO_API_URL   default http://127.0.0.1:<API_PORT>
//   DEMO_MOCK_URL  default http://127.0.0.1:4000 (must be reachable by the worker too)
//
// It creates a fresh application for each run (directly in the database, like create-app);
// the API key is used only in memory and never printed.

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool({
    connectionString: config.databaseUrl,
    logger: createLogger('warn'),
    max: 1,
    statementTimeoutMs: config.db.statementTimeoutMs,
    idleInTxTimeoutMs: config.db.idleInTxTimeoutMs,
    applicationName: 'relay-demo',
  });
  let apiKey: string;
  try {
    apiKey = (await createApplication(pool, `demo ${new Date().toISOString()}`)).apiKey;
  } finally {
    await pool.end();
  }

  await runDemo({
    apiUrl: process.env.DEMO_API_URL ?? `http://127.0.0.1:${config.api.port}`,
    mockUrl: process.env.DEMO_MOCK_URL ?? 'http://127.0.0.1:4000',
    apiKey,
    config,
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError || err instanceof DemoError ? `\nDemo stopped: ${err.message}` : err);
  process.exitCode = 1;
});
