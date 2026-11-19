import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import { sanitizeText, TEXT_LIMIT, toExcerpt } from './excerpt.js';
import { classifyAddress } from './ip-policy.js';

/**
 * The SSRF-safe HTTP client (ARCHITECTURE §5, D41–D48). Invariant 8: this is the ONLY
 * code that may send a request to a customer-controlled URL.
 *
 * The threat: an endpoint URL is attacker-controlled. Without this client a tenant could
 * register http://169.254.169.254/ (cloud credentials) or http://localhost:5432 and make
 * Relay probe its own network. Checking the URL string is not enough:
 *   - a hostname can resolve to an internal address (evil.example → 127.0.0.1);
 *   - DNS can change between "check" and "connect" (DNS rebinding);
 *   - a public server can redirect to an internal one.
 *
 * How each is defeated:
 *   1. IP-literal hosts are classified up front (D43). Node never calls `lookup` for
 *      them, so step 2 alone would miss http://127.0.0.1/.
 *   2. Hostnames are resolved by OUR `lookup` function, which Node's socket uses to get
 *      the address it connects to. We validate every address it returns (D42) and hand
 *      back exactly those addresses, so the address that was checked IS the address that
 *      is connected to: there is no second DNS query for a rebinding attack to change.
 *   3. Redirects are never followed (node:http doesn't follow them; a 3xx is a failure).
 *   4. One total deadline and a 1 KB read cap bound the time and memory one endpoint can
 *      cost us (D47).
 *
 * `post()` never rejects: every outcome is a SendResult, ready to be recorded.
 */

export type ErrorKind = 'timeout' | 'dns' | 'connection' | 'tls' | 'ssrf_blocked' | 'http_status';

export type SendResult =
  | { ok: true; status: number; excerpt: string; durationMs: number }
  | {
      ok: false;
      errorKind: ErrorKind;
      errorMessage: string;
      /** Present only when a valid HTTP status line was received. */
      status?: number;
      excerpt?: string;
      durationMs: number;
    };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** hostname → every address it resolves to. Injectable so tests can simulate evil DNS. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** The OS resolver (getaddrinfo), returning ALL addresses in the OS's order. */
export const systemResolver: Resolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, order: 'verbatim' });
  return addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export class SsrfBlockedError extends Error {
  readonly code = 'ERR_SSRF_BLOCKED';
  override readonly name = 'SsrfBlockedError';
}

/** Our total deadline fired before a response arrived. */
export class DeliveryTimeoutError extends Error {
  readonly code = 'ERR_DELIVERY_TIMEOUT';
  override readonly name = 'DeliveryTimeoutError';
}

export interface SafeHttpClientOptions {
  /** RELAY_ALLOW_PRIVATE_NETWORKS: local development only (the receiver is on localhost). */
  allowPrivateNetworks: boolean;
  /** ALLOW_HTTP_ENDPOINTS. Without it only https: is allowed. */
  allowHttp: boolean;
  /** HTTP_TIMEOUT_MS: total budget for DNS + connect + TLS + response. */
  timeoutMs: number;
  resolve?: Resolver;
  /** TESTS ONLY: extra trusted CA for the self-signed test certificate. */
  tlsCa?: string | Buffer;
}

export interface SafeHttpClient {
  post(url: string, headers: Record<string, string>, body: Buffer): Promise<SendResult>;
}

// ---------------------------------------------------------------------------------------
// Error classification (pure). Maps Node/OpenSSL errors to delivery_attempts.error_kind.
// ---------------------------------------------------------------------------------------

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
// Node's own TLS errors and OpenSSL verification codes (self-signed, expired, wrong host…).
const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH|EPROTO$)/;

function errorCode(err: unknown): string {
  // With several addresses, Node's "happy eyeballs" connect reports an AggregateError
  // holding one error per address; classify by the first.
  if (err instanceof AggregateError && err.errors.length > 0) return errorCode(err.errors[0]);
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return '';
}

export function classifyError(err: unknown): Exclude<ErrorKind, 'http_status'> {
  if (err instanceof SsrfBlockedError) return 'ssrf_blocked';
  if (err instanceof DeliveryTimeoutError) return 'timeout';
  const code = errorCode(err);
  if (DNS_CODES.has(code)) return 'dns';
  if (TLS_CODE.test(code)) return 'tls';
  if (code === 'ETIMEDOUT') return 'timeout'; // OS-level connect timeout
  return 'connection'; // ECONNREFUSED, ECONNRESET, EHOSTUNREACH, parse errors, …
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  // Our own errors already carry a readable message; the code would only be noise.
  if (err instanceof SsrfBlockedError || err instanceof DeliveryTimeoutError) {
    return sanitizeText(err.message);
  }
  const code = errorCode(err);
  const message = err.message || err.name;
  return sanitizeText(code && !message.includes(code) ? `${code}: ${message}` : message);
}

// ---------------------------------------------------------------------------------------

