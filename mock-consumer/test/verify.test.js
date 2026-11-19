// @ts-check
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyWebhook } from '../src/verify.js';

// The published Standard Webhooks / Svix test vector. Relay's own signer (server/) is
// tested against the same vector, so two implementations sharing no code must agree.
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: Buffer.from('{"test": 2432232314}'),
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

/** @param {Record<string, string | undefined>} [overrides] */
const headers = (overrides = {}) => ({
  'webhook-id': VECTOR.id,
  'webhook-timestamp': String(VECTOR.timestamp),
  'webhook-signature': VECTOR.signature,
  ...overrides,
});

/**
 * @param {Record<string, string | undefined>} h
 * @param {{ body?: Buffer, nowSec?: number }} [opts]
 */
const check = (h, { body = VECTOR.body, nowSec = VECTOR.timestamp } = {}) =>
  verifyWebhook({ secret: VECTOR.secret, headers: h, body, nowSec });

describe('verifyWebhook', () => {
  it('accepts the published test vector', () => {
    assert.deepEqual(check(headers()), { ok: true });
  });

  it('accepts when one of several signatures matches (secret rotation)', () => {
    assert.deepEqual(check(headers({ 'webhook-signature': `v1,AAAA v2,xyz ${VECTOR.signature}` })), { ok: true });
  });

  it('rejects a tampered body, id or timestamp', () => {
    assert.deepEqual(check(headers(), { body: Buffer.from('{"test": 2432232315}') }), { ok: false, reason: 'no_matching_signature' });
    assert.deepEqual(check(headers({ 'webhook-id': 'msg_other' })), { ok: false, reason: 'no_matching_signature' });
    assert.deepEqual(check(headers({ 'webhook-timestamp': String(VECTOR.timestamp + 1) })), { ok: false, reason: 'no_matching_signature' });
  });

  it('rejects timestamps outside the 5 minute tolerance, in either direction', () => {
    for (const nowSec of [VECTOR.timestamp + 301, VECTOR.timestamp - 301]) {
      assert.deepEqual(check(headers(), { nowSec }), { ok: false, reason: 'timestamp_out_of_tolerance' });
    }
    assert.deepEqual(check(headers(), { nowSec: VECTOR.timestamp + 300 }), { ok: true });
  });

  it('rejects missing headers, bad timestamps and malformed signatures without throwing', () => {
    assert.deepEqual(check(headers({ 'webhook-id': undefined })), { ok: false, reason: 'missing_headers' });
    assert.deepEqual(check(headers({ 'webhook-timestamp': '1614265330.5' })), { ok: false, reason: 'bad_timestamp' });
    for (const sig of ['garbage', 'v1,', 'v1,g0hM9SsE', 'v1,!!!!']) {
      assert.deepEqual(check(headers({ 'webhook-signature': sig })), { ok: false, reason: 'no_matching_signature' }, sig);
    }
  });

  it('round-trips with a freshly generated secret, and a different secret fails', () => {
    const key = randomBytes(24);
    const body = Buffer.from(JSON.stringify({ hello: 'wörld' }));
    const sig = createHmac('sha256', key).update('msg_1.1700000000.').update(body).digest('base64');
    const h = { 'webhook-id': 'msg_1', 'webhook-timestamp': '1700000000', 'webhook-signature': `v1,${sig}` };
    const verify = (/** @type {Buffer} */ k) =>
      verifyWebhook({ secret: `whsec_${k.toString('base64')}`, headers: h, body, nowSec: 1700000000 });
    assert.deepEqual(verify(key), { ok: true });
    assert.equal(verify(randomBytes(24)).ok, false);
  });
});
