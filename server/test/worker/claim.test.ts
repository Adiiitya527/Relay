import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { withTransaction } from '../../src/db/tx.js';
import { claimDeliveries } from '../../src/worker/queue.js';
import { unreachablePool } from '../helpers/app.js';
import {
  insertApp,
  insertDelivery,
  insertDeliveryGraph,
  insertEndpoint,
  insertMessage,
  useTestDb,
} from '../helpers/db.js';

const getPool = useTestDb();
const LEASE_MS = 30_000;
const claim = (limit: number, workerId = 'worker-a', db: pg.Pool = getPool()) =>
  claimDeliveries(db, { limit, leaseMs: LEASE_MS, workerId });

afterEach(() => {
  vi.useRealTimers();
});

/** n pending deliveries on one endpoint, created with set-based SQL (fast for n = 200). */
async function insertManyDeliveries(pool: pg.Pool, n: number) {
  const appId = await insertApp(pool);
  const endpointId = await insertEndpoint(pool, appId);
  await pool.query(
    `WITH m AS (
       INSERT INTO messages (app_id, event_type, payload)
       SELECT $1, 'bulk.test', jsonb_build_object('i', i) FROM generate_series(1, $3::int) i
       RETURNING id
     )
     INSERT INTO deliveries (app_id, message_id, endpoint_id) SELECT $1, m.id, $2 FROM m`,
    [appId, endpointId, n],
  );
  return { appId, endpointId };
}

