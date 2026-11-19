import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { createPool } from '../db/pool.js';
import { createWorker } from './worker.js';

export interface RunningWorker {
  /** Graceful stop: idempotent; safe to call from several signal handlers. */
  stop(): Promise<void>;
}

/**
 * Create the pool, check the database is reachable, start the loops. Kept separate from
 * `index.ts` (which only wires OS signals) so the start/stop sequence is testable.
 *
 * Pool size: a connection is held only for one short statement or transaction at a time
 * (claim, record, sweep), never during HTTP. Up to `concurrency` results can be recorded
 * at once, plus one each for the claim and the sweeper; capped so a large
 * WORKER_CONCURRENCY cannot exhaust Postgres connections.
 */
export async function startWorker(config: Config, logger: Logger): Promise<RunningWorker> {
  const pool = createPool({
    connectionString: config.databaseUrl,
    logger,
    max: Math.min(config.worker.concurrency, 18) + 2,
    statementTimeoutMs: config.db.statementTimeoutMs,
    idleInTxTimeoutMs: config.db.idleInTxTimeoutMs,
    applicationName: 'relay-worker',
  });

  try {
    await pool.query('SELECT 1'); // fail fast on a wrong DATABASE_URL
  } catch (err) {
    await pool.end();
    throw err;
  }

  const worker = createWorker({ config, pool, logger });
  worker.start();

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      // ORDER MATTERS: in-progress deliveries still need the pool to record their
      // results, so the worker stops first and the pool ends last.
      stopping ??= (async () => {
        try {
          await worker.stop();
        } finally {
          await pool.end();
        }
      })();
      return stopping;
    },
  };
}
