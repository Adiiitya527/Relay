import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMetrics, renderMetrics, type MetricsSnapshot } from '../../src/metrics/metrics.js';
import { buildTestApp, unreachablePool } from '../helpers/app.js';
import { insertApp, insertDelivery, insertEndpoint, insertMessage, useTestDb } from '../helpers/db.js';

const db = useTestDb();

const EMPTY: MetricsSnapshot = {
  deliveries: { pending: 0, in_flight: 0, dead: 0 },
  due: 0,
  oldestDueAgeSeconds: 0,
  endpointsByCircuit: { closed: 0, open: 0, half_open: 0 },
  endpointsDisabled: 0,
};

describe('renderMetrics', () => {
  it('produces Prometheus text format: HELP and TYPE per metric, one sample per line', () => {
    const text = renderMetrics({
      deliveries: { pending: 12, in_flight: 3, dead: 1 },
      due: 7,
      oldestDueAgeSeconds: 42.123456,
      endpointsByCircuit: { closed: 4, open: 1, half_open: 0 },
      endpointsDisabled: 2,
    });
    expect(text).toBe(
      [
        '# HELP relay_deliveries Deliveries by status (succeeded is not counted: unbounded history).',
        '# TYPE relay_deliveries gauge',
        'relay_deliveries{status="pending"} 12',
        'relay_deliveries{status="in_flight"} 3',
        'relay_deliveries{status="dead"} 1',
        '# HELP relay_deliveries_due Pending deliveries whose next attempt is due now.',
        '# TYPE relay_deliveries_due gauge',
        'relay_deliveries_due 7',
        '# HELP relay_oldest_due_delivery_age_seconds How long the oldest due delivery has been waiting (queue lag); 0 when none is due.',
        '# TYPE relay_oldest_due_delivery_age_seconds gauge',
        'relay_oldest_due_delivery_age_seconds 42.123',
        '# HELP relay_endpoints Endpoints by circuit breaker state.',
        '# TYPE relay_endpoints gauge',
        'relay_endpoints{circuit_state="closed"} 4',
        'relay_endpoints{circuit_state="open"} 1',
        'relay_endpoints{circuit_state="half_open"} 0',
        '# HELP relay_endpoints_disabled Endpoints disabled (paused) by their owner.',
        '# TYPE relay_endpoints_disabled gauge',
        'relay_endpoints_disabled 2',
        '', // the format requires a trailing newline
      ].join('\n'),
    );
  });

  it('every sample line matches the exposition grammar', () => {
    for (const line of renderMetrics(EMPTY).trimEnd().split('\n')) {
      expect(line).toMatch(/^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[a-z_]+="[a-z_]+"\})? -?\d+(\.\d+)?)$/);
    }
  });
});

describe('readMetrics', () => {
  it('is all zeros on an empty database', async () => {
    expect(await readMetrics(db())).toEqual(EMPTY);
  });

  it('counts by status and circuit state, and measures the oldest due delivery with the DB clock', async () => {
    const appId = await insertApp(db());
    const closed = await insertEndpoint(db(), appId);
    const open = await insertEndpoint(db(), appId);
    const halfOpen = await insertEndpoint(db(), appId);
    await insertEndpoint(db(), appId, { disabled: true });
    await db().query(
      `UPDATE endpoints SET circuit_state = 'open', circuit_open_until = now() + interval '1 minute' WHERE id = $1`,
      [open],
    );
    await db().query(
      `UPDATE endpoints SET circuit_state = 'half_open', circuit_open_until = now() + interval '1 minute' WHERE id = $1`,
      [halfOpen],
    );

    const delivery = async () =>
      insertDelivery(db(), { appId, messageId: await insertMessage(db(), appId), endpointId: closed });
    const dueOld = await delivery();
    const dueNew = await delivery();
    const future = await delivery();
    const inFlight = await delivery();
    const dead = await delivery();
    const succeeded = await delivery();
    await db().query(`UPDATE deliveries SET next_attempt_at = now() - interval '90 seconds' WHERE id = $1`, [dueOld]);
    await db().query(`UPDATE deliveries SET next_attempt_at = now() - interval '5 seconds' WHERE id = $1`, [dueNew]);
    await db().query(`UPDATE deliveries SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [future]);
    await db().query(
      `UPDATE deliveries SET status = 'in_flight', attempt_count = 1, lease_token = gen_random_uuid(),
              locked_by = 'w', locked_until = now() + interval '30 seconds' WHERE id = $1`,
      [inFlight],
    );
    await db().query(`UPDATE deliveries SET status = 'dead', attempt_count = 6, completed_at = now() WHERE id = $1`, [dead]);
    await db().query(`UPDATE deliveries SET status = 'succeeded', attempt_count = 1, completed_at = now() WHERE id = $1`, [
      succeeded,
    ]);

    const m = await readMetrics(db());
    expect(m.deliveries).toEqual({ pending: 3, in_flight: 1, dead: 1 }); // succeeded not counted
    expect(m.due).toBe(2); // the future one is pending but not due
    expect(m.oldestDueAgeSeconds).toBeGreaterThanOrEqual(90);
    expect(m.oldestDueAgeSeconds).toBeLessThan(120);
    expect(m.endpointsByCircuit).toEqual({ closed: 2, open: 1, half_open: 1 }); // the disabled one is closed
    expect(m.endpointsDisabled).toBe(1);
  });
});

describe('GET /metrics', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildTestApp(db());
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('needs no API key and answers in the Prometheus content type', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('relay_deliveries{status="pending"} 0');
  });

  it('exposes no tenant or endpoint identifiers', async () => {
    const appId = await insertApp(db());
    const endpointId = await insertEndpoint(db(), appId);
    await insertDelivery(db(), { appId, messageId: await insertMessage(db(), appId), endpointId });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('relay_deliveries{status="pending"} 1');
    expect(res.body).not.toContain(appId);
    expect(res.body).not.toContain(endpointId);
  });

  it('503 when the database is unreachable (a failed scrape, not fake zeros)', async () => {
    const pool = unreachablePool();
    const down = buildTestApp(pool);
    try {
      const res = await down.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('database_unavailable');
    } finally {
      await down.close();
      await pool.end();
    }
  });
});
