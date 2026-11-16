import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { buildTestApp } from '../helpers/app.js';
import { insertEndpoint, useTestDb } from '../helpers/db.js';

const db = useTestDb(); // pool max = 20 (plan A2): concurrent tests hold many connections
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
  keyA = a.apiKey;
  appA = a.id;
  keyB = b.apiKey;
});

function publish(
  body: unknown,
  opts: { key?: string; idempotencyKey?: string; on?: FastifyInstance; raw?: string } = {},
) {
  return (opts.on ?? app).inject({
    method: 'POST',
    url: '/v1/messages',
    headers: {
      authorization: `Bearer ${opts.key ?? keyA}`,
      'content-type': 'application/json',
      ...(opts.idempotencyKey !== undefined && { 'idempotency-key': opts.idempotencyKey }),
    },
    payload: opts.raw ?? JSON.stringify(body),
  });
}

const count = async (table: 'messages' | 'deliveries') =>
  (await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

const paid = { event_type: 'invoice.paid', payload: { invoice: 'in_1', amount: 1200 } };

describe('POST /v1/messages: fan-out', () => {
  it('202: one pending delivery per enabled, subscribed endpoint', async () => {
    const all = await insertEndpoint(db(), appA, { eventTypes: [] });
    const match = await insertEndpoint(db(), appA, { eventTypes: ['invoice.paid', 'x'] });
    await insertEndpoint(db(), appA, { eventTypes: ['user.created'] }); // not subscribed
    await insertEndpoint(db(), appA, { eventTypes: [], disabled: true }); // paused (Q1)

    const res = await publish(paid);
    expect(res.statusCode, res.body).toBe(202);
    const { message, deliveries } = res.json();
    expect(message).toMatchObject({ event_type: 'invoice.paid', idempotency_key: null });
    expect(message).not.toHaveProperty('payload');
    expect(deliveries.map((d: { endpoint_id: string }) => d.endpoint_id).sort()).toEqual([all, match].sort());
    expect(deliveries.every((d: { status: string }) => d.status === 'pending')).toBe(true);

    const { rows } = await db().query(
      `SELECT app_id, attempt_count, next_attempt_at <= now() AS due FROM deliveries WHERE message_id = $1`,
      [message.id],
    );
    expect(rows).toEqual([
      { app_id: appA, attempt_count: 0, due: true },
      { app_id: appA, attempt_count: 0, due: true },
    ]);
  });

  it('only fans out to the publishing tenant\'s endpoints', async () => {
    const b = (await db().query('SELECT id FROM applications WHERE name = $1', ['tenant-b'])).rows[0].id;
    await insertEndpoint(db(), b, { eventTypes: [] });
    const res = await publish(paid);
    expect(res.statusCode).toBe(202);
    expect(res.json().deliveries).toEqual([]);
  });

  it('202 with no deliveries when the app has no endpoints (message still stored)', async () => {
    const res = await publish(paid);
    expect(res.statusCode).toBe(202);
    expect(res.json().deliveries).toEqual([]);
    expect(await count('messages')).toBe(1);
  });

  it('stores the payload exactly (nested values, arrays, unicode)', async () => {
    const payload = { a: [1, 'two', { three: 3 }], nested: { ok: true, none: null }, text: 'héllo ✓ 😀' };
    const res = await publish({ event_type: 'x', payload });
    const { rows } = await db().query('SELECT payload FROM messages WHERE id = $1', [res.json().message.id]);
    expect(rows[0].payload).toEqual(payload);
  });

  it('without Idempotency-Key, the same body twice creates two messages', async () => {
    expect((await publish(paid)).statusCode).toBe(202);
    expect((await publish(paid)).statusCode).toBe(202);
    expect(await count('messages')).toBe(2);
  });
});

describe('POST /v1/messages: idempotency', () => {
  it('same key + same body → 200 Idempotent-Replayed with the ORIGINAL message and deliveries', async () => {
    await insertEndpoint(db(), appA);
    const first = await publish(paid, { idempotencyKey: 'order-1' });
    expect(first.statusCode).toBe(202);

    // Same content, different key order and whitespace: jsonb equality treats it as equal.
    const again = await publish(undefined, {
      idempotencyKey: 'order-1',
      raw: '{ "payload": {"amount":1200, "invoice":"in_1"}, "event_type":"invoice.paid" }',
    });
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await count('messages')).toBe(1);
    expect(await count('deliveries')).toBe(1);
  });

  it('a replay reports the deliveries\' CURRENT status', async () => {
    await insertEndpoint(db(), appA);
    const first = await publish(paid, { idempotencyKey: 'k' });
    await db().query(
      `UPDATE deliveries SET status = 'succeeded', completed_at = now() WHERE message_id = $1`,
      [first.json().message.id],
    );
    const again = await publish(paid, { idempotencyKey: 'k' });
    expect(again.json().deliveries[0].status).toBe('succeeded');
  });

  it('a replay does not fan out to endpoints created after the original publish', async () => {
    const first = await publish(paid, { idempotencyKey: 'k' });
    await insertEndpoint(db(), appA);
    const again = await publish(paid, { idempotencyKey: 'k' });
    expect(again.statusCode).toBe(200);
    expect(again.json().deliveries).toEqual(first.json().deliveries); // still []
    expect(await count('deliveries')).toBe(0);
  });

  it.each([
    ['different payload', { ...paid, payload: { invoice: 'in_2', amount: 1200 } }],
    ['different event_type', { ...paid, event_type: 'invoice.failed' }],
  ])('same key + %s → 409 idempotency_key_reused; nothing new stored', async (_label, body) => {
    await publish(paid, { idempotencyKey: 'k' });
    const res = await publish(body, { idempotencyKey: 'k' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('idempotency_key_reused');
    expect(await count('messages')).toBe(1);
  });

  it('keys are scoped per application', async () => {
    const a = await publish(paid, { idempotencyKey: 'shared' });
    const b = await publish(paid, { idempotencyKey: 'shared', key: keyB });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json().message.id).not.toBe(b.json().message.id);
  });

  it('10 concurrent identical requests → exactly one 202, nine 200 replays, one message', async () => {
    await insertEndpoint(db(), appA);
    await insertEndpoint(db(), appA);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => publish(paid, { idempotencyKey: 'race' })),
    );

    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 202]);
    const ids = new Set(results.map((r) => r.json().message.id));
    expect(ids.size).toBe(1);
    expect(await count('messages')).toBe(1);
    expect(await count('deliveries')).toBe(2); // fanned out once, not ten times
  });

  it('10 concurrent requests, same key, different bodies → one 202, nine 409', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        publish({ event_type: 'x', payload: { n: i } }, { idempotencyKey: 'race' }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(await count('messages')).toBe(1);
  });

  it.each([
    ['too long', 'k'.repeat(256)],
    ['non-ASCII', 'clé'],
  ])('invalid Idempotency-Key (%s) → 400', async (_label, key) => {
    const res = await publish(paid, { idempotencyKey: key });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/^headers\.idempotency-key:/);
    expect(await count('messages')).toBe(0);
  });

  it('a 255-character key is accepted', async () => {
    expect((await publish(paid, { idempotencyKey: 'k'.repeat(255) })).statusCode).toBe(202);
  });
});

