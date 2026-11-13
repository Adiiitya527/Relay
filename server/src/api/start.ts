import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { createPool } from '../db/pool.js';
import { buildApp } from './app.js';

export interface RunningApi {
  /** The address actually bound (useful with port 0 in tests). */
  address: AddressInfo;
  /** Graceful stop: idempotent; safe to call from several signal handlers. */
  stop(): Promise<void>;
}

/**
 * Create the pool, build the app and listen. Kept separate from `server.ts` (which only
 * wires OS signals) so the start/stop sequence is testable.
 */
export async function startApi(config: Config, logger: Logger): Promise<RunningApi> {
  const pool = createPool({
    connectionString: config.databaseUrl,
    logger,
    statementTimeoutMs: config.db.statementTimeoutMs,
    idleInTxTimeoutMs: config.db.idleInTxTimeoutMs,
    applicationName: 'relay-api',
  });
  const app = buildApp({ config, pool, logger });

  try {
    await app.listen({ host: config.api.host, port: config.api.port });
  } catch (err) {
    await pool.end();
    throw err;
  }

  let stopping: Promise<void> | undefined;
  return {
    address: app.server.address() as AddressInfo,
    stop() {
      // ORDER MATTERS: app.close() first stops accepting connections and waits for
      // in-flight requests (which may still be using the pool) to finish; only then is
      // the pool ended. Reversed, those requests would fail with "pool after end".
      stopping ??= (async () => {
        try {
          await app.close();
        } finally {
          await pool.end();
        }
      })();
      return stopping;
    },
  };
}
