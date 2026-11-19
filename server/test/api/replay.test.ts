import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { claimDeliveries } from '../../src/worker/queue.js';
import { buildTestApp } from '../helpers/app.js';
import { insertDelivery, insertEndpoint, insertMessage, useTestDb } from '../helpers/db.js';

const db = useTestDb();
let app: FastifyInstance;
let keyA: string;
let appA: string;
let keyB: string;

beforeAll(async () => {
  app = buildTestApp(db());
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  const a = await createApplication(db(), 'tenant-a');
  const b = await createApplication(db(), 'tenant-b');
  [keyA, appA, keyB] = [a.apiKey, a.id, b.apiKey];
});

const post = (url: string, key = keyA) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}` } });

/** A delivery forced into `status` (as if the worker had got it there), with one attempt row. */
async function deliveryIn(status: 'pending' | 'in_flight' | 'succeeded' | 'dead', endpointId?: string) {
  const ep = endpointId ?? (await insertEndpoint(db(), appA));
  const messageId = await insertMessage(db(), appA);
  const id = await insertDelivery(db(), { appId: appA, messageId, endpointId: ep });
  if (status === 'in_flight') {
    await db().query(
      `UPDATE deliveries SET status = 'in_flight', attempt_count = 1, locked_until = now() + interval '1 min',
              lease_token = gen_random_uuid(), locked_by = 'w' WHERE id = $1`,
      [id],
    );
  } else if (status !== 'pending') {
    await db().query(
      `UPDATE deliveries SET status = $2, attempt_count = 3, completed_at = now(),
              last_error = CASE WHEN $2 = 'dead' THEN 'HTTP 500' END WHERE id = $1`,
      [id, status],
    );
    await db().query(
      `INSERT INTO delivery_attempts (delivery_id, lease_token, attempt_number, worker_id, response_status, error_kind)
       VALUES ($1, gen_random_uuid(), 3, 'w', 500, 'http_status')`,
      [id],
    );
  }
  return { id, endpointId: ep };
}

const row = async (id: string) =>
  (
    await db().query(
      `SELECT status, attempt_count, last_error, completed_at, next_attempt_at <= now() AS due
         FROM deliveries WHERE id = $1`,
      [id],
    )
  ).rows[0];

describe('POST /v1/deliveries/:id/replay', () => {
  it.each(['dead', 'succeeded'] as const)('202: a %s delivery is queued again, history kept', async (status) => {
    const { id } = await deliveryIn(status);
    const res = await post(`/v1/deliveries/${id}/replay`);

    expect(res.statusCode, res.body).toBe(202);
    const { delivery } = res.json();
    expect(delivery).toMatchObject({ id, status: 'pending', attempt_count: 0, last_error: null, completed_at: null });
    expect(delivery).not.toHaveProperty('lease_token');
    expect(await row(id)).toMatchObject({ status: 'pending', attempt_count: 0, due: true });
    const attempts = await db().query('SELECT count(*)::int AS n FROM delivery_attempts WHERE delivery_id = $1', [id]);
    expect(attempts.rows[0].n).toBe(1); // history preserved

    // The worker picks it up as a fresh first attempt.
    const [claimed] = await claimDeliveries(db(), { limit: 5, leaseMs: 30_000, workerId: 'w' });
    expect(claimed).toMatchObject({ id, attempt_count: 1 });
  });

  it.each(['pending', 'in_flight'] as const)('409 delivery_not_replayable for a %s delivery', async (status) => {
    const { id } = await deliveryIn(status);
    const before = await row(id);
    const res = await post(`/v1/deliveries/${id}/replay`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({
      code: 'delivery_not_replayable',
      message: `Delivery is ${status}; only dead or succeeded deliveries can be replayed`,
    });
    expect(await row(id)).toEqual(before);
  });

  it('404 for another tenant’s delivery (and it is not touched)', async () => {
    const { id } = await deliveryIn('dead');
    const res = await post(`/v1/deliveries/${id}/replay`, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect((await row(id)).status).toBe('dead');
  });

  it('404 for an unknown id, 400 for a malformed one', async () => {
    expect((await post('/v1/deliveries/00000000-0000-4000-8000-000000000000/replay')).statusCode).toBe(404);
    expect((await post('/v1/deliveries/not-a-uuid/replay')).statusCode).toBe(400);
  });

  it('two concurrent replays of the same delivery: exactly one wins', async () => {
    const { id } = await deliveryIn('dead');
    const codes = (await Promise.all([post(`/v1/deliveries/${id}/replay`), post(`/v1/deliveries/${id}/replay`)]))
      .map((r) => r.statusCode)
      .sort();
    expect(codes).toEqual([202, 409]);
  });

  it('a replay for a disabled endpoint stays paused until it is re-enabled', async () => {
    const { id, endpointId } = await deliveryIn('dead');
    await db().query('UPDATE endpoints SET disabled = true WHERE id = $1', [endpointId]);
    expect((await post(`/v1/deliveries/${id}/replay`)).statusCode).toBe(202);
    expect(await claimDeliveries(db(), { limit: 5, leaseMs: 30_000, workerId: 'w' })).toEqual([]);

    await db().query('UPDATE endpoints SET disabled = false WHERE id = $1', [endpointId]);
    expect(await claimDeliveries(db(), { limit: 5, leaseMs: 30_000, workerId: 'w' })).toHaveLength(1);
  });

  it('requires an API key', async () => {
    const { id } = await deliveryIn('dead');
    const res = await app.inject({ method: 'POST', url: `/v1/deliveries/${id}/replay` });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/endpoints/:id/replay-dead', () => {
  it('202: replays every dead delivery of the endpoint and nothing else', async () => {
    const endpointId = await insertEndpoint(db(), appA);
    const dead = [await deliveryIn('dead', endpointId), await deliveryIn('dead', endpointId), await deliveryIn('dead', endpointId)];
    const succeeded = await deliveryIn('succeeded', endpointId);
    const inFlight = await deliveryIn('in_flight', endpointId);
    const otherEndpointDead = await deliveryIn('dead');

    const res = await post(`/v1/endpoints/${endpointId}/replay-dead`);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ replayed: 3 });

    for (const d of dead) expect(await row(d.id)).toMatchObject({ status: 'pending', attempt_count: 0 });
    expect((await row(succeeded.id)).status).toBe('succeeded');
    expect((await row(inFlight.id)).status).toBe('in_flight');
    expect((await row(otherEndpointDead.id)).status).toBe('dead');
  });

  it('202 with replayed 0 when nothing is dead', async () => {
    const endpointId = await insertEndpoint(db(), appA);
    const res = await post(`/v1/endpoints/${endpointId}/replay-dead`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ replayed: 0 });
  });

  it('404 for another tenant’s endpoint, and none of its deliveries move', async () => {
    const { id, endpointId } = await deliveryIn('dead');
    const res = await post(`/v1/endpoints/${endpointId}/replay-dead`, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'not_found', message: 'Endpoint not found' });
    expect((await row(id)).status).toBe('dead');
  });

  it('404 for an unknown endpoint', async () => {
    const res = await post('/v1/endpoints/00000000-0000-4000-8000-000000000000/replay-dead');
    expect(res.statusCode).toBe(404);
  });
});