describe('POST /v1/messages: atomicity (invariant 2)', () => {
  it('if creating deliveries fails, the message is rolled back too', async () => {
    await insertEndpoint(db(), appA);
    // Make every delivery INSERT fail, in the test database only, for this test only.
    await db().query(`
      CREATE FUNCTION relay_test_fail_delivery() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'simulated fan-out failure'; END $$;
      CREATE TRIGGER relay_test_fail_delivery BEFORE INSERT ON deliveries
        FOR EACH ROW EXECUTE FUNCTION relay_test_fail_delivery();
    `);
    try {
      const res = await publish(paid, { idempotencyKey: 'k' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('internal_error');
      expect(await count('messages')).toBe(0); // no orphan message without deliveries
    } finally {
      await db().query(`
        DROP TRIGGER relay_test_fail_delivery ON deliveries;
        DROP FUNCTION relay_test_fail_delivery();
      `);
    }
    // The key was not consumed by the failed attempt: a retry succeeds.
    expect((await publish(paid, { idempotencyKey: 'k' })).statusCode).toBe(202);
  });
});

describe('POST /v1/messages: validation', () => {
  it.each([
    ['array payload', { event_type: 'x', payload: [1, 2] }],
    ['string payload', { event_type: 'x', payload: 'hello' }],
    ['number payload', { event_type: 'x', payload: 1 }],
    ['null payload', { event_type: 'x', payload: null }],
    ['missing payload', { event_type: 'x' }],
    ['missing event_type', { payload: {} }],
    ['bad event_type', { event_type: 'has space', payload: {} }],
    ['unknown field', { event_type: 'x', payload: {}, delay: 5 }],
    ['body is an array', [{ event_type: 'x', payload: {} }]],
  ])('400 validation_failed: %s', async (_label, body) => {
    const res = await publish(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(await count('messages')).toBe(0);
  });

  it.each([
    ['\\u0000 (jsonb cannot store NUL)', '{"event_type":"x","payload":{"s":"a\\u0000b"}}'],
    ['an unpaired surrogate', '{"event_type":"x","payload":{"s":"\\ud800"}}'],
  ])('valid JSON that jsonb rejects, %s → 400 (not 500)', async (_label, raw) => {
    const res = await publish(undefined, { raw });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(res.json().error.message).toMatch(/^body\.payload:/);
  });

  it('body over MAX_PAYLOAD_BYTES → 413, nothing stored', async () => {
    const small = buildTestApp(db(), { MAX_PAYLOAD_BYTES: '1024' });
    try {
      const res = await publish({ event_type: 'x', payload: { blob: 'x'.repeat(2000) } }, { on: small });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('payload_too_large');
      expect(await count('messages')).toBe(0);
    } finally {
      await small.close();
    }
  });

  it('401 without an API key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: paid });
    expect(res.statusCode).toBe(401);
    expect(await count('messages')).toBe(0);
  });
});
