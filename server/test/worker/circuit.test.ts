import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import type { SendResult } from '../../src/delivery/http-client.js';
import { claimDeliveries, recordResult, type ClaimedDelivery } from '../../src/worker/queue.js';
import { insertApp, insertEndpoint, useTestDb } from '../helpers/db.js';

const getPool = useTestDb();
const LEASE_MS = 30_000;
const COOLDOWN_MS = 60_000;
const recordOpts = {
  maxAttempts: 100, // never dead here: this file is about the circuit
  backoffMs: 0, // failed rows are due again at once, so only the circuit can hold them back
  workerId: 'worker-a',
  circuit: { failureThreshold: 3, cooldownMs: COOLDOWN_MS },
};
const ok: SendResult = { ok: true, status: 200, excerpt: '', durationMs: 1 };
const fail: SendResult = { ok: false, errorKind: 'http_status', errorMessage: 'HTTP 503', status: 503, durationMs: 1 };

const claim = (limit = 10, db: pg.Pool = getPool()) =>
  claimDeliveries(db, { limit, leaseMs: LEASE_MS, workerId: 'worker-a' });
const record = (c: ClaimedDelivery, result: SendResult) => recordResult(getPool(), c, result, recordOpts);

/** One endpoint with n pending deliveries (one message each). */
async function endpointWithDeliveries(n: number, appId?: string) {
  const pool = getPool();
  const app = appId ?? (await insertApp(pool));
  const endpointId = await insertEndpoint(pool, app);
  await pool.query(
    `WITH m AS (
       INSERT INTO messages (app_id, event_type, payload)
       SELECT $1, 'circuit.test', jsonb_build_object('i', i) FROM generate_series(1, $3::int) i
       RETURNING id
     )
     INSERT INTO deliveries (app_id, message_id, endpoint_id) SELECT $1, m.id, $2 FROM m`,
    [app, endpointId, n],
  );
  return { appId: app, endpointId };
}

async function circuit(endpointId: string) {
  const { rows } = await getPool().query(
    `SELECT circuit_state, consecutive_failures,
            (extract(epoch FROM circuit_open_until - now()) * 1000)::float8 AS open_for_ms
       FROM endpoints WHERE id = $1`,
    [endpointId],
  );
  return rows[0] as { circuit_state: string; consecutive_failures: number; open_for_ms: number | null };
}

/** Pretend the cooldown (or a probe deadline) has passed. */
const coolDown = (endpointId: string) =>
  getPool().query(`UPDATE endpoints SET circuit_open_until = now() - interval '1 ms' WHERE id = $1`, [
    endpointId,
  ]);

/** Fail `n` claimed deliveries in a row. */
async function failTimes(n: number) {
  for (const c of await claim(n)) await record(c, fail);
}

describe('circuit breaker: closed → open', () => {
  it('opens after CIRCUIT_FAILURE_THRESHOLD consecutive failures', async () => {
    const { endpointId } = await endpointWithDeliveries(3);
    await failTimes(2);
    expect(await circuit(endpointId)).toMatchObject({ circuit_state: 'closed', consecutive_failures: 2, open_for_ms: null });

    await failTimes(1);
    const state = await circuit(endpointId);
    expect(state).toMatchObject({ circuit_state: 'open', consecutive_failures: 3 });
    expect(state.open_for_ms).toBeGreaterThan(COOLDOWN_MS - 2_000);
    expect(state.open_for_ms).toBeLessThanOrEqual(COOLDOWN_MS);
  });

  it('a success resets the counter (failures must be consecutive)', async () => {
    const { endpointId } = await endpointWithDeliveries(5);
    await failTimes(2);
    const [c] = await claim(1);
    await record(c!, ok);
    expect(await circuit(endpointId)).toMatchObject({ circuit_state: 'closed', consecutive_failures: 0 });
    await failTimes(2);
    expect((await circuit(endpointId)).circuit_state).toBe('closed');
  });

  it('a success on a healthy endpoint writes nothing (no-op skipped)', async () => {
    const { endpointId } = await endpointWithDeliveries(1);
    const before = await getPool().query('SELECT updated_at FROM endpoints WHERE id = $1', [endpointId]);
    const [c] = await claim(1);
    await record(c!, ok);
    const after = await getPool().query('SELECT updated_at FROM endpoints WHERE id = $1', [endpointId]);
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
  });

  it('while open, deliveries wait without spending attempts (invariant 9)', async () => {
    const { endpointId } = await endpointWithDeliveries(6);
    await failTimes(3); // opens; 3 failed rows are pending again and due now
    expect((await circuit(endpointId)).circuit_state).toBe('open');

    expect(await claim(10)).toEqual([]);
    const { rows } = await getPool().query(
      `SELECT attempt_count, count(*)::int AS n FROM deliveries GROUP BY attempt_count ORDER BY 1`,
    );
    expect(rows).toEqual([
      { attempt_count: 0, n: 3 }, // never tried
      { attempt_count: 1, n: 3 }, // tried once before the circuit opened
    ]);
  });

  it('a lost lease does not move the circuit (the result was discarded)', async () => {
    const { endpointId } = await endpointWithDeliveries(1);
    const [c] = await claim(1);
    const forged = { ...c!, lease_token: '00000000-0000-4000-8000-000000000000' };
    expect(await record(forged, fail)).toBe('lease_lost');
    expect(await circuit(endpointId)).toMatchObject({ circuit_state: 'closed', consecutive_failures: 0 });
  });

  it('only the failing endpoint is held back', async () => {
    const sick = await endpointWithDeliveries(3);
    await failTimes(3);
    const healthy = await endpointWithDeliveries(2, sick.appId);
    const claimed = await claim(10);
    expect(claimed.map((c) => c.endpoint_id)).toEqual([healthy.endpointId, healthy.endpointId]);
  });
});

