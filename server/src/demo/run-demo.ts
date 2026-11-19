import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------------------
// The end-to-end demo: drives a RUNNING Relay (API + worker) and a running mock consumer
// purely over HTTP, the way a customer would, and narrates what happens:
//
//   1. signed delivery        the consumer verifies every signature independently
//   2. idempotent publish     the same Idempotency-Key twice → one message
//   3. outage → circuit       the endpoint fails, the circuit opens and holds traffic back,
//                             recovery closes it and the backlog drains (no attempts burned)
//   4. dead letter → replay   retries exhausted → dead → visible in the DLQ view → replayed
//   5. at-least-once          a reply slower than Relay's timeout → re-sent with the same
//                             webhook-id → the consumer detects the duplicate
//
// Each chapter uses its own event type and an endpoint subscribed only to it, so chapters
// never see each other's traffic. Hook names carry a run id so reruns don't collide in
// the consumer's duplicate memory.
// ---------------------------------------------------------------------------------------

export interface DemoOptions {
  apiUrl: string;
  mockUrl: string;
  apiKey: string;
  /** The same configuration the worker runs with (used for timings and preflight checks). */
  config: Config;
  print?: (line: string) => void;
  /** Polling interval while waiting for state changes. */
  pollMs?: number;
}

interface Delivery {
  id: string;
  endpoint_id: string;
  status: 'pending' | 'in_flight' | 'succeeded' | 'dead';
  attempt_count: number;
}
interface Endpoint {
  id: string;
  secret: string;
  circuit_state: 'closed' | 'open' | 'half_open';
}
interface Attempt {
  attempt_number: number;
  error_kind: string | null;
  response_status: number | null;
}
interface HookStats {
  received: number;
  processed: number;
  failed: number;
  duplicates: number;
  retries: number;
  invalid_signatures: number;
  unverified: number;
}

export class DemoError extends Error {}

/**
 * Upper bound for one delivery to go from pending to dead: every backoff at its +20 %
 * jitter maximum, every attempt hitting the HTTP timeout, and (once the circuit opens) a
 * full cooldown before each further attempt. Generous on purpose: it is a wait limit.
 */
export function worstCaseDeadMs(config: Config): number {
  const { baseMs, capMs, maxAttempts } = config.retry;
  let total = 0;
  for (let n = 1; n <= maxAttempts; n++) {
    total += config.worker.httpTimeoutMs + config.worker.pollIntervalMs;
    if (n < maxAttempts) total += Math.min(capMs, baseMs * 2 ** (n - 1)) * 1.2;
    if (n >= config.circuit.failureThreshold) total += config.circuit.cooldownMs;
  }
  return total;
}

