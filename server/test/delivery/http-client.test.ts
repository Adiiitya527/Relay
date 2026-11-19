import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyError,
  createSafeHttpClient,
  DeliveryTimeoutError,
  type Resolver,
  type SafeHttpClientOptions,
  type SendResult,
  SsrfBlockedError,
} from '../../src/delivery/http-client.js';
import { freePort, type Handler, startServer, TEST_TLS, type TestServer } from '../helpers/servers.js';

// Every test starts its own receivers; close them all afterwards.
const servers: TestServer[] = [];
async function serve(handler?: Handler, tls?: typeof TEST_TLS): Promise<TestServer> {
  const s = await startServer(handler, tls);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Dev-like defaults (the receivers are on 127.0.0.1); SSRF tests switch protection on. */
function client(overrides: Partial<SafeHttpClientOptions> = {}) {
  return createSafeHttpClient({
    allowPrivateNetworks: true,
    allowHttp: true,
    timeoutMs: 2_000,
    ...overrides,
  });
}
const strict = (overrides: Partial<SafeHttpClientOptions> = {}) =>
  client({ allowPrivateNetworks: false, ...overrides });

/** A resolver that answers from a fixed table, like a DNS server the attacker controls. */
function fakeDns(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = async (hostname: string) => {
    calls.push(hostname);
    const addresses = table[hostname];
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);
  };
  return Object.assign(resolver, { calls });
}

const BODY = Buffer.from('{"hello": "world"}');
const post = (c: ReturnType<typeof client>, url: string) =>
  c.post(url, { 'content-type': 'application/json', 'webhook-id': 'msg_1' }, BODY);

function expectFailure(result: SendResult, errorKind: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.errorKind).toBe(errorKind);
  return result;
}

describe('successful and failed responses', () => {
  it('POSTs the exact body and headers and returns ok for 2xx', async () => {
    const server = await serve((_req, res) => res.writeHead(204).end());
    const result = await post(client(), `${server.origin}/hooks/a?x=1#frag`);

    expect(result).toMatchObject({ ok: true, status: 204, excerpt: '' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const [req] = server.requests;
    expect(req).toMatchObject({ method: 'POST', url: '/hooks/a?x=1' }); // fragment never sent
    expect(req!.body.equals(BODY)).toBe(true);
    expect(req!.headers).toMatchObject({
      'content-type': 'application/json',
      'content-length': String(BODY.length),
      'webhook-id': 'msg_1',
      host: `127.0.0.1:${server.port}`,
    });
  });

  it('reports a 500 as http_status with the status and an excerpt of the body', async () => {
    const server = await serve((_req, res) => res.writeHead(500).end('boom'));
    const result = expectFailure(await post(client(), server.origin), 'http_status');
    expect(result).toMatchObject({ status: 500, excerpt: 'boom', errorMessage: 'HTTP 500' });
  });

  it('never follows redirects, even to an allowed address', async () => {
    const target = await serve();
    const redirector = await serve((_req, res) =>
      res.writeHead(302, { location: `${target.origin}/internal` }).end(),
    );
    const result = expectFailure(await post(client(), redirector.origin), 'http_status');
    expect(result.status).toBe(302);
    expect(target.connections).toBe(0);
  });

  it('reads at most 1 KB of a huge body and returns promptly', async () => {
    const server = await serve((_req, res) => res.end(Buffer.alloc(10 * 1024 * 1024, 'a')));
    const result = await post(client(), server.origin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.excerpt).toBe('a'.repeat(1024));
    expect(result.durationMs).toBeLessThan(1_500);
  });

  it('sanitises NUL bytes in the response so the excerpt is storable', async () => {
    const server = await serve((_req, res) => res.writeHead(400).end(Buffer.from('bad\u0000req')));
    const result = expectFailure(await post(client(), server.origin), 'http_status');
    expect(result.excerpt).toBe('badreq');
  });

  it('rejects a status outside 100–599 without reporting it (DB CHECK)', async () => {
    const server = await serve((_req, res) => res.writeHead(999).end());
    const result = await post(client(), server.origin);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBeUndefined();
  });
});

describe('timeouts', () => {
  it('gives up with `timeout` when no response arrives within the deadline', async () => {
    const server = await serve(() => {}); // never responds
    const result = expectFailure(await post(client({ timeoutMs: 300 }), server.origin), 'timeout');
    expect(result.durationMs).toBeGreaterThanOrEqual(250);
    expect(result.durationMs).toBeLessThan(1_500);
  });

  it('once headers arrived, a slow body only shortens the excerpt (D47)', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200);
      res.write('partial'); // …and never ends
    });
    const result = await post(client({ timeoutMs: 300 }), server.origin);
    expect(result).toMatchObject({ ok: true, status: 200, excerpt: 'partial' });
  });
});

describe('network errors', () => {
  it('classifies a refused connection as `connection`', async () => {
    const port = await freePort();
    expectFailure(await post(client(), `http://127.0.0.1:${port}/`), 'connection');
  });

  it('classifies an unknown host as `dns`', async () => {
    const dns = fakeDns({});
    expectFailure(await post(client({ resolve: dns }), 'https://nowhere.test/'), 'dns');
  });

  it('classifies an empty DNS answer as `dns`', async () => {
    const dns = fakeDns({ 'empty.test': [] });
    expectFailure(await post(client({ resolve: dns }), 'https://empty.test/'), 'dns');
  });

  it('never rejects, even when node:http throws synchronously', async () => {
    const server = await serve();
    const result = await client().post(server.origin, { 'x-bad': 'line\nbreak' }, BODY);
    expect(result.ok).toBe(false);
    expect(server.connections).toBe(0);
  });
});