export function createSafeHttpClient(opts: SafeHttpClientOptions): SafeHttpClient {
  const resolve = opts.resolve ?? systemResolver;

  /** Rejection reason if `address` may not be connected to, else undefined. */
  function blockedReason(address: string): string | undefined {
    if (opts.allowPrivateNetworks) return undefined;
    const verdict = classifyAddress(address);
    return verdict.blocked ? `${address} is not allowed (${verdict.reason})` : undefined;
  }

  // Node's socket calls this instead of dns.lookup. Whatever we pass to `callback` is what
  // it connects to: that is the IP pinning.
  const safeLookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          const err: NodeJS.ErrnoException = new Error(`no addresses for ${hostname}`);
          err.code = 'ENOTFOUND';
          callback(err, '');
          return;
        }
        // D42: one bad address blocks the whole name. Filtering would let an attacker
        // mix answers and play games with which one gets used.
        for (const { address } of addresses) {
          const reason = blockedReason(address);
          if (reason) {
            callback(new SsrfBlockedError(`${hostname} resolved to ${reason}`), '');
            return;
          }
        }
        // Node asks for all addresses (`all: true`) when it races IPv4/IPv6 connections
        // ("happy eyeballs"), otherwise for one.
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };

  async function post(
    rawUrl: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<SendResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const failure = (
      errorKind: ErrorKind,
      message: string,
      extra: { status?: number; excerpt?: string } = {},
    ): SendResult => ({
      ok: false,
      errorKind,
      errorMessage: sanitizeText(message),
      ...extra,
      durationMs: elapsed(),
    });

    // --- URL policy (endpoints were validated at create time; this is the real check) ---
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return failure('ssrf_blocked', 'endpoint URL is not a valid URL');
    }
    const isHttps = url.protocol === 'https:';
    if (!isHttps && !(url.protocol === 'http:' && opts.allowHttp)) {
      return failure('ssrf_blocked', `scheme ${url.protocol} is not allowed`);
    }
    if (url.username || url.password) {
      return failure('ssrf_blocked', 'credentials in the endpoint URL are not allowed');
    }
    // URL keeps brackets around IPv6 literals; node:http wants the bare address.
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(host)) {
      const reason = blockedReason(host); // D43: lookup is never called for literals
      if (reason) return failure('ssrf_blocked', reason);
    }

    // --- the request ---
    return new Promise<SendResult>((resolvePromise) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let req: ClientRequest | undefined;
      let status: number | undefined;
      const chunks: Buffer[] = [];
      let received = 0;

      const settle = (result: SendResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Destroy rather than drain: we never read more than 1 KB (D47), and with
        // agent: false the socket is never reused anyway.
        req?.destroy();
        resolvePromise(result);
      };

      // Called once the status is known and the excerpt is complete (or cut short).
      const finishResponse = () => {
        if (settled || status === undefined) return;
        const excerpt = toExcerpt(Buffer.concat(chunks));
        if (status < 100 || status > 599) {
          // llhttp accepts any 3-digit status; the DB only stores 100–599.
          settle(failure('http_status', `invalid HTTP status ${status}`, { excerpt }));
        } else if (status >= 200 && status <= 299) {
          settle({ ok: true, status, excerpt, durationMs: elapsed() });
        } else {
          // Includes 3xx: redirects are never followed.
          settle(failure('http_status', `HTTP ${status}`, { status, excerpt }));
        }
      };

      timer = setTimeout(() => {
        // D47: once the status is known the outcome is decided; a slow body only
        // shortens the excerpt.
        if (status !== undefined) finishResponse();
        else req?.destroy(new DeliveryTimeoutError(`no response within ${opts.timeoutMs} ms`));
      }, opts.timeoutMs);

      try {
        req = (isHttps ? httpsRequest : httpRequest)({
          protocol: url.protocol,
          hostname: host,
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: { ...headers, 'content-length': String(body.length) },
          lookup: safeLookup,
          agent: false, // D48: fresh connection per delivery, nothing shared
          ...(isHttps && opts.tlsCa !== undefined && { ca: opts.tlsCa }),
        });
      } catch (err) {
        // e.g. a header value with a newline: rejected synchronously by node:http.
        settle(failure(classifyError(err), describeError(err)));
        return;
      }

      req.on('response', (res: IncomingMessage) => {
        status = res.statusCode ?? 0;
        res.on('data', (chunk: Buffer) => {
          const room = TEXT_LIMIT - received;
          if (room > 0) {
            chunks.push(chunk.subarray(0, room));
            received += Math.min(room, chunk.length);
          }
          if (received >= TEXT_LIMIT) finishResponse();
        });
        res.on('end', finishResponse);
        // Connection dropped mid-body: the status already decided the outcome.
        res.on('error', finishResponse);
      });

      req.on('error', (err) => {
        if (status !== undefined) finishResponse();
        else settle(failure(classifyError(err), describeError(err)));
      });

      req.end(body);
    });
  }

  return { post };
}