export async function runDemo(options: DemoOptions): Promise<void> {
  const { config } = options;
  const print = options.print ?? ((line: string) => console.log(line));
  const pollMs = options.pollMs ?? 250;
  const run = randomUUID().slice(0, 8);
  const api = options.apiUrl.replace(/\/$/, '');
  const mock = options.mockUrl.replace(/\/$/, '');

  // --- tiny HTTP helpers (built-in fetch; only our own API and the mock are called) ---
  async function request<T>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      // content-type only with a body: the API rejects an empty body declared as JSON.
      headers: { ...(init.body !== undefined && { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    }).catch((err: unknown) => {
      throw new DemoError(`cannot reach ${new URL(url).origin}: ${(err as Error).message}`);
    });
    const text = await res.text();
    if (!res.ok) throw new DemoError(`${init.method ?? 'GET'} ${new URL(url).pathname} → ${res.status} ${text}`);
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
  const relay = <T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    request<T>(`${api}${path}`, { ...init, headers: { authorization: `Bearer ${options.apiKey}`, ...init.headers } });
  const control = (body: Record<string, unknown>) => request(`${mock}/control`, { body });
  const hookStats = async (hook: string): Promise<HookStats> => {
    const { body } = await request<{ hooks: Record<string, HookStats> }>(`${mock}/stats`);
    return body.hooks[hook] ?? { received: 0, processed: 0, failed: 0, duplicates: 0, retries: 0, invalid_signatures: 0, unverified: 0 };
  };

  async function waitUntil(what: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new DemoError(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function endpoint(chapter: string, eventType: string) {
    const hook = `${chapter}-${run}`;
    const { body } = await relay<Endpoint>('/v1/endpoints', {
      body: { url: `${mock}/hooks/${hook}`, description: `demo: ${chapter}`, event_types: [eventType] },
    });
    // Hand the consumer this endpoint's signing secret (it is never printed).
    await control({ hook, secret: body.secret });
    return { id: body.id, hook };
  }
  const publish = (eventType: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    relay<{ message: { id: string }; deliveries: Delivery[] }>('/v1/messages', {
      body: { event_type: eventType, payload },
      headers,
    });
  const deliveriesOf = async (endpointId: string) =>
    (await relay<{ data: Delivery[] }>(`/v1/deliveries?endpoint_id=${endpointId}&limit=100`)).body.data;
  const circuitOf = async (endpointId: string) =>
    (await relay<Endpoint>(`/v1/endpoints/${endpointId}`)).body.circuit_state;
  const allIn = async (endpointId: string, status: Delivery['status'], count: number) => {
    const list = await deliveriesOf(endpointId);
    return list.length === count && list.every((d) => d.status === status);
  };
  const seconds = (ms: number) => (ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
  const deadBudget = worstCaseDeadMs(config) * 1.5 + 10_000;

  // --- preflight ---------------------------------------------------------------------
  print('Relay end-to-end demo');
  print(`  API ${api}   mock consumer ${mock}   run ${run}`);
  await request(`${api}/healthz`);
  await request(`${mock}/health`);
  if (!config.security.allowHttpEndpoints || !config.security.allowPrivateNetworks) {
    throw new DemoError(
      'The mock consumer is a local http:// URL. Set ALLOW_HTTP_ENDPOINTS=true and ' +
        'RELAY_ALLOW_PRIVATE_NETWORKS=true for the API and worker (local development only).',
    );
  }
  if (config.retry.maxAttempts < 2) throw new DemoError('MAX_ATTEMPTS must be >= 2 for the demo.');
  print(
    `  retries: ${config.retry.maxAttempts} attempts, base ${seconds(config.retry.baseMs)}; circuit: opens after ` +
      `${config.circuit.failureThreshold} failures, cooldown ${seconds(config.circuit.cooldownMs)}; ` +
      `HTTP timeout ${seconds(config.worker.httpTimeoutMs)}`,
  );
  print(`  slowest chapter (dead letter) can take up to ~${seconds(worstCaseDeadMs(config))} with these settings.`);

  // --- 1. signed delivery ------------------------------------------------------------
  print('\n[1] Signed delivery');
  const happy = await endpoint('happy', 'demo.happy');
  for (let i = 1; i <= 3; i++) await publish('demo.happy', { order: i, note: 'ünïcødé ✓' });
  await waitUntil('3 deliveries to succeed', 30_000, () => allIn(happy.id, 'succeeded', 3));
  const s1 = await hookStats(happy.hook);
  print(`  3 published → 3 succeeded. Consumer: ${s1.processed} processed, ${s1.invalid_signatures} invalid signatures.`);
  if (s1.invalid_signatures !== 0 || s1.unverified !== 0) throw new DemoError('signature verification failed');
  print('  Every request was verified by the consumer\'s own Standard Webhooks implementation.');

  // --- 2. idempotent publish ---------------------------------------------------------
  print('\n[2] Idempotent publish');
  const key = `demo-${run}`;
  const first = await publish('demo.happy', { order: 99 }, { 'idempotency-key': key });
  const again = await publish('demo.happy', { order: 99 }, { 'idempotency-key': key });
  print(`  first  → ${first.status} message ${first.body.message.id}`);
  print(`  retry  → ${again.status} message ${again.body.message.id} (the original, not a copy)`);
  if (first.body.message.id !== again.body.message.id) throw new DemoError('idempotency key did not dedupe');
  await waitUntil('the idempotent message to be delivered', 30_000, () => allIn(happy.id, 'succeeded', 4));
  print(`  The endpoint received 4 messages in total, not 5.`);

  // --- 3. outage → circuit breaker ---------------------------------------------------
  print('\n[3] Outage → circuit breaker');
  const outage = await endpoint('outage', 'demo.outage');
  await control({ hook: outage.hook, mode: 'fail' });
  const threshold = config.circuit.failureThreshold;
  for (let i = 1; i <= threshold; i++) await publish('demo.outage', { n: i });
  print(`  Consumer answers 500. Published ${threshold} messages (= the failure threshold).`);
  await waitUntil('the circuit to open', 30_000, async () => (await circuitOf(outage.id)) !== 'closed');
  const atOpen = (await hookStats(outage.hook)).received;
  print(`  Circuit OPEN after ${atOpen} failed requests.`);
  // Publish more while it is open: they are accepted and queued, but not sent.
  const extra = 5;
  for (let i = 1; i <= extra; i++) await publish('demo.outage', { n: threshold + i });
  const holdMs = Math.min(1_000, config.circuit.cooldownMs / 2);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  const heldRequests = (await hookStats(outage.hook)).received - atOpen;
  const pendingNow = (await deliveriesOf(outage.id)).filter((d) => d.status === 'pending').length;
  print(`  Published ${extra} more. ${seconds(holdMs)} later: ${pendingNow} deliveries pending, ${heldRequests} new requests sent.`);
  print('  The open circuit holds the backlog instead of hammering a broken endpoint.');
  const backlog = threshold + extra;
  await control({ hook: outage.hook, mode: 'ok' });
  print(`  Consumer recovers. After the ${seconds(config.circuit.cooldownMs)} cooldown one probe goes out…`);
  await waitUntil('the backlog to drain', deadBudget, () => allIn(outage.id, 'succeeded', backlog));
  const maxAttempts = Math.max(...(await deliveriesOf(outage.id)).map((d) => d.attempt_count));
  print(`  Probe succeeded → circuit ${(await circuitOf(outage.id)).toUpperCase()}; all ${backlog} delivered.`);
  print(`  Most attempts any delivery needed: ${maxAttempts} of ${config.retry.maxAttempts} (skipped while open ≠ attempted).`);

  // --- 4. dead letter → replay -------------------------------------------------------
  print('\n[4] Dead letter → replay');
  const dead = await endpoint('dead', 'demo.dead');
  await control({ hook: dead.hook, mode: 'fail' });
  const { body: published } = await publish('demo.dead', { invoice: 7 });
  const deliveryId = published.deliveries[0]!.id;
  print(`  Consumer fails every attempt; waiting for ${config.retry.maxAttempts} attempts with backoff…`);
  await waitUntil('the delivery to be dead', deadBudget, () => allIn(dead.id, 'dead', 1));
  const { body: timeline } = await relay<{ data: Attempt[] }>(`/v1/deliveries/${deliveryId}/attempts`);
  print(`  DEAD after ${timeline.data.length} attempts: ${timeline.data.map((a) => a.response_status ?? a.error_kind).join(', ')}`);
  const { body: dlq } = await relay<{ data: Delivery[] }>(`/v1/deliveries?status=dead&endpoint_id=${dead.id}`);
  print(`  GET /v1/deliveries?status=dead lists it (${dlq.data.length} row).`);
  await control({ hook: dead.hook, mode: 'ok' });
  const { body: replay } = await relay<{ replayed: number }>(`/v1/endpoints/${dead.id}/replay-dead`, { method: 'POST' });
  print(`  Consumer fixed; POST /v1/endpoints/:id/replay-dead → replayed ${replay.replayed}.`);
  await waitUntil('the replayed delivery to succeed', deadBudget, () => allIn(dead.id, 'succeeded', 1));
  const { body: after } = await relay<{ data: Attempt[] }>(`/v1/deliveries/${deliveryId}/attempts`);
  print(`  Succeeded. Attempt history kept: ${after.data.length} rows (the replay started again at attempt 1).`);

  // --- 5. at-least-once: a lost acknowledgement --------------------------------------
  print('\n[5] At-least-once: a reply that arrives too late');
  const slow = await endpoint('slow', 'demo.slow');
  const delayMs = config.worker.httpTimeoutMs + 1_000;
  await control({ hook: slow.hook, mode: 'slow', delay_ms: delayMs });
  const { body: slowMsg } = await publish('demo.slow', { shipment: 3 });
  print(`  The consumer processes it but replies after ${seconds(delayMs)}; Relay gives up at ${seconds(config.worker.httpTimeoutMs)}…`);
  await waitUntil('the re-send to succeed', deadBudget, () => allIn(slow.id, 'succeeded', 1));
  const s5 = await hookStats(slow.hook);
  const { body: slowAttempts } = await relay<{ data: Attempt[] }>(`/v1/deliveries/${slowMsg.deliveries[0]!.id}/attempts`);
  print(`  Relay's attempts: ${slowAttempts.data.map((a) => a.response_status ?? a.error_kind).join(', ')}`);
  print(`  Consumer: received ${s5.received}, processed ${s5.processed}, duplicates detected ${s5.duplicates}.`);
  print('  Same webhook-id on every send, so the consumer can deduplicate: at-least-once, handled.');

  await control({ hook: slow.hook, mode: 'ok' });
  print('\nDemo complete. Explore: GET /v1/deliveries, GET /v1/deliveries/:id/attempts, mock GET /stats.');
}
