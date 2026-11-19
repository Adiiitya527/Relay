import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { createSafeHttpClient } from '../../src/delivery/http-client.js';
import { signPayload, verifySignature } from '../../src/delivery/signing.js';
import { createPool } from '../../src/db/pool.js';
import { claimDeliveries } from '../../src/worker/queue.js';
import { createWorker, type Worker } from '../../src/worker/worker.js';
import { buildTestApp, silentLogger, testConfig } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { type Handler, startServer, type TestServer } from '../helpers/servers.js';
import { testDatabaseUrl } from '../helpers/test-db.js';
import { waitFor } from '../helpers/wait.js';

// End to end inside one process: publish through the real API → real worker loop (claim,
// SSRF-safe client, record, sweeper) → local receivers on 127.0.0.1.

const db = useTestDb();
const WORKER_ENV = {
  RELAY_ALLOW_PRIVATE_NETWORKS: 'true', // receivers are on localhost (dev setting)
  ALLOW_HTTP_ENDPOINTS: 'true',
  WORKER_ID: 'test-worker',
  WORKER_CONCURRENCY: '4',
  WORKER_POLL_INTERVAL_MS: '20',
  SWEEP_INTERVAL_MS: '100',
  HTTP_TIMEOUT_MS: '1000',
  LEASE_MS: '7000', // >= 2 * HTTP_TIMEOUT_MS + 5000
  RETRY_BASE_MS: '10',
  RETRY_CAP_MS: '40',
  MAX_ATTEMPTS: '3',
};

let api: FastifyInstance;
let apiKey: string;
const servers: TestServer[] = [];
const workers: Worker[] = [];
const pools: pg.Pool[] = [];

