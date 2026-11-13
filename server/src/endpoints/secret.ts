import { randomBytes } from 'node:crypto';

export const ENDPOINT_SECRET_PREFIX = 'whsec_';

/**
 * Signing secret in the Standard Webhooks format: "whsec_" + base64(random bytes).
 * The part after the prefix is base64-decoded to get the HMAC key (consumers' SDKs do the
 * same), so it is standard base64, not base64url. 24 bytes = 192 bits, the size the
 * Standard Webhooks reference implementation generates; 24 is a multiple of 3, so no '='.
 */
export function generateEndpointSecret(): string {
  return ENDPOINT_SECRET_PREFIX + randomBytes(24).toString('base64');
}
