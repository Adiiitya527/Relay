import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  insertApp,
  insertDelivery,
  insertDeliveryGraph,
  insertEndpoint,
  insertMessage,
  useTestDb,
} from '../helpers/db.js';

// SQLSTATE codes: 23514 check_violation, 23503 foreign_key_violation, 23505 unique_violation.
const CHECK = '23514';
const FK = '23503';
const UNIQUE = '23505';

const db = useTestDb();

/** Assert a promise rejects with a given SQLSTATE and, optionally, a named constraint. */
async function expectPgError(p: Promise<unknown>, code: string, constraint?: string) {
  await expect(p).rejects.toMatchObject(constraint ? { code, constraint } : { code });
}

describe('migration 001', () => {
  it('is recorded and creates all tables', async () => {
    const { rows: m } = await db().query('SELECT version FROM schema_migrations');
    expect(m.map((r) => r.version)).toContain('001_init.sql');

    const { rows } = await db().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'applications',
      'deliveries',
      'delivery_attempts',
      'endpoints',
      'messages',
    ]);
  });

  it('creates the partial indexes with the expected predicates', async () => {
    const { rows } = await db().query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('deliveries', 'messages')`,
    );
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? '';
    expect(def('deliveries_claim_idx')).toMatch(/\(next_attempt_at\) WHERE \(status = 'pending'::text\)/);
    expect(def('deliveries_lease_idx')).toMatch(/\(locked_until\) WHERE \(status = 'in_flight'::text\)/);
    expect(def('deliveries_dead_idx')).toMatch(/WHERE \(status = 'dead'::text\)/);
    expect(def('messages_idempotency_uq')).toMatch(/UNIQUE INDEX .* WHERE \(idempotency_key IS NOT NULL\)/);
  });
});

describe('applications', () => {
  it('requires a 32-byte api_key_hash', async () => {
    await expectPgError(
      db().query('INSERT INTO applications (name, api_key_hash) VALUES ($1, $2)', ['a', randomBytes(16)]),
      CHECK,
      'applications_api_key_hash_check',
    );
  });

  it('rejects a duplicate api_key_hash', async () => {
    const hash = randomBytes(32);
    await db().query('INSERT INTO applications (name, api_key_hash) VALUES ($1, $2)', ['a', hash]);
    await expectPgError(
      db().query('INSERT INTO applications (name, api_key_hash) VALUES ($1, $2)', ['b', hash]),
      UNIQUE,
      'applications_api_key_hash_key',
    );
  });
});

describe('endpoints', () => {
  it('requires a whsec_ secret', async () => {
    const appId = await insertApp(db());
    await expectPgError(
      db().query(`INSERT INTO endpoints (app_id, url, secret) VALUES ($1, 'https://x.test', 'plain')`, [appId]),
      CHECK,
      'endpoints_secret_check',
    );
  });

  it('rejects NULL elements in event_types', async () => {
    const appId = await insertApp(db());
    await expectPgError(insertEndpoint(db(), appId, { eventTypes: ['a', null as unknown as string] }), CHECK, 'endpoints_event_types_check');
  });

  it('requires circuit_open_until when the circuit is open', async () => {
    const appId = await insertApp(db());
    const endpointId = await insertEndpoint(db(), appId);
    await expectPgError(
      db().query(`UPDATE endpoints SET circuit_state = 'open' WHERE id = $1`, [endpointId]),
      CHECK,
      'endpoints_open_circuit_has_expiry',
    );
    await db().query(
      `UPDATE endpoints SET circuit_state = 'open', circuit_open_until = now() + interval '30 seconds' WHERE id = $1`,
      [endpointId],
    );
  });

  it('rejects an unknown circuit_state', async () => {
    const appId = await insertApp(db());
    const endpointId = await insertEndpoint(db(), appId);
    await expectPgError(
      db().query(`UPDATE endpoints SET circuit_state = 'broken' WHERE id = $1`, [endpointId]),
      CHECK,
      'endpoints_circuit_state_check',
    );
  });
});

describe('messages', () => {
  it.each([
    ['an array', [1, 2]],
    ['a string', 'hello'],
    ['a number', 42],
    ['null', null],
  ])('rejects %s as payload (must be a JSON object)', async (_label, payload) => {
    const appId = await insertApp(db());
    await expectPgError(
      db().query(`INSERT INTO messages (app_id, event_type, payload) VALUES ($1, 'e', $2::jsonb)`, [
        appId,
        JSON.stringify(payload),
      ]),
      CHECK,
      'messages_payload_check',
    );
  });

  it.each(['', '.starts-with-dot', 'has space', 'x'.repeat(101), 'emoji🙂'])(
    'rejects invalid event_type %j',
    async (eventType) => {
      const appId = await insertApp(db());
      await expectPgError(insertMessage(db(), appId, { eventType }), CHECK, 'messages_event_type_check');
    },
  );

  it.each(['order.created', 'user:signup', 'invoice_paid-v2', 'A'])('accepts event_type %j', async (eventType) => {
    const appId = await insertApp(db());
    await expect(insertMessage(db(), appId, { eventType })).resolves.toBeTypeOf('string');
  });

  it('enforces idempotency keys per app only, and allows many messages without a key', async () => {
    const appA = await insertApp(db(), 'a');
    const appB = await insertApp(db(), 'b');
    await insertMessage(db(), appA, { idempotencyKey: 'k1' });

    await expectPgError(insertMessage(db(), appA, { idempotencyKey: 'k1' }), UNIQUE, 'messages_idempotency_uq');
    await expect(insertMessage(db(), appB, { idempotencyKey: 'k1' })).resolves.toBeTypeOf('string');
    await insertMessage(db(), appA, { idempotencyKey: null });
    await insertMessage(db(), appA, { idempotencyKey: null });
  });
});

describe('deliveries', () => {
  it('rejects an unknown status', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    await expectPgError(
      db().query(`UPDATE deliveries SET status = 'retrying' WHERE id = $1`, [deliveryId]),
      CHECK,
      'deliveries_status_check',
    );
  });

  it('rejects a delivery whose endpoint belongs to another tenant', async () => {
    const appA = await insertApp(db(), 'a');
    const appB = await insertApp(db(), 'b');
    const messageA = await insertMessage(db(), appA);
    const endpointB = await insertEndpoint(db(), appB);

    // app_id = A matches the message but not the endpoint.
    await expectPgError(
      insertDelivery(db(), { appId: appA, messageId: messageA, endpointId: endpointB }),
      FK,
      'deliveries_endpoint_same_app_fk',
    );
    // app_id = B matches the endpoint but not the message.
    await expectPgError(
      insertDelivery(db(), { appId: appB, messageId: messageA, endpointId: endpointB }),
      FK,
      'deliveries_message_same_app_fk',
    );
  });

  it('allows only one delivery per (message, endpoint)', async () => {
    const { appId, messageId, endpointId } = await insertDeliveryGraph(db());
    await expectPgError(
      insertDelivery(db(), { appId, messageId, endpointId }),
      UNIQUE,
      'deliveries_message_endpoint_key',
    );
  });

  it('requires all lease fields when in_flight', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    await expectPgError(
      db().query(`UPDATE deliveries SET status = 'in_flight', lease_token = gen_random_uuid() WHERE id = $1`, [deliveryId]),
      CHECK,
      'deliveries_lease_set_when_in_flight',
    );
    // With all three set it is valid.
    await db().query(
      `UPDATE deliveries SET status = 'in_flight', lease_token = gen_random_uuid(),
         locked_until = now() + interval '30 seconds', locked_by = 'w1' WHERE id = $1`,
      [deliveryId],
    );
  });

  it('forbids lease fields outside in_flight (a stale token can never match again)', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    await expectPgError(
      db().query('UPDATE deliveries SET lease_token = $2 WHERE id = $1', [deliveryId, randomUUID()]),
      CHECK,
      'deliveries_lease_cleared_when_not_in_flight',
    );
  });

  it('sets completed_at exactly for terminal states', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    await expectPgError(
      db().query(`UPDATE deliveries SET status = 'succeeded' WHERE id = $1`, [deliveryId]),
      CHECK,
      'deliveries_completed_at_iff_terminal',
    );
    await expectPgError(
      db().query('UPDATE deliveries SET completed_at = now() WHERE id = $1', [deliveryId]),
      CHECK,
      'deliveries_completed_at_iff_terminal',
    );
    await db().query(`UPDATE deliveries SET status = 'dead', completed_at = now() WHERE id = $1`, [deliveryId]);
  });
});

describe('delivery_attempts', () => {
  // Column names here come from the test code, never from user input; values are parameters.
  const insertAttempt = (deliveryId: string, fields: Record<string, unknown>) => {
    const row = { delivery_id: deliveryId, lease_token: randomUUID(), attempt_number: 1, worker_id: 'w1', ...fields };
    const cols = Object.keys(row);
    return db().query(
      `INSERT INTO delivery_attempts (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };

  it('accepts a 2xx attempt without error_kind', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    await insertAttempt(deliveryId, { response_status: 204, duration_ms: 12 });
  });

  it('requires error_kind for anything that is not a 2xx', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    await expectPgError(insertAttempt(deliveryId, { response_status: 500 }), CHECK, 'delivery_attempts_failure_has_error_kind');
    await expectPgError(insertAttempt(deliveryId, {}), CHECK, 'delivery_attempts_failure_has_error_kind');
    await insertAttempt(deliveryId, { response_status: 500, error_kind: 'http_status' });
    await insertAttempt(deliveryId, { error_kind: 'lease_expired' });
  });

  it('rejects an unknown error_kind', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    await expectPgError(insertAttempt(deliveryId, { error_kind: 'gremlins' }), CHECK, 'delivery_attempts_error_kind_check');
  });

  it('allows exactly one attempt row per lease_token (one per claim)', async () => {
    const { deliveryId } = await insertDeliveryGraph(db());
    const token = randomUUID();
    await insertAttempt(deliveryId, { lease_token: token, response_status: 200 });
    await expectPgError(
      insertAttempt(deliveryId, { lease_token: token, error_kind: 'lease_expired' }),
      UNIQUE,
      'delivery_attempts_lease_token_key',
    );
  });
});

describe('ON DELETE CASCADE', () => {
  it('deleting an application removes all of its data', async () => {
    const { appId, deliveryId } = await insertDeliveryGraph(db());
    await db().query(
      `INSERT INTO delivery_attempts (delivery_id, lease_token, attempt_number, worker_id, response_status)
       VALUES ($1, gen_random_uuid(), 1, 'w1', 200)`,
      [deliveryId],
    );
    const other = await insertDeliveryGraph(db()); // a second tenant must be untouched

    await db().query('DELETE FROM applications WHERE id = $1', [appId]);

    const { rows } = await db().query(
      `SELECT (SELECT count(*) FROM endpoints)::int         AS endpoints,
              (SELECT count(*) FROM messages)::int          AS messages,
              (SELECT count(*) FROM deliveries)::int        AS deliveries,
              (SELECT count(*) FROM delivery_attempts)::int AS attempts`,
    );
    expect(rows[0]).toEqual({ endpoints: 1, messages: 1, deliveries: 1, attempts: 0 });
    const { rows: left } = await db().query('SELECT id FROM deliveries');
    expect(left).toEqual([{ id: other.deliveryId }]);
  });
});