describe('circuit breaker: half-open single probe', () => {
  async function openCircuit(deliveries: number) {
    const ids = await endpointWithDeliveries(deliveries);
    await failTimes(3);
    expect((await circuit(ids.endpointId)).circuit_state).toBe('open');
    return ids;
  }

  it('after the cooldown exactly one probe is claimed; the endpoint goes half_open', async () => {
    const { endpointId } = await openCircuit(6);
    await coolDown(endpointId);

    const probe = await claim(10);
    expect(probe).toHaveLength(1);
    const state = await circuit(endpointId);
    expect(state.circuit_state).toBe('half_open');
    // circuit_open_until is now the probe deadline (= lease)
    expect(state.open_for_ms).toBeGreaterThan(LEASE_MS - 2_000);
    expect(state.open_for_ms).toBeLessThanOrEqual(LEASE_MS);

    expect(await claim(10)).toEqual([]); // the probe is out: everyone else keeps skipping
  });

  it('8 concurrent workers after the cooldown: still exactly one probe', async () => {
    const { endpointId } = await openCircuit(20);
    await coolDown(endpointId);
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(5)));
    expect(results.flat()).toHaveLength(1);
  });

  it('a probe being claimed right now is skipped by other workers, without waiting', async () => {
    // Holds the race window open: worker A's probe claim has not committed yet. Fast
    // concurrent claims (test above) rarely overlap this exactly, so this pins it.
    const { endpointId } = await openCircuit(6);
    await coolDown(endpointId);
    await withTransaction(getPool(), async (workerA) => {
      const probeA = await claimDeliveries(workerA, { limit: 10, leaseMs: LEASE_MS, workerId: 'a' });
      expect(probeA).toHaveLength(1);

      const started = performance.now();
      const claimB = await claim(10); // another connection = another worker
      expect(performance.now() - started).toBeLessThan(2_000); // skipped, not waited for
      expect(claimB).toEqual([]); // and no second probe
    });
    expect(await claim(10)).toEqual([]); // after A commits: half_open, probe out
  });

  it('probe success closes the circuit and the backlog flows again', async () => {
    const { endpointId } = await openCircuit(6);
    await coolDown(endpointId);
    const [probe] = await claim(10);
    await record(probe!, ok);

    expect(await circuit(endpointId)).toMatchObject({ circuit_state: 'closed', consecutive_failures: 0, open_for_ms: null });
    expect(await claim(10)).toHaveLength(5); // the 5 others (3 retried + 3 untried − probe)
  });

  it('probe failure re-opens the circuit with a fresh cooldown', async () => {
    const { endpointId } = await openCircuit(6);
    await coolDown(endpointId);
    const [probe] = await claim(10);
    await record(probe!, fail);

    const state = await circuit(endpointId);
    expect(state).toMatchObject({ circuit_state: 'open', consecutive_failures: 4 });
    expect(state.open_for_ms).toBeGreaterThan(COOLDOWN_MS - 2_000);
    expect(await claim(10)).toEqual([]);
  });

  it('a lost probe (crashed worker) does not wedge half_open: a new probe after the deadline', async () => {
    const { endpointId } = await openCircuit(6);
    await coolDown(endpointId);
    const [lostProbe] = await claim(10); // its worker dies; no result ever arrives
    expect(await claim(10)).toEqual([]);

    await coolDown(endpointId); // the probe deadline passes
    const [nextProbe] = await claim(10);
    expect(nextProbe).toBeDefined();
    expect(nextProbe!.id).not.toBe(lostProbe!.id);
    expect((await circuit(endpointId)).circuit_state).toBe('half_open');
  });

  it('does not probe a disabled endpoint, or one with nothing due', async () => {
    const a = await openCircuit(3); // all 3 failed: pending, due now
    await coolDown(a.endpointId);
    await getPool().query('UPDATE endpoints SET disabled = true WHERE id = $1', [a.endpointId]);
    expect(await claim(10)).toEqual([]);
    expect((await circuit(a.endpointId)).circuit_state).toBe('open');

    await getPool().query(
      `UPDATE endpoints SET disabled = false WHERE id = $1;`,
      [a.endpointId],
    );
    await getPool().query(`UPDATE deliveries SET next_attempt_at = now() + interval '1 hour'`);
    expect(await claim(10)).toEqual([]);
    expect((await circuit(a.endpointId)).circuit_state).toBe('open'); // not parked in half_open
  });

  it('probes and normal claims share the free slots', async () => {
    const sick = await openCircuit(3);
    await coolDown(sick.endpointId);
    await endpointWithDeliveries(5, sick.appId); // healthy, 5 due
    const claimed = await claim(3);
    expect(claimed).toHaveLength(3);
    expect(claimed.filter((c) => c.endpoint_id === sick.endpointId)).toHaveLength(1); // the probe
  });
});
