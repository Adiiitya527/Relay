import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { SendResult } from '../../src/delivery/http-client.js';
import {
  claimDeliveries,
  recordResult,
  sweepExpiredLeases,
  type ClaimedDelivery,
} from '../../src/worker/queue.js';
import { insertApp, insertDeliveryGraph, insertEndpoint, useTestDb } from '../helpers/db.js';

const getPool = useTestDb();
const MAX = 3;
const success: SendResult = { ok: true, status: 200, excerpt: 'ok', durationMs: 5 };
const recordOpts = {
  maxAttempts: MAX,
  backoffMs: 0,
  workerId: 'worker-a',
  circuit: { failureThreshold: 1_000, cooldownMs: 60_000 },
};

const claim = (limit = 1, workerId = 'worker-a') =>
  claimDeliveries(getPool(), { limit, leaseMs: 30_000, workerId });
const sweep = (db: pg.Pool = getPool(), opts: { maxAttempts?: number; batchSize?: number } = {}) =>
  sweepExpiredLeases(db, { maxAttempts: MAX, ...opts });

/** Simulate time passing beyond the lease: what a crashed worker leaves behind. */
async function expireLeases(ids?: string[]) {
  await getPool().query(
    `UPDATE deliveries SET locked_until = now() - interval '1 second'
      WHERE status = 'in_flight' AND ($1::uuid[] IS NULL OR id = ANY ($1))`,
    [ids ?? null],
  );
}

async function manyInFlight(n: number): Promise<ClaimedDelivery[]> {
  const pool = getPool();
  const appId = await insertApp(pool);
  const endpointId = await insertEndpoint(pool, appId);
  await pool.query(
    `WITH m AS (
       INSERT INTO messages (app_id, event_type, payload)
       SELECT $1, 'bulk.test', '{}'::jsonb FROM generate_series(1, $3::int) RETURNING id
     )
     INSERT INTO deliveries (app_id, message_id, endpoint_id) SELECT $1, m.id, $2 FROM m`,
    [appId, endpointId, n],
  );
  return claim(n);
}

async function attemptsOf(deliveryId: string) {
  const { rows } = await getPool().query(
    `SELECT lease_token, attempt_number, worker_id, duration_ms, error_kind, response_status
       FROM delivery_attempts WHERE delivery_id = $1 ORDER BY id`,
    [deliveryId],
  );
  return rows;
}

describe('sweepExpiredLeases', () => {
  it('returns an expired in_flight delivery to pending and logs a lease_expired attempt', async () => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    const [crashed] = await claim();
    await expireLeases();

    expect(await sweep()).toBe(1);
    const { rows } = await getPool().query(
      `SELECT status, attempt_count, last_error, lease_token, locked_by, locked_until,
              completed_at, next_attempt_at <= now() AS due
         FROM deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(rows[0]).toEqual({
      status: 'pending',
      attempt_count: 1, // the crashed attempt counts
      last_error: 'lease expired',
      lease_token: null,
      locked_by: null,
      locked_until: null,
      completed_at: null,
      due: true,
    });
    expect(await attemptsOf(deliveryId)).toEqual([
      {
        lease_token: crashed!.lease_token, // the claim that crashed, not a new one
        attempt_number: 1,
        worker_id: 'worker-a',
        duration_ms: null,
        error_kind: 'lease_expired',
        response_status: null,
      },
    ]);

    // …and it is delivered again as attempt 2.
    expect((await claim())[0]).toMatchObject({ id: deliveryId, attempt_count: 2 });
  });

  it('marks it dead if the crashed attempt was the last one allowed', async () => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    await claim();
    await expireLeases();
    expect(await sweep(getPool(), { maxAttempts: 1 })).toBe(1);
    const { rows } = await getPool().query(
      'SELECT status, completed_at IS NOT NULL AS completed FROM deliveries WHERE id = $1',
      [deliveryId],
    );
    expect(rows[0]).toEqual({ status: 'dead', completed: true });
  });

  it('leaves unexpired leases alone', async () => {
    await insertDeliveryGraph(getPool());
    await claim();
    expect(await sweep()).toBe(0);
    const { rows } = await getPool().query('SELECT status FROM deliveries');
    expect(rows).toEqual([{ status: 'in_flight' }]);
  });

  it('works through more expired rows than one batch', async () => {
    await manyInFlight(25);
    await expireLeases();
    expect(await sweep(getPool(), { batchSize: 10 })).toBe(25);
    const { rows } = await getPool().query(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              (SELECT count(*)::int FROM delivery_attempts) AS attempts
         FROM deliveries`,
    );
    expect(rows[0]).toEqual({ pending: 25, attempts: 25 });
  });

  it('concurrent sweepers recover each row exactly once', async () => {
    await manyInFlight(60);
    await expireLeases();
    const counts = await Promise.all(Array.from({ length: 4 }, () => sweep(getPool(), { batchSize: 7 })));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(60);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS attempts, count(DISTINCT delivery_id)::int AS deliveries
         FROM delivery_attempts`,
    );
    expect(rows[0]).toEqual({ attempts: 60, deliveries: 60 });
  });

  it('stale worker: after sweep + re-claim, the original worker cannot overwrite the result', async () => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    const [a] = await claim(1, 'worker-a'); // A claims, then hangs past its lease
    await expireLeases();
    await sweep();
    const [b] = await claim(1, 'worker-b'); // B takes over with a NEW token
    expect(b!.lease_token).not.toBe(a!.lease_token);

    // A wakes up and reports success: rejected by the fence.
    expect(await recordResult(getPool(), a!, success, { ...recordOpts, workerId: 'worker-a' })).toBe(
      'lease_lost',
    );
    // B's report is the one that counts.
    expect(await recordResult(getPool(), b!, success, { ...recordOpts, workerId: 'worker-b' })).toBe(
      'succeeded',
    );
    expect(await attemptsOf(deliveryId)).toEqual([
      expect.objectContaining({ lease_token: a!.lease_token, error_kind: 'lease_expired', worker_id: 'worker-a' }),
      expect.objectContaining({ lease_token: b!.lease_token, error_kind: null, worker_id: 'worker-b', attempt_number: 2 }),
    ]);
  });

  it('worker and sweeper racing on the same rows: exactly one outcome per claim', async () => {
    const claims = await manyInFlight(40);
    await expireLeases(); // both the worker's late result and the sweep are now possible

    const [swept, ...outcomes] = await Promise.all([
      sweep(getPool(), { batchSize: 5 }),
      ...claims.map((c) => recordResult(getPool(), c, success, recordOpts)),
    ]);
    const recorded = outcomes.filter((o) => o === 'succeeded').length;
    const lost = outcomes.filter((o) => o === 'lease_lost').length;

    expect(recorded + lost).toBe(40);
    expect(swept).toBe(lost); // every lost write is exactly a row the sweeper took
    const { rows } = await getPool().query(
      `SELECT delivery_id, count(*)::int AS n FROM delivery_attempts GROUP BY delivery_id
       HAVING count(*) <> 1`,
    );
    expect(rows).toEqual([]); // never zero, never two attempt rows for one claim
    const total = await getPool().query('SELECT count(*)::int AS n FROM delivery_attempts');
    expect(total.rows[0].n).toBe(40);
  });
});
