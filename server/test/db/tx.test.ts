import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { createTestPool, useTestDb } from '../helpers/db.js';

const db = useTestDb(); // admin pool + truncation
let pool: pg.Pool; // the pool under test, small so counts are easy to assert

beforeEach(() => {
  pool = createTestPool(2);
});
afterEach(async () => {
  await pool.end();
});

const appCount = async () =>
  (await db().query<{ n: number }>('SELECT count(*)::int AS n FROM applications')).rows[0]!.n;

const insertApp = (client: pg.PoolClient, name: string) =>
  client.query(
    `INSERT INTO applications (name, api_key_hash)
     VALUES ($1::text, sha256(convert_to($1::text, 'UTF8')))`,
    [name],
  );

describe('withTransaction', () => {
  it('commits and returns fn\'s result; the client goes back to the pool', async () => {
    const result = await withTransaction(pool, async (client) => {
      await insertApp(client, 'a');
      return 42;
    });
    expect(result).toBe(42);
    expect(await appCount()).toBe(1);
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1); // released, reusable
  });

  it('rolls back every statement when fn throws, and rethrows the original error', async () => {
    const boom = new Error('boom');
    await expect(
      withTransaction(pool, async (client) => {
        await insertApp(client, 'a');
        await insertApp(client, 'b');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await appCount()).toBe(0);
    expect(pool.idleCount).toBe(1); // a healthy client is still reused
  });

  it('rolls back after a failed statement (aborted transaction)', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await insertApp(client, 'a');
        await client.query('SELECT 1/0'); // 22012
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect(await appCount()).toBe(0);
  });

  it('survives the connection being killed mid-transaction: no crash, rejects, client destroyed', async () => {
    // If withTransaction did NOT listen for 'error' on the checked-out client, the
    // termination below would be an unhandled 'error' event: the process (here, the
    // vitest worker) would crash and this test would fail with an unhandled error.
    await expect(
      withTransaction(pool, async (client) => {
        await insertApp(client, 'a');
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const ended = new Promise((resolve) => client.once('end', resolve));
        await db().query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
        await ended; // the client has now emitted 'error' while idle and closed
        await client.query('SELECT 1'); // → rejects: not queryable
      }),
    ).rejects.toThrow();

    expect(await appCount()).toBe(0); // server rolled back the dead session's transaction
    expect(pool.totalCount).toBe(0); // broken client destroyed, not returned to the pool
    // The pool still works: next transaction opens a fresh connection.
    await withTransaction(pool, (client) => insertApp(client, 'b'));
    expect(await appCount()).toBe(1);
  });
});
