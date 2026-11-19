import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

/** The committed test-only certificate for DNS:localhost (see fixtures/tls/README.md). */
export const TEST_TLS = {
  key: readFileSync(new URL('../fixtures/tls/localhost.key', import.meta.url)),
  cert: readFileSync(new URL('../fixtures/tls/localhost.crt', import.meta.url)),
};

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

export interface TestServer {
  /** http(s)://127.0.0.1:<port> */
  origin: string;
  port: number;
  /** Fully received requests, in arrival order. */
  requests: RecordedRequest[];
  /** TCP connections accepted, including ones that never sent a complete request. */
  connections: number;
  close(): Promise<void>;
}

/**
 * A local receiver on 127.0.0.1 with an OS-assigned port. Records every request; the
 * handler decides the response (default: 200 "ok"). Pass `tls` for an HTTPS server.
 */
export async function startServer(
  handler: Handler = (_req, res) => res.end('ok'),
  tls?: { key: Buffer; cert: Buffer },
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  };
  const server: Server = tls ? createHttpsServer(tls, onRequest) : createHttpServer(onRequest);

  const state = { connections: 0 };
  // 'connection' is the raw TCP accept (for HTTPS: before the TLS handshake), so a blocked
  // request is proven to have never reached the network, not just to have failed later.
  server.on('connection', () => state.connections++);
  // Tests deliberately abort requests and fail handshakes; ignore the resulting noise.
  server.on('clientError', () => {});
  server.on('tlsClientError', () => {});

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    requests,
    get connections() {
      return state.connections;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port with nothing listening on it (listen, read the port, close). */
export async function freePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
