import { pino } from 'pino';
import { ConfigError, loadConfig } from '../config.js';
import { startWorker } from './start.js';

// Entry point for the delivery worker process: `npm run dev:worker -w server`.
// Run several of these against the same database to scale out: SKIP LOCKED claims keep
// them from ever taking the same delivery.

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = pino({ level: config.logLevel });

  const worker = await startWorker(config, logger);

  // worker.stop() waits up to HTTP_TIMEOUT_MS + 5 s for in-progress deliveries; allow a
  // little more before forcing the exit. Anything unfinished is recovered by lease expiry.
  const graceMs = config.worker.httpTimeoutMs + 10_000;

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, graceMs).unref();

    worker.stop().then(
      () => logger.info('worker process stopped'),
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
