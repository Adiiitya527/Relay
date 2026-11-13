import { pino } from 'pino';
import { startApi } from './api/start.js';
import { ConfigError, loadConfig } from './config.js';

// Entry point for the API process: `npm run dev:api -w server`.

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({
    level: config.logLevel,
    // Defence in depth: Fastify's default request log omits headers, but if anyone ever
    // logs them, the API key must not end up in log storage.
    redact: ['req.headers.authorization', 'headers.authorization'],
  });

  const api = await startApi(config, logger);
  logger.info({ host: api.address.address, port: api.address.port }, 'api listening');

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    // If a request hangs, don't hang forever: exit non-zero after the grace period.
    // unref() so this timer alone doesn't keep the process alive after a clean stop.
    setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();

    api.stop().then(
      () => logger.info('api stopped'),
      (err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exitCode = 1;
      },
    );
  };
  // SIGINT = Ctrl+C (works on Windows too); SIGTERM = Docker/Kubernetes stop.
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  // ConfigError messages contain variable names only, never values.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exitCode = 1;
});
