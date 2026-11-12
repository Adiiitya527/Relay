import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { testDatabaseUrl } from '../helpers/test-db.js';

const url = testDatabaseUrl();
let admin: pg.Client | undefined;

beforeAll(async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  admin = client; // only after a successful connect, so afterAll can't touch a dead client
});

afterAll(async () => {
  await admin?.end();
});

describe('createPool', () => {
  it('applies statement_timeout and idle_in_transaction_session_timeout to its sessions', async () => {
    const pool = createPool({
      connectionString: url,
      logger: { error: vi.fn() },
      statementTimeoutMs: 5000,
      idleInTxTimeoutMs: 10000,
    });
    try {
      const { rows } = await pool.query(
        `SELECT current_setting('statement_timeout') AS st,
                current_setting('idle_in_transaction_session_timeout') AS it`,
      );
      expect(rows[0]).toEqual({ st: '5s', it: '10s' });
    } finally {
      await pool.end();
    }
  });

  it('statement_timeout cancels a long statement (SQLSTATE 57014)', async () => {
    const pool = createPool({ connectionString: url, logger: { error: vi.fn() }, statementTimeoutMs: 200 });
    try {
      await expect(pool.query('SELECT pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
    } finally {
      await pool.end();
    }
  });

  it('idle_in_transaction_session_timeout kills a leaked transaction (backs invariant 3)', async () => {
    const pool = createPool({ connectionString: url, logger: { error: vi.fn() }, idleInTxTimeoutMs: 300 });
    const client = await pool.connect();
    // A checked-out client has no pool error listener. When the server kills the session
    // while the client is idle, pg emits 'error' on the client; we must listen for it.
    const clientErrors: Array<{ code?: string }> = [];
    client.on('error', (err) => clientErrors.push(err as { code?: string }));
    try {
      await client.query('BEGIN'); // ...then "forget" to COMMIT
      await vi.waitFor(() => expect(clientErrors[0]?.code).toBe('25P03'), { timeout: 3000 });
      await expect(client.query('SELECT 1')).rejects.toThrow();
    } finally {
      client.release(true); // destroy, don't return the dead client to the pool
      await pool.end();
    }
  });

  it('survives an idle client being terminated (no crash; error logged; pool recovers)', async () => {
    const logger = { error: vi.fn() };
    const pool = createPool({ connectionString: url, logger, applicationName: 'relay-pool-test' });
    try {
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      // The client is now idle in the pool. Kill its server process, as a DB restart would.
      await admin!.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);

      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(logger.error.mock.calls[0]![0].err).toMatchObject({ code: '57P01' }); // admin_shutdown

      // The pool discarded the dead client and opens a fresh one.
      await expect(pool.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    } finally {
      await pool.end();
    }
  });
});
