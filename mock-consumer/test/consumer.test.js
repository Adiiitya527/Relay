// @ts-check
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { createMockConsumer } from '../src/consumer.js';

const KEY = randomBytes(24);
const SECRET = `whsec_${KEY.toString('base64')}`;

/** @type {ReturnType<typeof createMockConsumer>[]} */
const open = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

/** @param {Parameters<typeof createMockConsumer>[0]} [options] */
async function start(options) {
  const consumer = createMockConsumer(options);
  open.push(consumer);
  await new Promise((resolve) => consumer.server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = consumer.server.address();
  assert.ok(address && typeof address === 'object');
  return { consumer, origin: `http://127.0.0.1:${address.port}` };
}

/**
 * Minimal HTTP client with no connection reuse: resolves with the status and parsed JSON.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | Buffer }} [opts]
 * @returns {Promise<{ status: number, json: any }>}
 */
function http(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers ?? {}, agent: false }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/**
 * A correctly signed webhook (signed the way Relay signs) unless another key is given.
 * @param {string} origin
 * @param {{ hook?: string, id?: string, body?: string, key?: Buffer }} [opts]
 */
function webhook(origin, { hook = 'orders', id = 'msg_1', body = '{"n":1}', key = KEY } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return http(`${origin}/hooks/${hook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` },
    body,
  });
}

/** @param {string} origin @param {object} body */
const control = (origin, body) =>
  http(`${origin}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** @param {string} origin */
const stats = async (origin) => (await http(`${origin}/stats`)).json;

describe('mock consumer', () => {
  it('ok mode: verifies the signature and answers 200', async () => {
    const { origin } = await start({ secret: SECRET });
    assert.equal((await webhook(origin)).status, 200);
    const s = await stats(origin);
    assert.equal(s.hooks.orders.received, 1);
    assert.equal(s.hooks.orders.processed, 1);
    assert.equal(s.hooks.orders.invalid_signatures, 0);
    assert.equal(s.recent[0].verified, true);
  });

  it('answers 401 for a bad signature and does not process it', async () => {
    const { origin } = await start({ secret: SECRET });
    const res = await webhook(origin, { key: randomBytes(24) });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, 'no_matching_signature');
    const s = await stats(origin);
    assert.equal(s.hooks.orders.invalid_signatures, 1);
    assert.equal(s.hooks.orders.processed, 0);
  });

  it('without a secret it accepts, but counts the request as unverified', async () => {
    const { origin } = await start();
    assert.equal((await webhook(origin)).status, 200);
    assert.equal((await stats(origin)).total.unverified, 1);
  });

  it('per-hook secrets can be set through /control', async () => {
    const { origin } = await start();
    assert.equal((await control(origin, { hook: 'orders', secret: SECRET })).status, 200);
    assert.equal((await webhook(origin, { hook: 'orders' })).status, 200);
    assert.equal((await webhook(origin, { hook: 'orders', id: 'msg_2', key: randomBytes(24) })).status, 401);
    // "other" has no secret: accepted unverified
    assert.equal((await webhook(origin, { hook: 'other', id: 'msg_3', key: randomBytes(24) })).status, 200);
  });

  it('never echoes a configured secret back', async () => {
    const { origin } = await start();
    const res = await control(origin, { hook: 'orders', secret: SECRET });
    assert.ok(!JSON.stringify(res.json).includes(SECRET.slice(6)));
    assert.ok(!JSON.stringify(await stats(origin)).includes(SECRET.slice(6)));
  });

  it('a retry after a failure is a retry; a re-send after a 200 is a duplicate', async () => {
    const { origin } = await start({ secret: SECRET });
    await control(origin, { mode: 'fail' });
    assert.equal((await webhook(origin, { id: 'msg_A' })).status, 500);
    await control(origin, { mode: 'ok' });
    assert.equal((await webhook(origin, { id: 'msg_A' })).status, 200); // the retry gets processed
    const dup = await webhook(origin, { id: 'msg_A' }); // an at-least-once re-send
    assert.equal(dup.status, 200);
    assert.equal(dup.json.duplicate, true);
    const c = (await stats(origin)).hooks.orders;
    assert.deepEqual(
      { received: c.received, failed: c.failed, retries: c.retries, processed: c.processed, duplicates: c.duplicates },
      { received: 3, failed: 1, retries: 1, processed: 1, duplicates: 1 },
    );
  });

  it('tracks duplicates per hook (two endpoints get the same webhook-id by design)', async () => {
    const { origin } = await start({ secret: SECRET });
    await webhook(origin, { hook: 'a', id: 'msg_X' });
    await webhook(origin, { hook: 'b', id: 'msg_X' });
    assert.equal((await stats(origin)).total.duplicates, 0);
  });

  it('flaky mode fails with probability fail_rate (deterministic random)', async () => {
    const rolls = [0.1, 0.9, 0.4, 0.6];
    const { origin } = await start({ secret: SECRET, random: () => rolls.shift() ?? 0 });
    await control(origin, { mode: 'flaky', fail_rate: 0.5 });
    const statuses = [];
    for (const id of ['m1', 'm2', 'm3', 'm4']) statuses.push((await webhook(origin, { id })).status);
    assert.deepEqual(statuses, [500, 200, 500, 200]);
  });

  it('slow mode answers 200 after delay_ms', async () => {
    const { origin } = await start({ secret: SECRET });
    await control(origin, { mode: 'slow', delay_ms: 150 });
    const t0 = performance.now();
    assert.equal((await webhook(origin)).status, 200);
    assert.ok(performance.now() - t0 >= 140);
  });

  it('timeout mode never answers, and close() still finishes', async () => {
    const { consumer, origin } = await start({ secret: SECRET });
    await control(origin, { mode: 'timeout' });
    const pending = webhook(origin);
    const outcome = await Promise.race([
      pending.then(() => 'answered', () => 'errored'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300)),
    ]);
    assert.equal(outcome, 'still waiting');
    assert.equal((await stats(origin)).hooks.orders.held, 1);
    await consumer.close(); // destroys the held socket
    await assert.rejects(pending);
  });

  it('a mode can be set for one hook only', async () => {
    const { origin } = await start({ secret: SECRET });
    await control(origin, { hook: 'broken', mode: 'fail' });
    assert.equal((await webhook(origin, { hook: 'broken' })).status, 500);
    assert.equal((await webhook(origin, { hook: 'healthy' })).status, 200);
  });

  it('reset clears counters and duplicate memory', async () => {
    const { origin } = await start({ secret: SECRET });
    await webhook(origin, { id: 'msg_R' });
    await control(origin, { reset: true });
    assert.equal((await stats(origin)).total.received, 0);
    assert.equal((await webhook(origin, { id: 'msg_R' })).json.duplicate, undefined);
  });

  it('rejects invalid control input with 400', async () => {
    const { origin } = await start();
    for (const body of [{ mode: 'explode' }, { fail_rate: 2 }, { delay_ms: -1 }, { hook: '../x' }, { colour: 'red' }, { secret: '' }]) {
      assert.equal((await control(origin, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await http(`${origin}/control`, { method: 'POST', body: '{not json' })).status, 400);
  });

  it('refuses bodies over 1 MB, and unknown routes', async () => {
    const { origin } = await start();
    // The server may answer 413 and close before the client finishes uploading; both are a refusal.
    const big = await http(`${origin}/hooks/orders`, { method: 'POST', body: Buffer.alloc(1024 * 1024 + 1, 97) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    assert.equal((await http(`${origin}/nope`)).status, 404);
    assert.equal((await http(`${origin}/hooks/orders`)).status, 404); // GET
  });
});
