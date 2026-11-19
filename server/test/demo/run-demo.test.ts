import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { DemoError, runDemo, worstCaseDeadMs } from '../../src/demo/run-demo.js';
import { createWorker, type Worker } from '../../src/worker/worker.js';
import { buildTestApp, silentLogger, testConfig } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { type MockConsumerProcess, startMockConsumer } from '../helpers/mock-consumer.js';

// The demo exactly as `npm run demo -w server` runs it, over real HTTP: a listening API,
// the worker loop and the mock consumer process. Fast timings keep it to a few seconds.

const db = useTestDb();
const ENV = {
  RELAY_ALLOW_PRIVATE_NETWORKS: 'true',
  ALLOW_HTTP_ENDPOINTS: 'true',
  WORKER_ID: 'demo-worker',
  WORKER_CONCURRENCY: '8',
  WORKER_POLL_INTERVAL_MS: '20',
  SWEEP_INTERVAL_MS: '100',
  HTTP_TIMEOUT_MS: '300',
  LEASE_MS: '6000',
  RETRY_BASE_MS: '20',
  RETRY_CAP_MS: '100',
  MAX_ATTEMPTS: '4',
  CIRCUIT_FAILURE_THRESHOLD: '3',
  CIRCUIT_COOLDOWN_MS: '400',
};

let api: FastifyInstance;
let apiUrl: string;
let mock: MockConsumerProcess;
let worker: Worker | undefined;

beforeAll(async () => {
  api = buildTestApp(db(), ENV);
  await api.listen({ port: 0, host: '127.0.0.1' });
  apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  mock = await startMockConsumer();
});
afterAll(async () => {
  await mock.stop();
  await api.close();
});
beforeEach(() => {
  worker = createWorker({ config: testConfig(ENV), pool: db(), logger: silentLogger });
  worker.start();
});
afterEach(async () => {
  await worker?.stop();
});

describe('end-to-end demo', () => {
  it('runs every chapter against the real API, worker and mock consumer', async () => {
    const { apiKey } = await createApplication(db(), 'demo');
    const lines: string[] = [];
    await runDemo({ apiUrl, mockUrl: mock.origin, apiKey, config: testConfig(ENV), print: (l) => lines.push(l), pollMs: 50 });
    const out = lines.join('\n');
    if (process.env.DEMO_VERBOSE === 'true') console.log(out); // to read the narration

    expect(out).toContain('3 published → 3 succeeded. Consumer: 3 processed, 0 invalid signatures.');
    expect(out).toMatch(/first {2}→ 202 message (\S+)\n {2}retry {2}→ 200 message \1/);
    expect(out).toContain('Circuit OPEN after');
    expect(out).toContain('circuit CLOSED; all 8 delivered.');
    expect(out).toContain('DEAD after 4 attempts: 500, 500, 500, 500');
    expect(out).toContain('replayed 1.');
    expect(out).toContain('Attempt history kept: 5 rows');
    expect(out).toMatch(/Relay's attempts: timeout(, timeout)*, 200/);
    expect(out).toMatch(/processed 1, duplicates detected [1-9]/);
    expect(out).toContain('Demo complete.');

    // While the circuit was open, the 5 extra messages queued up instead of being sent.
    // (With this test's 400 ms cooldown, one probe may already fit in the 200 ms window.)
    const held = /Published 5 more\. 200 ms later: (\d+) deliveries pending, (\d+) new requests sent\./.exec(out);
    expect(held, out).not.toBeNull();
    expect(Number(held![1])).toBeGreaterThanOrEqual(7);
    expect(Number(held![2])).toBeLessThanOrEqual(1);
    // The API key never appears in the narration.
    expect(out).not.toContain(apiKey);
  }, 60_000);

  it('stops with an explanation when http:// or private addresses are not allowed', async () => {
    const { apiKey } = await createApplication(db(), 'demo-strict');
    const strict = testConfig({ ...ENV, ALLOW_HTTP_ENDPOINTS: 'false' });
    await expect(runDemo({ apiUrl, mockUrl: mock.origin, apiKey, config: strict, print: () => {} })).rejects.toThrow(
      /ALLOW_HTTP_ENDPOINTS=true/,
    );
  });

  it('stops with a clear message when the mock consumer is not running', async () => {
    const { apiKey } = await createApplication(db(), 'demo-nomock');
    const err = await runDemo({ apiUrl, mockUrl: 'http://127.0.0.1:1', apiKey, config: testConfig(ENV), print: () => {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DemoError);
    expect((err as Error).message).toContain('cannot reach http://127.0.0.1:1');
  });
});

describe('worstCaseDeadMs', () => {
  it('adds max-jitter backoffs, a timeout per attempt and a cooldown per attempt once the circuit is open', () => {
    const config = testConfig({
      HTTP_TIMEOUT_MS: '1000',
      LEASE_MS: '7000',
      WORKER_POLL_INTERVAL_MS: '100',
      RETRY_BASE_MS: '1000',
      RETRY_CAP_MS: '3000',
      MAX_ATTEMPTS: '4',
      CIRCUIT_FAILURE_THRESHOLD: '3',
      CIRCUIT_COOLDOWN_MS: '5000',
    });
    // attempts: 4 × (1000 + 100); backoffs: (1000 + 2000 + 3000[capped]) × 1.2;
    // cooldowns before attempts 3 and 4 counted from the threshold: 2 × 5000
    expect(worstCaseDeadMs(config)).toBeCloseTo(4 * 1100 + 6000 * 1.2 + 2 * 5000);
  });
});
