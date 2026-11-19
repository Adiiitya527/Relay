// @ts-check
// Standard Webhooks signature verification, written independently of server/src/delivery/
// signing.ts on purpose: if Relay's signer and this verifier (sharing no code) agree on the
// published test vector AND on live traffic, the signature scheme is interoperable, not just
// self-consistent.
//
//   signed content = "<webhook-id>.<webhook-timestamp>.<raw body>"
//   key            = base64-decode(secret without the "whsec_" prefix)
//   header         = space-separated list of "v1,<base64 HMAC-SHA256(key, content)>"
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @typedef {{ ok: true } | { ok: false, reason: string }} VerifyResult
 */

/**
 * @param {{
 *   secret: string,
 *   headers: Record<string, string | string[] | undefined>,
 *   body: Buffer,
 *   nowSec?: number,
 *   toleranceSec?: number,
 * }} input
 * @returns {VerifyResult}
 */
export function verifyWebhook({ secret, headers, body, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300 }) {
  const id = single(headers['webhook-id']);
  const timestamp = single(headers['webhook-timestamp']);
  const signatures = single(headers['webhook-signature']);
  if (!id || !timestamp || !signatures) return { ok: false, reason: 'missing_headers' };

  // Integer seconds only; a replayed request with an old timestamp is rejected even if the
  // signature is valid (that is what the timestamp is for).
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  if (key.length === 0) return { ok: false, reason: 'bad_secret' };
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();

  // Several signatures are allowed (secret rotation). Compare each in constant time;
  // timingSafeEqual needs equal lengths, so a wrong-length candidate is skipped first.
  for (const entry of signatures.split(' ')) {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const candidate = Buffer.from(value, 'base64');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no_matching_signature' };
}

/** @param {string | string[] | undefined} value */
function single(value) {
  return Array.isArray(value) ? value[0] : value;
}
