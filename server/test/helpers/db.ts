import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { testDatabaseUrl } from './test-db.js';

/** Every table owned by migrations, child tables first. schema_migrations is never truncated. */
const TABLES = ['delivery_attempts', 'deliveries', 'messages', 'endpoints', 'applications'];

/**
 * A pool on the test database. max = 20 by default (plan A2): tests that fire concurrent
 * requests hold connections while transactions wait on each other, and a small pool
 * would make them time out waiting for a connection instead of testing the real race.
 */
export function createTestPool(max = 20): pg.Pool {
  return createPool({
    connectionString: testDatabaseUrl(),
    max,
    statementTimeoutMs: 10_000,
    idleInTxTimeoutMs: 10_000,
    applicationName: 'relay-test',
    logger: { error: (obj, msg) => console.error(`[test pool] ${msg}`, obj) },
  });
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  // RESTART IDENTITY resets delivery_attempts.id; CASCADE is belt-and-braces for FKs.
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Call at the top of a DB test file. Opens one pool for the file, truncates all tables
 * before every test (CLAUDE.md: each test starts from empty tables) and closes the pool.
 * Returns a getter because the pool only exists once beforeAll has run.
 */
export function useTestDb(): () => pg.Pool {
  let pool: pg.Pool | undefined;
  beforeAll(() => {
    pool = createTestPool();
  });
  beforeEach(async () => {
    await truncateAll(get());
  });
  afterAll(async () => {
    await pool?.end();
  });
  function get(): pg.Pool {
    if (!pool) throw new Error('test pool not initialised (call useTestDb() at file top level)');
    return pool;
  }
  return get;
}

// ---------------------------------------------------------------------------
// Fixture builders: raw inserts for schema-level tests. API tests use the real code paths.
// ---------------------------------------------------------------------------

export async function insertApp(db: pg.Pool, name = 'test-app'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO applications (name, api_key_hash) VALUES ($1, $2) RETURNING id',
    [name, randomBytes(32)],
  );
  return rows[0]!.id;
}

export async function insertEndpoint(
  db: pg.Pool,
  appId: string,
  opts: { url?: string; eventTypes?: string[]; disabled?: boolean } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO endpoints (app_id, url, event_types, secret, disabled)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      appId,
      opts.url ?? 'https://example.com/hook',
      opts.eventTypes ?? [],
      `whsec_${randomBytes(24).toString('base64')}`,
      opts.disabled ?? false,
    ],
  );
  return rows[0]!.id;
}

export async function insertMessage(
  db: pg.Pool,
  appId: string,
  opts: { eventType?: string; payload?: unknown; idempotencyKey?: string | null } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO messages (app_id, event_type, payload, idempotency_key)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
    // Always JSON.stringify: pg would turn a JS array into a Postgres array literal.
    [appId, opts.eventType ?? 'order.created', JSON.stringify(opts.payload ?? { ok: true }), opts.idempotencyKey ?? null],
  );
  return rows[0]!.id;
}

export async function insertDelivery(
  db: pg.Pool,
  ids: { appId: string; messageId: string; endpointId: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO deliveries (app_id, message_id, endpoint_id) VALUES ($1, $2, $3) RETURNING id',
    [ids.appId, ids.messageId, ids.endpointId],
  );
  return rows[0]!.id;
}

/** One app with one endpoint, one message and one pending delivery between them. */
export async function insertDeliveryGraph(db: pg.Pool) {
  const appId = await insertApp(db);
  const endpointId = await insertEndpoint(db, appId);
  const messageId = await insertMessage(db, appId);
  const deliveryId = await insertDelivery(db, { appId, messageId, endpointId });
  return { appId, endpointId, messageId, deliveryId };
}
