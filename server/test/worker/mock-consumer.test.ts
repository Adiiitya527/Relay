import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { createWorker, type Worker } from '../../src/worker/worker.js';
import { buildTestApp, silentLogger, testConfig } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { type MockConsumerProcess, mockRequest, startMockConsumer } from '../helpers/mock-consumer.js';
import { waitFor } from '../helpers/wait.js';

// Interoperability: the real worker delivers to the real mock consumer, run as a separate
// process exactly as `npm run dev -w mock-consumer` runs it. The consumer verifies
// signatures with its own implementation (mock-consumer/src/verify.js), which shares no
// code with server/src/delivery/signing.ts.

const db = useTestDb();
const WORKER_ENV = {
  RELAY_ALLOW_PRIVATE_NETWORKS: 'true',
  ALLOW_HTTP_ENDPOINTS: 'true',
  WORKER_ID: 'interop-worker',
  WORKER_CONCURRENCY: '4',
  WORKER_POLL_INTERVAL_MS: '20',
  SWEEP_INTERVAL_MS: '100',
  HTTP_TIMEOUT_MS: '500',
  LEASE_MS: '6000',
  RETRY_BASE_MS: '10',
  RETRY_CAP_MS: '40',
  MAX_ATTEMPTS: '5',
};

let api: FastifyInstance;
let apiKey: string;
let mock: MockConsumerProcess | undefined;
let origin: string;
let worker: Worker | undefined;

beforeAll(async () => {
  api = buildTestApp(db(), WORKER_ENV);
  await api.ready();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  apiKey = (await createApplication(db(), 'interop')).apiKey;
  mock = await startMockConsumer();
  origin = mock.origin;
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await mock?.stop();
  mock = undefined;
});

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await api.inject({
    method,
    url,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    ...(payload !== undefined && { payload: JSON.stringify(payload) }),
  });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  return res.json();
}

const consumer = (path: string, body?: unknown) => mockRequest(origin, path, body);

/** Create an endpoint at /hooks/<hook> and give the consumer its signing secret. */
async function endpointFor(hook: string) {
  const endpoint = await call('POST', '/v1/endpoints', { url: `${origin}/hooks/${hook}` });
  await consumer('/control', { hook, secret: endpoint.secret });
  return endpoint;
}

function startWorker() {
  worker = createWorker({ config: testConfig(WORKER_ENV), pool: db(), logger: silentLogger });
  worker.start();
}

const hookStats = async (hook: string) => (await consumer('/stats')).hooks[hook];

describe('mock consumer ↔ real worker', () => {
  it('every delivery passes the independent signature check', async () => {
    await endpointFor('orders');
    for (let i = 0; i < 5; i++) {
      await call('POST', '/v1/messages', { event_type: 'order.created', payload: { i, text: 'ünïcødé ✓' } });
    }
    startWorker();

    await waitFor(async () => (await hookStats('orders'))?.processed === 5, { message: '5 processed' });
    const stats = await hookStats('orders');
    expect(stats).toMatchObject({ received: 5, processed: 5, invalid_signatures: 0, unverified: 0, duplicates: 0 });
    // The consumer answers before the worker records the result; wait for the DB side too.
    await waitFor(async () => {
      const { rows } = await db().query(`SELECT count(*)::int AS n FROM deliveries WHERE status = 'succeeded'`);
      return rows[0].n === 5;
    }, { message: '5 deliveries succeeded' });
  });

  it('a reply slower than Relay\'s timeout causes a re-send the consumer flags as a duplicate', { timeout: 20_000 }, async () => {
    // At-least-once in action: the consumer processes the message, but its 200 arrives after
    // Relay's 500 ms deadline, so Relay records a timeout and retries with the SAME webhook-id.
    await endpointFor('slow');
    await consumer('/control', { hook: 'slow', mode: 'slow', delay_ms: 800 });
    const { message } = await call('POST', '/v1/messages', { event_type: 'order.created', payload: { n: 1 } });
    startWorker();

    await waitFor(async () => (await hookStats('slow'))?.duplicates >= 1, {
      timeoutMs: 8_000,
      message: 'a duplicate to be reported',
    });
    const { deliveries } = await call('GET', `/v1/messages/${message.id}`);
    await waitFor(async () => {
      const { rows } = await db().query(`SELECT status FROM deliveries WHERE id = $1`, [deliveries[0].id]);
      return rows[0].status === 'succeeded';
    }, { message: 'delivery to succeed' });

    const stats = await hookStats('slow');
    expect(stats.processed).toBe(1); // processed once despite several sends
    expect(stats.invalid_signatures).toBe(0);
    const recent = (await consumer('/stats')).recent as { webhook_id: string }[];
    expect(new Set(recent.map((r) => r.webhook_id))).toEqual(new Set([message.id]));

    const { rows: kinds } = await db().query(
      `SELECT error_kind FROM delivery_attempts WHERE delivery_id = $1 ORDER BY id`,
      [deliveries[0].id],
    );
    expect(kinds[0].error_kind).toBe('timeout');
    expect(kinds.at(-1)!.error_kind).toBeNull();
  });
});
