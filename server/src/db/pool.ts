import pg from 'pg';

/**
 * Anything that can run a query: the pool (auto-checkout, one statement) or a checked-out
 * client (needed for multi-statement transactions). Data functions accept either.
 */
export type Db = pg.Pool | pg.PoolClient;

/** The only logger method the pool needs; a pino Logger satisfies it. */
export interface PoolLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CreatePoolOptions {
  connectionString: string;
  logger: PoolLogger;
  /** Max connections. Tests that make concurrent requests use >= 20 (plan A2). */
  max?: number;
  /**
   * Server-side cap on any single statement. Postgres cancels the statement with
   * SQLSTATE 57014. Set for API and worker pools; NEVER for the migration runner (A1).
   */
  statementTimeoutMs?: number;
  /**
   * Server-side safety net for invariant 3: if code leaves a transaction open and idle
   * (e.g. forgets COMMIT, or awaits something slow mid-transaction), Postgres terminates
   * the session and releases its row locks instead of letting it block the queue.
   */
  idleInTxTimeoutMs?: number;
  /** Shows up in pg_stat_activity; handy when debugging which process holds a lock. */
  applicationName?: string;
  /** How long to wait for a new connection before failing (client-side). */
  connectionTimeoutMs?: number;
}

/**
 * Create a pg Pool for the API or worker.
 *
 * `statement_timeout` and `idle_in_transaction_session_timeout` are sent as startup
 * parameters, so every connection the pool opens has them from its first query.
 */
export function createPool(opts: CreatePoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    application_name: opts.applicationName ?? 'relay',
    ...(opts.statementTimeoutMs !== undefined && { statement_timeout: opts.statementTimeoutMs }),
    ...(opts.idleInTxTimeoutMs !== undefined && {
      idle_in_transaction_session_timeout: opts.idleInTxTimeoutMs,
    }),
  });

  // An idle client in the pool can die at any time (DB restart, network drop,
  // pg_terminate_backend). pg reports that as an 'error' event on the pool; with no
  // listener, Node treats it as an unhandled 'error' event and CRASHES the process.
  // The pool discards the dead client by itself, so logging is all we need to do.
  pool.on('error', (err) => {
    opts.logger.error({ err }, 'idle postgres client error (client discarded)');
  });

  return pool;
}
