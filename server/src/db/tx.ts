import type pg from 'pg';

/**
 * Run `fn` inside BEGIN ... COMMIT on one pooled client; ROLLBACK if it throws.
 *
 * Keep `fn` short and DB-only (invariant 3): never await network I/O inside it.
 * The pool's idle_in_transaction_session_timeout is the server-side backstop.
 *
 * Two details that matter:
 *
 * 1. Error listener while checked out. pg-pool removes its own 'error' listener from a
 *    client when it hands the client out. If the connection dies while we hold it (DB
 *    restart, pg_terminate_backend, idle-in-transaction kill), the client emits 'error';
 *    with no listener, Node treats that as an unhandled 'error' event and CRASHES THE
 *    PROCESS. So we listen for the whole checkout. The failure itself still reaches the
 *    caller as a rejected query.
 *
 * 2. Never return a broken client to the pool. If the connection errored or ROLLBACK
 *    failed, `release(true)` destroys the client instead of handing it to the next caller.
 *
 * If COMMIT fails because the connection dropped, the outcome is unknown (it may have
 * committed). The error propagates (→ 503); callers that retry must be idempotent, which
 * is what Idempotency-Key is for.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection unusable; the original error is the one that matters
    }
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}
