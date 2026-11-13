import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { buildTestApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
let app: FastifyInstance;
let keyA: string;
let keyB: string;
let appIdA: string;

beforeAll(async () => {
  app = buildTestApp(db());
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  // Tables are truncated before each test, so make two fresh tenants every time.
  const a = await createApplication(db(), 'tenant-a');
  const b = await createApplication(db(), 'tenant-b');
  keyA = a.apiKey;
  keyB = b.apiKey;
  appIdA = a.id;
});

function call(key: string, method: InjectOptions['method'], url: string, payload?: unknown, on = app) {
  return on.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(payload !== undefined && { payload: payload as object }),
  });
}

async function create(body: object = { url: 'https://example.com/hook' }, key = keyA) {
  const res = await call(key, 'POST', '/v1/endpoints', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('POST /v1/endpoints', () => {
  it('201 with defaults and the secret; row stored under the caller\'s app', async () => {
    const ep = await create();
    expect(ep).toMatchObject({
      url: 'https://example.com/hook',
      description: '',
      event_types: [],
      disabled: false,
      circuit_state: 'closed',
      circuit_open_until: null,
      consecutive_failures: 0,
    });
    expect(ep.secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);

    const { rows } = await db().query('SELECT app_id, secret FROM endpoints WHERE id = $1', [ep.id]);
    expect(rows).toEqual([{ app_id: appIdA, secret: ep.secret }]);
  });

  it('stores description and de-duplicated event_types; normalises the URL', async () => {
    const ep = await create({
      url: 'HTTPS://Example.com:443/h',
      description: 'billing',
      event_types: ['invoice.paid', 'invoice.failed', 'invoice.paid'],
    });
    expect(ep).toMatchObject({
      url: 'https://example.com/h',
      description: 'billing',
      event_types: ['invoice.paid', 'invoice.failed'],
    });
  });

  it('each endpoint gets its own secret', async () => {
    expect((await create()).secret).not.toBe((await create()).secret);
  });

  it.each([
    ['http (not allowed by default)', { url: 'http://example.com/h' }, 'body.url: scheme must be https'],
    ['credentials in URL', { url: 'https://u:p@example.com/' }, 'body.url: must not contain credentials'],
    ['relative URL', { url: '/hook' }, 'body.url: must be an absolute URL'],
    ['URL too long', { url: 'https://example.com/' + 'a'.repeat(2100) }, 'body.url:'],
    ['missing url', {}, 'body.url:'],
    ['bad event type', { url: 'https://e.com', event_types: ['has space'] }, 'body.event_types.0:'],
    ['too many event types', { url: 'https://e.com', event_types: Array.from({ length: 101 }, (_, i) => `t${i}`) }, 'body.event_types:'],
    ['description too long', { url: 'https://e.com', description: 'x'.repeat(501) }, 'body.description:'],
    ['server-owned field', { url: 'https://e.com', secret: 'whsec_mine' }, 'secret'],
    ['typo in field name', { url: 'https://e.com', event_type: ['a'] }, 'event_type'],
  ])('400 validation_failed: %s', async (_label, body, messagePart) => {
    const res = await call(keyA, 'POST', '/v1/endpoints', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.message).toContain(messagePart);
    const { rows } = await db().query('SELECT count(*)::int AS n FROM endpoints');
    expect(rows[0].n).toBe(0);
  });

  it('http is accepted when ALLOW_HTTP_ENDPOINTS=true', async () => {
    const httpApp = buildTestApp(db(), { ALLOW_HTTP_ENDPOINTS: 'true' });
    try {
      const res = await call(keyA, 'POST', '/v1/endpoints', { url: 'http://localhost:4000/hook' }, httpApp);
      expect(res.statusCode).toBe(201);
      expect(res.json().url).toBe('http://localhost:4000/hook');
    } finally {
      await httpApp.close();
    }
  });

  it('401 without an API key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/endpoints', payload: { url: 'https://e.com' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/endpoints and /v1/endpoints/:id', () => {
  it('lists only the caller\'s endpoints, oldest first, without secrets', async () => {
    const first = await create({ url: 'https://one.example' });
    const second = await create({ url: 'https://two.example' });
    await create({ url: 'https://other-tenant.example' }, keyB);

    const res = await call(keyA, 'GET', '/v1/endpoints');
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<Record<string, unknown>>;
    expect(data.map((e) => e.id)).toEqual([first.id, second.id]);
    for (const e of data) expect(e).not.toHaveProperty('secret');
    expect(res.body).not.toContain(first.secret);
  });

  it('empty list → { data: [] }', async () => {
    expect((await call(keyA, 'GET', '/v1/endpoints')).json()).toEqual({ data: [] });
  });

  it('get returns the endpoint without its secret', async () => {
    const ep = await create();
    const res = await call(keyA, 'GET', `/v1/endpoints/${ep.id}`);
    expect(res.statusCode).toBe(200);
    const { secret: _secret, ...withoutSecret } = ep;
    expect(res.json()).toEqual(withoutSecret);
    expect(res.body).not.toContain(ep.secret);
  });

  it('unknown id → 404 not_found; malformed id → 400 validation_failed', async () => {
    const missing = await call(keyA, 'GET', `/v1/endpoints/${MISSING_ID}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    const bad = await call(keyA, 'GET', '/v1/endpoints/not-a-uuid');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/^params\.id:/);
  });
});

describe('PATCH /v1/endpoints/:id', () => {
  it('updates only the provided fields and bumps updated_at', async () => {
    const ep = await create({ url: 'https://old.example/h', description: 'keep me', event_types: ['a'] });
    const res = await call(keyA, 'PATCH', `/v1/endpoints/${ep.id}`, { url: 'https://new.example/h' });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated).toMatchObject({ url: 'https://new.example/h', description: 'keep me', event_types: ['a'] });
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(ep.updated_at).getTime());
    expect(updated).not.toHaveProperty('secret');
  });

  it('can set event_types to [] (subscribe to all) and toggle disabled', async () => {
    const ep = await create({ url: 'https://e.example', event_types: ['a', 'b'] });
    const res = await call(keyA, 'PATCH', `/v1/endpoints/${ep.id}`, { event_types: [], disabled: true });
    expect(res.json()).toMatchObject({ event_types: [], disabled: true });

    const back = await call(keyA, 'PATCH', `/v1/endpoints/${ep.id}`, { disabled: false });
    expect(back.json()).toMatchObject({ event_types: [], disabled: false });
  });

  it.each([
    ['empty body', {}],
    ['invalid url', { url: 'http://insecure.example' }],
    ['null instead of omitting', { description: null }],
    ['server-owned field', { circuit_state: 'closed' }],
    ['secret', { secret: 'whsec_x' }],
  ])('400 validation_failed: %s (row unchanged)', async (_label, body) => {
    const ep = await create();
    const res = await call(keyA, 'PATCH', `/v1/endpoints/${ep.id}`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    const { rows } = await db().query('SELECT updated_at FROM endpoints WHERE id = $1', [ep.id]);
    expect(rows[0].updated_at.toISOString()).toBe(ep.updated_at);
  });

  it('unknown id → 404', async () => {
    const res = await call(keyA, 'PATCH', `/v1/endpoints/${MISSING_ID}`, { disabled: true });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/endpoints/:id/secret', () => {
  it('returns the same secret as create, marked no-store', async () => {
    const ep = await create();
    const res = await call(keyA, 'GET', `/v1/endpoints/${ep.id}/secret`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ secret: ep.secret });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('tenant isolation', () => {
  it('tenant B gets 404 for get, patch and secret on A\'s endpoint, and changes nothing', async () => {
    const ep = await create(); // owned by A

    for (const [method, url, body] of [
      ['GET', `/v1/endpoints/${ep.id}`, undefined],
      ['PATCH', `/v1/endpoints/${ep.id}`, { disabled: true, url: 'https://attacker.example' }],
      ['GET', `/v1/endpoints/${ep.id}/secret`, undefined],
    ] as const) {
      const res = await call(keyB, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      // Same body as a truly missing id: B can't even learn that the id exists.
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Endpoint not found' } });
      expect(res.body).not.toContain(ep.secret);
    }

    const { rows } = await db().query('SELECT url, disabled FROM endpoints WHERE id = $1', [ep.id]);
    expect(rows).toEqual([{ url: 'https://example.com/hook', disabled: false }]);
    expect((await call(keyB, 'GET', '/v1/endpoints')).json()).toEqual({ data: [] });
  });
});
