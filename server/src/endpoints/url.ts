import { z } from 'zod';

export const MAX_ENDPOINT_URL_LENGTH = 2048;

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Create/update-time URL check (ARCHITECTURE §5). Fast feedback only: it does NOT resolve
 * DNS or classify IPs. The SSRF-safe client re-checks every send, because what a hostname
 * resolves to can change after this check (DNS rebinding).
 *
 * Returns the WHATWG-normalised URL (lower-cased host, default port dropped, IDN as
 * punycode), which is what is stored and later requested, so the length limit applies to
 * the normalised form.
 */
export function checkEndpointUrl(raw: string, allowHttp: boolean): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'must be an absolute URL' };
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, reason: allowHttp ? 'scheme must be http or https' : 'scheme must be https' };
  }
  // user:pass@host would be sent as Basic auth and would sit in our DB and dashboards in
  // plain text. Consumers authenticate us via the signature instead.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'must not contain credentials (user:pass@)' };
  }
  if (url.href.length > MAX_ENDPOINT_URL_LENGTH) {
    return { ok: false, reason: `must be at most ${MAX_ENDPOINT_URL_LENGTH} characters` };
  }
  return { ok: true, url: url.href };
}

/** Zod form of checkEndpointUrl; parses to the normalised URL string. */
export function endpointUrlSchema(allowHttp: boolean) {
  return z
    .string()
    .max(MAX_ENDPOINT_URL_LENGTH)
    .transform((raw, ctx) => {
      const result = checkEndpointUrl(raw, allowHttp);
      if (!result.ok) {
        ctx.addIssue({ code: 'custom', message: result.reason });
        return z.NEVER;
      }
      return result.url;
    });
}
