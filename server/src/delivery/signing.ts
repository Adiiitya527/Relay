import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com, ARCHITECTURE §5, D7).
 *
 *   signed content = "{webhook-id}.{webhook-timestamp}.{body}"
 *   signature      = base64( HMAC-SHA256( key, signed content ) )
 *   header         = "v1,<signature>"   (space-separated list; several allowed)
 *
 * The key is NOT the secret string: it is the base64-decoded bytes after the "whsec_"
 * prefix. `body` must be exactly the bytes sent on the wire (D21: payload::text,
 * serialised once), so it is taken as a Buffer and hashed without re-encoding.
 *
 * Pure functions; nothing here logs, and errors never include the secret.
 */

const SECRET_PREFIX = 'whsec_';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Unix seconds as decimal digits. 15 digits is far beyond any real date. */
const TIMESTAMP = /^\d{1,15}$/;

/** whsec_<base64> → HMAC key bytes. Throws (without echoing the value) if malformed. */
export function decodeSecret(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  // Buffer.from(…, 'base64') silently skips invalid characters, so validate first.
  if (!BASE64.test(encoded)) throw new Error('signing secret is not valid base64');
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0) throw new Error('signing secret is empty');
  return key;
}

function hmac(key: Buffer, msgId: string, timestamp: number | string, body: Buffer): Buffer {
  return createHmac('sha256', key).update(`${msgId}.${timestamp}.`).update(body).digest();
}

export interface SignInput {
  secret: string;
  msgId: string;
  /** Unix seconds (the worker's send time: the one allowed use of its clock, invariant 7). */
  timestamp: number;
  body: Buffer;
}

/** Returns the `webhook-signature` header value: "v1,<base64>". */
export function signPayload({ secret, msgId, timestamp, body }: SignInput): string {
  return `v1,${hmac(decodeSecret(secret), msgId, timestamp, body).toString('base64')}`;
}

// ---------------------------------------------------------------------------------------
// Verification: what a consumer does. Used by tests and the worker's end-to-end tests;
// the mock consumer (Day 3) deliberately has its own independent copy (ARCHITECTURE §8).
// ---------------------------------------------------------------------------------------

export type VerifyFailure =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'no_matching_signature';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/** Header values as node:http gives them (lower-case keys; a value may be repeated). */
export type HeaderBag = Record<string, string | string[] | undefined>;

export interface VerifyInput {
  secret: string;
  headers: HeaderBag;
  body: Buffer;
  /** Consumer's clock in unix seconds. Injected so tests are deterministic. */
  nowSec?: number;
  /** Accept timestamps within ± this many seconds (spec default: 5 minutes). */
  toleranceSec?: number;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

/**
 * Never throws on bad input (only on a malformed secret, which is the caller's own
 * configuration). Comparison is constant-time so an attacker cannot learn the correct
 * signature byte by byte from response timing.
 */
export function verifySignature({
  secret,
  headers,
  body,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
}: VerifyInput): VerifyResult {
  const id = single(headers['webhook-id']);
  const ts = single(headers['webhook-timestamp']);
  const sigHeader = single(headers['webhook-signature']);
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_headers' };

  // The timestamp check is what stops an attacker from replaying a captured request later.
  if (!TIMESTAMP.test(ts)) return { ok: false, reason: 'invalid_timestamp' };
  const timestamp = Number(ts);
  if (timestamp < nowSec - toleranceSec) return { ok: false, reason: 'timestamp_too_old' };
  if (timestamp > nowSec + toleranceSec) return { ok: false, reason: 'timestamp_too_new' };

  const expected = hmac(decodeSecret(secret), id, ts, body);
  for (const entry of sigHeader.split(' ')) {
    const [version, encoded] = entry.split(',', 2);
    if (version !== 'v1' || !encoded || !BASE64.test(encoded)) continue;
    const candidate = Buffer.from(encoded, 'base64');
    // timingSafeEqual throws on different lengths; a length mismatch reveals nothing secret.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no_matching_signature' };
}
