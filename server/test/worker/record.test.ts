import { describe, expect, it } from 'vitest';
import type { ErrorKind, SendResult } from '../../src/delivery/http-client.js';
import { claimDeliveries, recordResult, type ClaimedDelivery } from '../../src/worker/queue.js';
import { insertDeliveryGraph, useTestDb } from '../helpers/db.js';

const getPool = useTestDb();
const opts = { maxAttempts: 3, backoffMs: 60_000, workerId: 'worker-a' };

const success: SendResult = { ok: true, status: 200, excerpt: 'thanks', durationMs: 42 };
const http503: SendResult = {
  ok: false,
  errorKind: 'http_status',
  errorMessage: 'HTTP 503',
  status: 503,
  excerpt: 'try later',
  durationMs: 17,
};

async function claimOne(): Promise<ClaimedDelivery> {
  const [claimed] = await claimDeliveries(getPool(), { limit: 1, leaseMs: 30_000, workerId: 'worker-a' });
  if (!claimed) throw new Error('nothing to claim');
  return claimed;
}

async function delivery(id: string) {
  const { rows } = await getPool().query(
    `SELECT status, attempt_count, last_error, locked_until, lease_token, locked_by,
            completed_at IS NOT NULL AS completed,
            (extract(epoch FROM next_attempt_at - now()) * 1000)::float8 AS due_in_ms
       FROM deliveries WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** The stored row exactly, for "nothing changed" assertions. */
async function rawRow(id: string) {
  const { rows } = await getPool().query('SELECT * FROM deliveries WHERE id = $1', [id]);
  return rows[0];
}

async function attempts(deliveryId: string) {
  const { rows } = await getPool().query(
    `SELECT lease_token, attempt_number, worker_id, duration_ms, response_status,
            response_excerpt, error_kind, error_message
       FROM delivery_attempts WHERE delivery_id = $1 ORDER BY id`,
    [deliveryId],
  );
  return rows;
}

describe('recordResult', () => {
  it('2xx → succeeded, lease cleared, one attempt row', async () => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    const claim = await claimOne();

    expect(await recordResult(getPool(), claim, success, opts)).toBe('succeeded');
    expect(await delivery(deliveryId)).toMatchObject({
      status: 'succeeded',
      attempt_count: 1,
      last_error: null,
      locked_until: null,
      lease_token: null,
      locked_by: null,
      completed: true,
    });
    expect(await attempts(deliveryId)).toEqual([
      {
        lease_token: claim.lease_token,
        attempt_number: 1,
        worker_id: 'worker-a',
        duration_ms: 42,
        response_status: 200,
        response_excerpt: 'thanks',
        error_kind: null,
        error_message: null,
      },
    ]);
  });

  it('failure with attempts left → pending again, due after the backoff (DB clock)', async () => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    const claim = await claimOne();

    expect(await recordResult(getPool(), claim, http503, opts)).toBe('retrying');
    const row = await delivery(deliveryId);
    expect(row).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'HTTP 503',
      lease_token: null,
      completed: false,
    });
    expect(row.due_in_ms).toBeGreaterThan(58_000);
    expect(row.due_in_ms).toBeLessThanOrEqual(60_000);
    expect(await attempts(deliveryId)).toEqual([
      expect.objectContaining({
        response_status: 503,
        response_excerpt: 'try later',
        error_kind: 'http_status',
        error_message: 'HTTP 503',
      }),
    ]);
  });

  it('non-HTTP failures keep their kind in last_error', async () => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    const claim = await claimOne();
    const timeout: SendResult = { ok: false, errorKind: 'timeout', errorMessage: 'no response within 10000 ms', durationMs: 10_000 };
    await recordResult(getPool(), claim, timeout, opts);
    expect((await delivery(deliveryId)).last_error).toBe('timeout: no response within 10000 ms');
  });

  it('exhaustion: the MAX_ATTEMPTS-th failure makes it dead, with one attempt row per try', async () => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    const outcomes = [];
    for (let i = 0; i < 3; i++) {
      // backoff 0 → due immediately, so the next claim picks it up
      outcomes.push(await recordResult(getPool(), await claimOne(), http503, { ...opts, backoffMs: 0 }));
    }
    expect(outcomes).toEqual(['retrying', 'retrying', 'dead']);
    expect(await delivery(deliveryId)).toMatchObject({ status: 'dead', attempt_count: 3, completed: true });
    expect((await attempts(deliveryId)).map((a) => a.attempt_number)).toEqual([1, 2, 3]);
    // Dead is terminal for the worker: nothing left to claim.
    expect(await claimDeliveries(getPool(), { limit: 5, leaseMs: 30_000, workerId: 'w' })).toEqual([]);
  });

  describe('fencing (invariant 4)', () => {
    it('a wrong lease token changes nothing and writes no attempt', async () => {
      const { deliveryId } = await insertDeliveryGraph(getPool());
      const claim = await claimOne();
      const before = await rawRow(deliveryId);

      const forged = { ...claim, lease_token: '00000000-0000-4000-8000-000000000000' };
      expect(await recordResult(getPool(), forged, success, opts)).toBe('lease_lost');
      expect(await rawRow(deliveryId)).toEqual(before);
      expect(await attempts(deliveryId)).toEqual([]);
    });

    it('recording twice with the same token: the second write is rejected', async () => {
      const { deliveryId } = await insertDeliveryGraph(getPool());
      const claim = await claimOne();
      await recordResult(getPool(), claim, success, opts);
      expect(await recordResult(getPool(), claim, http503, opts)).toBe('lease_lost');
      expect((await delivery(deliveryId)).status).toBe('succeeded');
      expect(await attempts(deliveryId)).toHaveLength(1);
    });

    it('an expired but not yet swept lease is still accepted (the fence is the token, not the clock)', async () => {
      const { deliveryId } = await insertDeliveryGraph(getPool());
      const claim = await claimOne();
      await getPool().query(
        `UPDATE deliveries SET locked_until = now() - interval '1 minute' WHERE id = $1`,
        [deliveryId],
      );
      expect(await recordResult(getPool(), claim, success, opts)).toBe('succeeded');
    });
  });

  it('is atomic: if the attempt row cannot be written, the state change is rolled back', async () => {
    const pool = getPool();
    const { deliveryId } = await insertDeliveryGraph(pool);
    const claim = await claimOne();
    const before = await rawRow(deliveryId);
    await pool.query(`
      CREATE FUNCTION relay_test_fail_attempt() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'simulated attempt insert failure'; END $$;
      CREATE TRIGGER relay_test_fail_attempt BEFORE INSERT ON delivery_attempts
        FOR EACH ROW EXECUTE FUNCTION relay_test_fail_attempt();
    `);
    try {
      await expect(recordResult(pool, claim, success, opts)).rejects.toThrow(/simulated/);
    } finally {
      await pool.query(`
        DROP TRIGGER relay_test_fail_attempt ON delivery_attempts;
        DROP FUNCTION relay_test_fail_attempt();
      `);
    }
    // Still in_flight with our lease: the sweeper will recover it if we never retry.
    expect(await rawRow(deliveryId)).toEqual(before);
    expect(await recordResult(pool, claim, success, opts)).toBe('succeeded');
  });

  it.each<[ErrorKind, number | undefined]>([
    ['timeout', undefined],
    ['dns', undefined],
    ['connection', undefined],
    ['tls', undefined],
    ['ssrf_blocked', undefined],
    ['http_status', 302],
  ])('stores a %s failure within the attempts CHECK constraints', async (errorKind, status) => {
    const { deliveryId } = await insertDeliveryGraph(getPool());
    const result: SendResult = {
      ok: false,
      errorKind,
      errorMessage: 'x'.repeat(1024),
      ...(status !== undefined && { status, excerpt: '😀'.repeat(1024) }),
      durationMs: 0,
    };
    expect(await recordResult(getPool(), await claimOne(), result, opts)).toBe('retrying');
    expect(await attempts(deliveryId)).toEqual([
      expect.objectContaining({ error_kind: errorKind, response_status: status ?? null }),
    ]);
  });
});
