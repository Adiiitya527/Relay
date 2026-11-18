import { describe, expect, it } from 'vitest';
import { generateEndpointSecret } from '../../src/endpoints/secret.js';
import { decodeSecret, signPayload, verifySignature } from '../../src/delivery/signing.js';

// Published Standard Webhooks / Svix test vector. If this ever fails, the implementation is
// wrong: never edit these values to make it pass.
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  msgId: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: Buffer.from('{"test": 2432232314}'),
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

function headersFor(signature: string, msgId = VECTOR.msgId, ts = VECTOR.timestamp) {
  return { 'webhook-id': msgId, 'webhook-timestamp': String(ts), 'webhook-signature': signature };
}

describe('signPayload', () => {
  it('matches the published Standard Webhooks test vector', () => {
    expect(signPayload(VECTOR)).toBe(VECTOR.signature);
  });

  it('signs the exact bytes: a different serialisation gives a different signature', () => {
    const compact = signPayload({ ...VECTOR, body: Buffer.from('{"test":2432232314}') });
    expect(compact).not.toBe(VECTOR.signature);
  });

  it('accepts a secret without the whsec_ prefix (same key)', () => {
    expect(signPayload({ ...VECTOR, secret: VECTOR.secret.slice(6) })).toBe(VECTOR.signature);
  });

  it.each([
    ['not base64', 'whsec_!!!not-base64!!!'],
    ['empty', 'whsec_'],
  ])('rejects a malformed secret (%s) without echoing it', (_name, secret) => {
    expect(() => signPayload({ ...VECTOR, secret })).toThrow(/signing secret/);
    try {
      decodeSecret(secret);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret.slice(6) || 'whsec_');
    }
  });
});

describe('verifySignature', () => {
  const now = VECTOR.timestamp + 10;
  const base = { secret: VECTOR.secret, body: VECTOR.body, nowSec: now };

  it('accepts the test vector', () => {
    expect(verifySignature({ ...base, headers: headersFor(VECTOR.signature) })).toEqual({
      ok: true,
    });
  });

  it('round-trips with a freshly generated endpoint secret', () => {
    const secret = generateEndpointSecret();
    const body = Buffer.from('{"order": {"id": 42, "note": "ünïcødé ✓"}}');
    const signature = signPayload({ secret, msgId: 'm1', timestamp: now, body });
    expect(
      verifySignature({ secret, body, nowSec: now, headers: headersFor(signature, 'm1', now) }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['body', { body: Buffer.from('{"test": 2432232315}') }, {}],
    ['id', {}, { 'webhook-id': 'msg_other' }],
    ['secret', { secret: generateEndpointSecret() }, {}],
  ])('rejects a tampered %s', (_name, override, headerOverride) => {
    const result = verifySignature({
      ...base,
      ...override,
      headers: { ...headersFor(VECTOR.signature), ...headerOverride },
    });
    expect(result).toEqual({ ok: false, reason: 'no_matching_signature' });
  });

  it('rejects a tampered timestamp (still inside the tolerance window)', () => {
    const headers = headersFor(VECTOR.signature, VECTOR.msgId, VECTOR.timestamp + 1);
    expect(verifySignature({ ...base, headers })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
  });

  it('rejects timestamps outside the tolerance (replay protection)', () => {
    const headers = headersFor(VECTOR.signature);
    expect(verifySignature({ ...base, headers, nowSec: VECTOR.timestamp + 301 })).toEqual({
      ok: false,
      reason: 'timestamp_too_old',
    });
    expect(verifySignature({ ...base, headers, nowSec: VECTOR.timestamp - 301 })).toEqual({
      ok: false,
      reason: 'timestamp_too_new',
    });
    // exactly at the edge is accepted
    expect(verifySignature({ ...base, headers, nowSec: VECTOR.timestamp + 300 }).ok).toBe(true);
  });

  it('accepts when any one of several space-separated signatures matches', () => {
    const header = `v1,AAAA v2,${VECTOR.signature.slice(3)} ${VECTOR.signature}`;
    expect(verifySignature({ ...base, headers: headersFor(header) }).ok).toBe(true);
  });

  it('ignores a non-v1 version even with the right bytes', () => {
    const header = `v2,${VECTOR.signature.slice(3)}`;
    expect(verifySignature({ ...base, headers: headersFor(header) })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
  });

  it.each([
    ['missing id', { 'webhook-id': undefined }, 'missing_headers'],
    ['missing signature', { 'webhook-signature': '' }, 'missing_headers'],
    ['repeated header', { 'webhook-id': ['a', 'b'] }, 'missing_headers'],
    ['non-numeric timestamp', { 'webhook-timestamp': '16e8' }, 'invalid_timestamp'],
    ['negative timestamp', { 'webhook-timestamp': '-1' }, 'invalid_timestamp'],
    ['garbage signature', { 'webhook-signature': 'v1,%%%% ,,, v1' }, 'no_matching_signature'],
    ['truncated signature', { 'webhook-signature': 'v1,g0hM9SsE' }, 'no_matching_signature'],
  ])('rejects %s without throwing', (_name, headerOverride, reason) => {
    const headers = { ...headersFor(VECTOR.signature), ...headerOverride };
    expect(verifySignature({ ...base, headers })).toEqual({ ok: false, reason });
  });
});