beforeAll(async () => {
  api = buildTestApp(db(), WORKER_ENV);
  await api.ready();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  apiKey = (await createApplication(db(), 'worker-e2e')).apiKey;
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

function startWorker(env: Record<string, string> = {}, pool: pg.Pool = db()): Worker {
  const worker = createWorker({ config: testConfig({ ...WORKER_ENV, ...env }), pool, logger: silentLogger });
  workers.push(worker);
  worker.start();
  return worker;
}

async function receiver(handler?: Handler): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

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

const createEndpoint = (url: string) => call('POST', '/v1/endpoints', { url });
const publish = (payload: Record<string, unknown> = { order: 42 }) =>
  call('POST', '/v1/messages', { event_type: 'order.created', payload });

async function deliveryStatuses(messageId: string): Promise<string[]> {
  const { deliveries } = await call('GET', `/v1/messages/${messageId}`);
  return deliveries.map((d: { status: string }) => d.status);
}

const settled = (messageId: string, expected: string[], timeoutMs = 5_000) =>
  waitFor(
    async () => {
      const statuses = await deliveryStatuses(messageId);
      return statuses.length === expected.length && statuses.every((s, i) => s === expected[i]);
    },
    { timeoutMs, message: `deliveries of ${messageId} to become ${expected.join(',')}` },
  );

async function attempts(messageId: string) {
  const { rows } = await db().query(
    `SELECT a.attempt_number, a.error_kind, a.response_status, a.worker_id
       FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id
      WHERE d.message_id = $1 ORDER BY a.id`,
    [messageId],
  );
  return rows;
}

describe('worker end to end', () => {
  it('delivers a signed request the consumer can verify', async () => {
    const consumer = await receiver();
    const endpoint = await createEndpoint(`${consumer.origin}/hooks/orders`);
    const { message } = await publish({ order: 42, note: 'ünïcødé ✓' });
    startWorker();

    await settled(message.id, ['succeeded']);
    expect(consumer.requests).toHaveLength(1);
    const req = consumer.requests[0]!;
    expect(req.url).toBe('/hooks/orders');
    expect(req.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'Relay/0.1',
      'webhook-id': message.id,
    });
    // The bytes received are exactly payload::text, and the signature verifies over them.
    const { rows } = await db().query('SELECT payload::text AS body FROM messages WHERE id = $1', [
      message.id,
    ]);
    expect(req.body.toString('utf8')).toBe(rows[0].body);
    expect(verifySignature({ secret: endpoint.secret, headers: req.headers, body: req.body })).toEqual({
      ok: true,
    });
    expect(await attempts(message.id)).toEqual([
      { attempt_number: 1, error_kind: null, response_status: 200, worker_id: 'test-worker' },
    ]);
  });

  it('fans out: each subscribed endpoint gets its own delivery', async () => {
    const a = await receiver();
    const b = await receiver();
    await createEndpoint(a.origin);
    await createEndpoint(b.origin);
    const { message } = await publish();
    startWorker();

    await settled(message.id, ['succeeded', 'succeeded']);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it('retries with backoff until the consumer recovers, reusing the same webhook-id', async () => {
    let calls = 0;
    const flaky = await receiver((_req, res) => res.writeHead(++calls <= 2 ? 500 : 200).end());
    await createEndpoint(flaky.origin);
    const { message } = await publish();
    startWorker();

    await settled(message.id, ['succeeded']);
    expect(await attempts(message.id)).toEqual([
      expect.objectContaining({ attempt_number: 1, error_kind: 'http_status', response_status: 500 }),
      expect.objectContaining({ attempt_number: 2, error_kind: 'http_status', response_status: 500 }),
      expect.objectContaining({ attempt_number: 3, error_kind: null, response_status: 200 }),
    ]);
    expect(new Set(flaky.requests.map((r) => r.headers['webhook-id']))).toEqual(new Set([message.id]));
  });

  it('gives up after MAX_ATTEMPTS: the delivery is dead', async () => {
    const broken = await receiver((_req, res) => res.writeHead(503).end('down'));
    await createEndpoint(broken.origin);
    const { message } = await publish();
    startWorker();

    await settled(message.id, ['dead']);
    expect(broken.requests).toHaveLength(3);
    expect((await attempts(message.id)).map((a) => a.attempt_number)).toEqual([1, 2, 3]);
  });

  it('a crash after sending is redelivered with the same webhook-id (at-least-once)', async () => {
    const consumer = await receiver();
    const endpoint = await createEndpoint(consumer.origin);
    const { message } = await publish();

    // A worker claims and sends, then "crashes" before recording the result.
    const [claim] = await claimDeliveries(db(), { limit: 1, leaseMs: 60_000, workerId: 'crashed-worker' });
    const body = Buffer.from(claim!.body);
    const timestamp = Math.floor(Date.now() / 1000);
    const sent = await createSafeHttpClient({ allowPrivateNetworks: true, allowHttp: true, timeoutMs: 1_000 }).post(
      claim!.url,
      {
        'webhook-id': claim!.message_id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signPayload({ secret: endpoint.secret, msgId: claim!.message_id, timestamp, body }),
      },
      body,
    );
    expect(sent.ok).toBe(true);
    // Time passes beyond the lease.
    await db().query(`UPDATE deliveries SET locked_until = now() - interval '1 second'`);

    startWorker(); // its sweeper recovers the row, its claim loop sends it again
    await settled(message.id, ['succeeded']);

    expect(consumer.requests.map((r) => r.headers['webhook-id'])).toEqual([message.id, message.id]);
    expect(await attempts(message.id)).toEqual([
      expect.objectContaining({ attempt_number: 1, error_kind: 'lease_expired', worker_id: 'crashed-worker' }),
      expect.objectContaining({ attempt_number: 2, error_kind: null, worker_id: 'test-worker' }),
    ]);
  });

  it('survives its database connections being killed', async () => {
    const consumer = await receiver();
    await createEndpoint(consumer.origin);
    // The worker gets its own pool so we can kill exactly its connections.
    const workerPool = createPool({
      connectionString: testDatabaseUrl(),
      applicationName: 'relay-worker-e2e',
      logger: { error: () => {} },
    });
    pools.push(workerPool);
    const worker = startWorker({}, workerPool);

    const first = await publish({ n: 1 });
    await settled(first.message.id, ['succeeded']);

    await db().query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'relay-worker-e2e'`,
    );

    const second = await publish({ n: 2 });
    await settled(second.message.id, ['succeeded']);
    expect(consumer.requests).toHaveLength(2);
    expect(worker.inFlight).toBe(0);
  });

  it('stop() waits for an in-progress delivery and records its result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = await receiver((_req, res) => void gate.then(() => res.end('finally')));
    await createEndpoint(slow.origin);
    const { message } = await publish();
    const worker = startWorker();

    await waitFor(() => slow.requests.length === 1, { message: 'request to arrive' });
    expect(worker.inFlight).toBe(1);
    const stopped = worker.stop();
    setTimeout(release, 200); // respond while stop() is waiting
    await stopped;

    expect(worker.inFlight).toBe(0);
    expect(await deliveryStatuses(message.id)).toEqual(['succeeded']);
  });

  it('circuit breaker: an outage opens the circuit, the backlog waits, recovery drains it', async () => {
    let healthy = false;
    const consumer = await receiver((_req, res) => res.writeHead(healthy ? 200 : 503).end());
    const endpoint = await createEndpoint(consumer.origin);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await publish({ i })).message.id);
    startWorker({
      WORKER_CONCURRENCY: '1', // one request at a time: the sequence is deterministic
      CIRCUIT_FAILURE_THRESHOLD: '2',
      CIRCUIT_COOLDOWN_MS: '400',
      MAX_ATTEMPTS: '10',
    });

    // Two failures open the circuit; then only one probe per 400 ms cooldown.
    await waitFor(async () => (await call('GET', `/v1/endpoints/${endpoint.id}`)).circuit_state === 'open', {
      message: 'circuit to open',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // Without the breaker, 4 deliveries × fast retries would have made ~40 requests and
    // gone dead by now. With it: 2 to open + about one probe per cooldown.
    expect(consumer.requests.length).toBeLessThanOrEqual(6);
    // Nothing went dead (a probe may be in flight at this very moment).
    for (const id of ids) expect(['pending', 'in_flight']).toContain((await deliveryStatuses(id))[0]);

    healthy = true; // the endpoint recovers: the next probe succeeds and closes the circuit
    for (const id of ids) await settled(id, ['succeeded']);
    expect((await call('GET', `/v1/endpoints/${endpoint.id}`)).circuit_state).toBe('closed');
  });

  it('never runs more requests at once than WORKER_CONCURRENCY', async () => {
    let open = 0;
    let peak = 0;
    const consumer = await receiver((_req, res) => {
      open++;
      peak = Math.max(peak, open);
      setTimeout(() => {
        open--;
        res.end();
      }, 50);
    });
    await createEndpoint(consumer.origin);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await publish({ i })).message.id);
    startWorker({ WORKER_CONCURRENCY: '3' });

    for (const id of ids) await settled(id, ['succeeded']);
    expect(consumer.requests).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2); // and it does run them in parallel
  });
});
