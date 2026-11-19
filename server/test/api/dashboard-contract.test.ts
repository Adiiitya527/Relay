import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../../../dashboard/src/lib/api.js';
import { createApplication } from '../../src/applications/repo.js';
import { buildTestApp } from '../helpers/app.js';
import { insertDelivery, insertEndpoint, insertMessage, useTestDb } from '../helpers/db.js';

// Contract test: the dashboard's real API client (dashboard/src/lib/api.ts) against the real
// API over HTTP. If an API change breaks a call or a response shape the dashboard relies on,
// this fails here rather than in the browser. (The Vite dev proxy in front of it is covered
// by dashboard/test/dev-proxy.test.ts.)

const db = useTestDb();
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildTestApp(db());
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
});

let apiKey: string;
let appId: string;
let client: ApiClient;
let logouts: number;
beforeEach(async () => {
  ({ apiKey, id: appId } = await createApplication(db(), 'dashboard'));
  logouts = 0;
  client = createApiClient({ fetch, getKey: () => apiKey, onUnauthorized: () => logouts++, baseUrl });
});

async function deadDelivery() {
  const endpointId = await insertEndpoint(db(), appId);
  const messageId = await insertMessage(db(), appId, { eventType: 'order.created' });
  const id = await insertDelivery(db(), { appId, messageId, endpointId });
  await db().query(
    `UPDATE deliveries SET status = 'dead', attempt_count = 6, completed_at = now(), last_error = 'HTTP 503' WHERE id = $1`,
    [id],
  );
  await db().query(
    `INSERT INTO delivery_attempts (delivery_id, lease_token, attempt_number, worker_id, duration_ms,
                                    response_status, response_excerpt, error_kind, error_message)
     VALUES ($1, gen_random_uuid(), 6, 'w1', 12, 503, '<b>busy</b>', 'http_status', 'HTTP 503')`,
    [id],
  );
  return { id, endpointId, messageId };
}

describe('dashboard API client ↔ API', () => {
  it('login check: valid key passes, a bad key is a 401 without logging out', async () => {
    await expect(client.checkKey(apiKey)).resolves.toBeUndefined();
    await expect(client.checkKey('not-a-key')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(logouts).toBe(0);
  });

  it('a 401 during use triggers logout', async () => {
    const revoked = createApiClient({ fetch, getKey: () => 'revoked', onUnauthorized: () => logouts++, baseUrl });
    await expect(revoked.listEndpoints()).rejects.toMatchObject({ status: 401 });
    expect(logouts).toBe(1);
  });

  it('dead-letter view, timeline and message detail have the fields the views render', async () => {
    const { id, messageId } = await deadDelivery();
    const dlq = await client.listDeliveries({ status: 'dead' });
    expect(dlq).toMatchObject({ next_cursor: null, data: [{ id, status: 'dead', event_type: 'order.created', last_error: 'HTTP 503' }] });

    const attempts = await client.listAttempts(id);
    expect(attempts.data[0]).toMatchObject({
      attempt_number: 6,
      error_kind: 'http_status',
      response_status: 503,
      response_excerpt: '<b>busy</b>',
      duration_ms: 12,
      worker_id: 'w1',
    });

    const message = await client.getMessage(messageId);
    expect(message.payload).toEqual({ ok: true });
    expect(message.deliveries).toEqual([expect.objectContaining({ id, status: 'dead' })]);
    expect((await client.getDelivery(id)).message_id).toBe(messageId);
  });

  it('replay buttons: single and bulk POSTs without a body work; a second replay is a 409', async () => {
    const { id, endpointId } = await deadDelivery();
    expect((await client.replayDelivery(id)).delivery.status).toBe('pending');
    await expect(client.replayDelivery(id)).rejects.toMatchObject({ status: 409, code: 'delivery_not_replayable' });

    await db().query(`UPDATE deliveries SET status = 'dead', completed_at = now() WHERE id = $1`, [id]);
    expect(await client.replayDead(endpointId)).toEqual({ replayed: 1 });
  });

  it('endpoints view: create shows the secret once, list hides it, reveal and disable work', async () => {
    const created = await client.createEndpoint({ url: 'https://example.org/hook', description: 'x', event_types: ['a.b'] });
    expect(created.secret).toMatch(/^whsec_/);
    const listed = await client.listEndpoints();
    expect(listed.data[0]).toMatchObject({ id: created.id, circuit_state: 'closed', consecutive_failures: 0, event_types: ['a.b'] });
    expect(JSON.stringify(listed)).not.toContain('whsec_');
    expect((await client.getEndpointSecret(created.id)).secret).toBe(created.secret);
    expect((await client.updateEndpoint(created.id, { disabled: true })).disabled).toBe(true);
  });

  it('validation errors arrive as readable ApiErrors', async () => {
    await expect(client.createEndpoint({ url: 'http://10.0.0.1/x' })).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
      message: expect.stringContaining('body.url'),
    });
  });

  it('test-event form and messages list with paging', async () => {
    await insertEndpoint(db(), appId);
    const published = await client.publish('demo.test', { hello: 'world' });
    expect(published.deliveries).toHaveLength(1);
    const page = await client.listMessages();
    expect(page.data[0]).toMatchObject({ id: published.message.id, event_type: 'demo.test' });
    expect(page.next_cursor).toBeNull();
  });
});