async function deliveryRow(id: string) {
  const { rows } = await getPool().query(
    `SELECT status, attempt_count, lease_token, locked_by,
            (extract(epoch FROM locked_until - now()) * 1000)::float8 AS lease_left_ms
       FROM deliveries WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe('claimDeliveries', () => {
  it('leases a due delivery and returns everything needed to send it', async () => {
    const pool = getPool();
    const appId = await insertApp(pool);
    const endpointId = await insertEndpoint(pool, appId, { url: 'https://example.com/a?b=1' });
    const messageId = await insertMessage(pool, appId, { payload: { z: 1, a: [true, null] } });
    const deliveryId = await insertDelivery(pool, { appId, messageId, endpointId });

    const [claimed, ...rest] = await claim(5);
    expect(rest).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT payload::text AS body, (SELECT secret FROM endpoints WHERE id = $2) AS secret
         FROM messages WHERE id = $1`,
      [messageId, endpointId],
    );
    expect(claimed).toEqual({
      id: deliveryId,
      message_id: messageId,
      endpoint_id: endpointId,
      attempt_count: 1,
      lease_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
      body: rows[0].body, // exactly payload::text (jsonb's normalised form)
      url: 'https://example.com/a?b=1',
      secret: rows[0].secret,
    });
    expect(claimed!.body).toBe('{"a": [true, null], "z": 1}');

    const row = await deliveryRow(deliveryId);
    expect(row).toMatchObject({ status: 'in_flight', attempt_count: 1, locked_by: 'worker-a' });
    expect(row.lease_token).toBe(claimed!.lease_token);
    expect(row.lease_left_ms).toBeGreaterThan(LEASE_MS - 2_000); // DB clock lease
    expect(row.lease_left_ms).toBeLessThanOrEqual(LEASE_MS);
  });

  it('issues a fresh lease token on every claim', async () => {
    const pool = getPool();
    const { deliveryId } = await insertDeliveryGraph(pool);
    const first = await claim(1);
    // Put it back to pending by hand (what a failed attempt would do).
    await pool.query(
      `UPDATE deliveries SET status = 'pending', locked_until = NULL, lease_token = NULL,
              locked_by = NULL WHERE id = $1`,
      [deliveryId],
    );
    const second = await claim(1);
    expect(second[0]!.lease_token).not.toBe(first[0]!.lease_token);
    expect(second[0]!.attempt_count).toBe(2);
  });

  it('returns [] for limit 0 without touching the database', async () => {
    const dead = unreachablePool();
    try {
      await expect(claimDeliveries(dead, { limit: 0, leaseMs: 1, workerId: 'w' })).resolves.toEqual(
        [],
      );
    } finally {
      await dead.end();
    }
  });

  it('takes at most `limit` rows, oldest due first', async () => {
    const pool = getPool();
    await insertManyDeliveries(pool, 5);
    await pool.query(
      `UPDATE deliveries d SET next_attempt_at = now() - (x.n * interval '1 second')
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM deliveries) x
        WHERE d.id = x.id`,
    );
    const { rows: expected } = await pool.query(
      'SELECT id FROM deliveries ORDER BY next_attempt_at LIMIT 2',
    );
    const claimed = await claim(2);
    expect(claimed.map((c) => c.id).sort()).toEqual(expected.map((r) => r.id).sort());
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM deliveries WHERE status = 'pending'`);
    expect(rows[0].n).toBe(3);
  });

  describe('skips rows that are not due or are paused (no attempt consumed)', () => {
    async function expectNotClaimed(setup: (g: Awaited<ReturnType<typeof insertDeliveryGraph>>) => Promise<unknown>) {
      const pool = getPool();
      const graph = await insertDeliveryGraph(pool);
      await setup(graph);
      const before = await pool.query('SELECT * FROM deliveries WHERE id = $1', [graph.deliveryId]);
      expect(await claim(10)).toEqual([]);
      const after = await pool.query('SELECT * FROM deliveries WHERE id = $1', [graph.deliveryId]);
      expect(after.rows[0]).toEqual(before.rows[0]); // untouched, attempt_count included
    }

    it('next_attempt_at in the future', () =>
      expectNotClaimed(({ deliveryId }) =>
        getPool().query(
          `UPDATE deliveries SET next_attempt_at = now() + interval '1 minute' WHERE id = $1`,
          [deliveryId],
        ),
      ));

    it('endpoint disabled', () =>
      expectNotClaimed(({ endpointId }) =>
        getPool().query('UPDATE endpoints SET disabled = true WHERE id = $1', [endpointId]),
      ));

    it('circuit open and still cooling down', () =>
      expectNotClaimed(({ endpointId }) =>
        getPool().query(
          `UPDATE endpoints SET circuit_state = 'open', circuit_open_until = now() + interval '1 minute'
            WHERE id = $1`,
          [endpointId],
        ),
      ));

    it('circuit half_open (its single probe is already out)', () =>
      expectNotClaimed(({ endpointId }) =>
        getPool().query(`UPDATE endpoints SET circuit_state = 'half_open' WHERE id = $1`, [endpointId]),
      ));

    it.each(['succeeded', 'dead'])('status %s', (status) =>
      expectNotClaimed(({ deliveryId }) =>
        getPool().query(`UPDATE deliveries SET status = $2, completed_at = now() WHERE id = $1`, [
          deliveryId,
          status,
        ]),
      ),
    );

    it('already in_flight (leased by another worker)', () =>
      expectNotClaimed(({ deliveryId }) =>
        getPool().query(
          `UPDATE deliveries SET status = 'in_flight', locked_until = now() + interval '1 minute',
                  lease_token = gen_random_uuid(), locked_by = 'other' WHERE id = $1`,
          [deliveryId],
        ),
      ));
  });

  it('claims again once an open circuit has cooled down', async () => {
    const pool = getPool();
    const { endpointId, deliveryId } = await insertDeliveryGraph(pool);
    await pool.query(
      `UPDATE endpoints SET circuit_state = 'open', circuit_open_until = now() - interval '1 second'
        WHERE id = $1`,
      [endpointId],
    );
    expect((await claim(1)).map((c) => c.id)).toEqual([deliveryId]);
  });

  it('uses the DB clock: a worker clock 1 h ahead does not make future rows due', async () => {
    const pool = getPool();
    const { deliveryId } = await insertDeliveryGraph(pool);
    await pool.query(
      `UPDATE deliveries SET next_attempt_at = now() + interval '10 minutes' WHERE id = $1`,
      [deliveryId],
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    expect(await claim(10)).toEqual([]);
  });

  it('skips a row locked by another transaction instead of waiting for it (SKIP LOCKED)', async () => {
    const pool = getPool();
    await insertManyDeliveries(pool, 3);
    await withTransaction(pool, async (client) => {
      // Another worker's claim in progress: it holds the row lock until it commits.
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM deliveries ORDER BY id LIMIT 1 FOR UPDATE',
      );
      const started = performance.now();
      // Without SKIP LOCKED this would wait for the lock, which is held until this very
      // callback returns: the claim would hang until statement_timeout.
      const claimed = await claim(10);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(claimed).toHaveLength(2);
      expect(claimed.map((c) => c.id)).not.toContain(rows[0]!.id);
    });
  });

  it('never claims a row twice under concurrent workers (FOR UPDATE SKIP LOCKED)', async () => {
    const pool = getPool(); // max 20 connections (plan A2)
    await insertManyDeliveries(pool, 200);

    // 8 workers, each claiming 7 at a time until nothing is left.
    const workers = Array.from({ length: 8 }, async (_, w) => {
      const mine: string[] = [];
      for (;;) {
        const batch = await claim(7, `worker-${w}`, pool);
        if (batch.length === 0) return mine;
        mine.push(...batch.map((b) => b.id));
      }
    });
    const results = await Promise.all(workers);
    const all = results.flat();

    expect(all).toHaveLength(200); // nothing claimed twice…
    expect(new Set(all).size).toBe(200); // …and nothing missed
    expect(results.filter((r) => r.length > 0).length).toBeGreaterThan(1); // real concurrency
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'in_flight' AND attempt_count = 1)::int AS ok,
              count(*)::int AS total
         FROM deliveries`,
    );
    expect(rows[0]).toEqual({ ok: 200, total: 200 });
  });
});