describe('SSRF protection (allowPrivateNetworks = false)', () => {
  it.each([
    ['IPv4 loopback literal', (port: number) => `http://127.0.0.1:${port}/`],
    ['localhost via the system resolver', (port: number) => `http://localhost:${port}/`],
    ['IPv6 loopback literal', (port: number) => `http://[::1]:${port}/`],
    ['IPv4-mapped IPv6 loopback', (port: number) => `http://[::ffff:127.0.0.1]:${port}/`],
    ['cloud metadata address', () => 'http://169.254.169.254/latest/meta-data/'],
    ['private network', () => 'http://10.0.0.1/'],
  ])('blocks %s before any connection is made', async (_name, url) => {
    const server = await serve();
    const result = expectFailure(await post(strict(), url(server.port)), 'ssrf_blocked');
    expect(result.errorMessage).toMatch(/not allowed/);
    expect(server.connections).toBe(0);
  });

  it('blocks a public-looking hostname that resolves to loopback', async () => {
    const server = await serve();
    const dns = fakeDns({ 'evil.test': ['127.0.0.1'] });
    const result = expectFailure(
      await post(strict({ resolve: dns }), `http://evil.test:${server.port}/`),
      'ssrf_blocked',
    );
    expect(result.errorMessage).toBe('evil.test resolved to 127.0.0.1 is not allowed (loopback)');
    expect(dns.calls).toEqual(['evil.test']);
    expect(server.connections).toBe(0);
  });

  it('blocks the whole name if ANY resolved address is private (D42)', async () => {
    const server = await serve();
    const dns = fakeDns({ 'mixed.test': ['93.184.216.34', '127.0.0.1'] });
    expectFailure(
      await post(strict({ resolve: dns }), `http://mixed.test:${server.port}/`),
      'ssrf_blocked',
    );
    expect(server.connections).toBe(0);
  });

  it('connects to exactly the address the lookup validated (IP pinning)', async () => {
    // With private networks allowed, evil.test → 127.0.0.1 reaches the receiver: the
    // socket used OUR answer, not a second DNS query. Host header keeps the name.
    const server = await serve();
    const dns = fakeDns({ 'pinned.test': ['127.0.0.1'] });
    const result = await post(client({ resolve: dns }), `http://pinned.test:${server.port}/`);
    expect(result.ok).toBe(true);
    expect(dns.calls).toEqual(['pinned.test']);
    expect(server.requests[0]!.headers.host).toBe(`pinned.test:${server.port}`);
  });

  it('rejects http: unless ALLOW_HTTP_ENDPOINTS is set', async () => {
    const server = await serve();
    const result = expectFailure(
      await post(client({ allowHttp: false }), server.origin),
      'ssrf_blocked',
    );
    expect(result.errorMessage).toBe('scheme http: is not allowed');
    expect(server.connections).toBe(0);
  });

  it.each([
    ['credentials', 'https://user:pass@example.com/'],
    ['another scheme', 'ftp://example.com/'],
    ['not a URL', 'not a url'],
  ])('rejects %s', async (_name, url) => {
    expectFailure(await post(strict(), url), 'ssrf_blocked');
  });
});

describe('HTTPS', () => {
  const localhostDns = () => fakeDns({ localhost: ['127.0.0.1'], 'other.test': ['127.0.0.1'] });

  it('rejects an untrusted (self-signed) certificate as `tls`', async () => {
    const server = await serve(undefined, TEST_TLS);
    expectFailure(
      await post(client({ resolve: localhostDns() }), `https://localhost:${server.port}/`),
      'tls',
    );
    expect(server.requests).toHaveLength(0);
  });

  it('delivers over TLS when the certificate is trusted', async () => {
    const server = await serve(undefined, TEST_TLS);
    const result = await post(
      client({ resolve: localhostDns(), tlsCa: TEST_TLS.cert }),
      `https://localhost:${server.port}/`,
    );
    expect(result).toMatchObject({ ok: true, status: 200, excerpt: 'ok' });
  });

  it('verifies the certificate against the HOSTNAME, not the pinned IP', async () => {
    // Same IP, same trusted cert, but the cert is for "localhost", not "other.test".
    const server = await serve(undefined, TEST_TLS);
    const result = expectFailure(
      await post(
        client({ resolve: localhostDns(), tlsCa: TEST_TLS.cert }),
        `https://other.test:${server.port}/`,
      ),
      'tls',
    );
    expect(result.errorMessage).toMatch(/ERR_TLS_CERT_ALTNAME_INVALID|altnames/i);
  });
});

describe('classifyError', () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  it.each([
    [new SsrfBlockedError('x'), 'ssrf_blocked'],
    [new DeliveryTimeoutError('x'), 'timeout'],
    [coded('ETIMEDOUT'), 'timeout'],
    [coded('ENOTFOUND'), 'dns'],
    [coded('EAI_AGAIN'), 'dns'],
    [coded('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls'],
    [coded('CERT_HAS_EXPIRED'), 'tls'],
    [coded('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls'],
    [coded('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls'],
    [coded('ERR_SSL_WRONG_VERSION_NUMBER'), 'tls'],
    [coded('EPROTO'), 'tls'],
    [coded('ECONNREFUSED'), 'connection'],
    [coded('ECONNRESET'), 'connection'],
    [new AggregateError([coded('ECONNREFUSED'), coded('ENETUNREACH')]), 'connection'],
    [new AggregateError([coded('ETIMEDOUT')]), 'timeout'],
    [new Error('no code'), 'connection'],
    ['not even an error', 'connection'],
  ])('%s → %s', (err, kind) => {
    expect(classifyError(err)).toBe(kind);
  });
});
