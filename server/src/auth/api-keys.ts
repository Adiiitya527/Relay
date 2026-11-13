import { createHash, randomBytes } from 'node:crypto';

/**
 * API keys: `rly_` + base64url(32 random bytes)  → 47 characters, 256 bits of entropy.
 *
 * - The prefix makes leaked keys easy to recognise (secret scanners, grep, logs review).
 * - base64url uses only [A-Za-z0-9_-], so keys are safe in headers, URLs and shells.
 * - Only SHA-256(key) is stored. A fast hash is fine here (unlike passwords): the input is
 *   256 random bits, so there is no dictionary to brute-force; slow hashes (bcrypt) would
 *   only make every authenticated request slower.
 */

export const API_KEY_PREFIX = 'rly_';
const KEY_BYTES = 32;
const API_KEY_PATTERN = /^rly_[A-Za-z0-9_-]{43}$/; // 32 bytes → 43 base64url chars (no padding)

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url');
}

/** SHA-256 of the full key (prefix included), as the 32-byte value stored in bytea. */
export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Cheap format check before touching the database. Auth (step 5) returns the SAME 401 for
 * malformed and unknown keys, so this only saves a query; it reveals nothing to a caller.
 */
export function looksLikeApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}
