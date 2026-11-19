import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
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

const get = (url: string, key = keyA) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });

/**
 * n deliveries to one endpoint in ONE statement, so they all share the same created_at
 * (now() is the transaction start): the case where only the id tie-break keeps pages exact.
 */
async function bulkDeliveries(endpointId: string, n: number, status = 'pending') {
  await db().query(
    `WITH m AS (
       INSERT INTO messages (app_id, event_type, payload)
       SELECT $1, 'bulk.created', '{}'::jsonb FROM generate_series(1, $3::int) RETURNING id
     )
     INSERT INTO deliveries (app_id, message_id, endpoint_id, status, completed_at)
     SELECT $1, m.id, $2, $4, CASE WHEN $4 IN ('succeeded', 'dead') THEN now() END FROM m`,
    [appA, endpointId, n, status],
  );
}

async function pageThrough(query: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const sep: string = query ? '&' : '';
    const res = await get(`/v1/deliveries?${query}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeLessThanOrEqual(limit);
    ids.push(...body.data.map((d: { id: string }) => d.id));
    cursor = body.next_cursor;
  } while (cursor);
  return ids;
}

describe('GET /v1/deliveries', () => {
  it('lists newest first with event_type and without lease internals', async () => {
    const endpointId = await insertEndpoint(db(), appA);
    const older = await insertDelivery(db(), {
      appId: appA,
      messageId: await insertMessage(db(), appA, { eventType: 'invoice.paid' }),
      endpointId,
    });
    const newer = await insertDelivery(db(), {
      appId: appA,
      messageId: await insertMessage(db(), appA, { eventType: 'user.created' }),
      endpointId,
    });

    const res = await get('/v1/deliveries');
    expect(res.statusCode).toBe(200);
    const { data, next_cursor } = res.json();
    expect(data.map((d: { id: string }) => d.id)).toEqual([newer, older]);
    expect(data[0]).toMatchObject({ id: newer, endpoint_id: endpointId, event_type: 'user.created', status: 'pending', attempt_count: 0 });
    for (const field of ['lease_token', 'locked_until', 'locked_by', 'app_id']) {
      expect(data[0]).not.toHaveProperty(field);
    }
    expect(next_cursor).toBeNull();
  });

  it('pages through rows with identical created_at without skipping or repeating', async () => {
    const endpointId = await insertEndpoint(db(), appA);
    await bulkDeliveries(endpointId, 25);
    const ids = await pageThrough('', 10);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
  });

  it('filters by status (the dead-letter view) and by endpoint, combined with paging', async () => {
    const e1 = await insertEndpoint(db(), appA);
    const e2 = await insertEndpoint(db(), appA);
    await bulkDeliveries(e1, 7, 'dead');
    await bulkDeliveries(e1, 3, 'succeeded');
    await bulkDeliveries(e2, 4, 'dead');

    expect(await pageThrough('status=dead', 3)).toHaveLength(11);
    expect(await pageThrough(`endpoint_id=${e1}`, 4)).toHaveLength(10);
    const deadE1 = await pageThrough(`status=dead&endpoint_id=${e1}`, 2);
    expect(deadE1).toHaveLength(7);

    const res = await get(`/v1/deliveries?status=dead&endpoint_id=${e1}&limit=100`);
    for (const d of res.json().data) expect(d).toMatchObject({ status: 'dead', endpoint_id: e1 });
  });

  it('is tenant-scoped: another tenant sees nothing, even filtering by our endpoint id', async () => {
    const endpointId = await insertEndpoint(db(), appA);
    await bulkDeliveries(endpointId, 3);
    expect((await get('/v1/deliveries', keyB)).json()).toEqual({ data: [], next_cursor: null });
    expect((await get(`/v1/deliveries?endpoint_id=${endpointId}`, keyB)).json().data).toEqual([]);
  });

  it.each([
    ['unknown status', 'status=failed', 'query.status'],
    ['bad endpoint id', 'endpoint_id=nope', 'query.endpoint_id'],
    ['bad cursor', 'cursor=abc', 'query.cursor'],
    ['limit too big', 'limit=101', 'query.limit'],
    ['unknown parameter', 'state=dead', 'query'],
  ])('400 for %s', async (_name, qs, field) => {
    const res = await get(`/v1/deliveries?${qs}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.message).toContain(field);
  });

  it('requires an API key', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/deliveries' })).statusCode).toBe(401);
  });
});

describe('GET /v1/deliveries/:id and /attempts', () => {
  async function deliveryWithAttempts() {
    const endpointId = await insertEndpoint(db(), appA);
    const messageId = await insertMessage(db(), appA, { eventType: 'order.created' });
    const id = await insertDelivery(db(), { appId: appA, messageId, endpointId });
    await db().query(
      `INSERT INTO delivery_attempts (delivery_id, lease_token, attempt_number, worker_id, duration_ms,
                                      response_status, response_excerpt, error_kind, error_message)
       VALUES ($1, gen_random_uuid(), 1, 'w1', 12, 503, 'busy', 'http_status', 'HTTP 503'),
              ($1, gen_random_uuid(), 2, 'w2', NULL, NULL, NULL, 'lease_expired', 'worker lease expired'),
              ($1, gen_random_uuid(), 3, 'w1', 30, 200, 'ok', NULL, NULL)`,
      [id],
    );
    return { id, messageId, endpointId };
  }

  it('returns one delivery with its event_type', async () => {
    const { id, messageId } = await deliveryWithAttempts();
    const res = await get(`/v1/deliveries/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, message_id: messageId, event_type: 'order.created', status: 'pending' });
    expect(res.json()).not.toHaveProperty('lease_token');
  });

  it('returns the attempt timeline oldest first, without lease tokens', async () => {
    const { id } = await deliveryWithAttempts();
    const res = await get(`/v1/deliveries/${id}/attempts`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.map((a: { attempt_number: number; error_kind: string | null }) => [a.attempt_number, a.error_kind])).toEqual([
      [1, 'http_status'],
      [2, 'lease_expired'],
      [3, null],
    ]);
    expect(data[0]).toMatchObject({
      id: expect.stringMatching(/^\d+$/),
      worker_id: 'w1',
      duration_ms: 12,
      response_status: 503,
      response_excerpt: 'busy',
      error_message: 'HTTP 503',
    });
    expect(data[0]).not.toHaveProperty('lease_token');
  });

  it('a delivery without attempts has an empty timeline, not a 404', async () => {
    const endpointId = await insertEndpoint(db(), appA);
    const id = await insertDelivery(db(), { appId: appA, messageId: await insertMessage(db(), appA), endpointId });
    expect((await get(`/v1/deliveries/${id}/attempts`)).json()).toEqual({ data: [] });
  });

  it.each(['', '/attempts'])('404 for another tenant (GET /v1/deliveries/:id%s)', async (suffix) => {
    const { id } = await deliveryWithAttempts();
    const res = await get(`/v1/deliveries/${id}${suffix}`, keyB);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'not_found', message: 'Delivery not found' });
  });

  it('400 for a malformed id', async () => {
    expect((await get('/v1/deliveries/123')).statusCode).toBe(400);
    expect((await get('/v1/deliveries/123/attempts')).statusCode).toBe(400);
  });
});
