import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../../../mock-consumer/src/index.js', import.meta.url));

export interface MockConsumerProcess {
  origin: string;
  stop(): Promise<void>;
}

/**
 * Runs the real mock consumer as a separate process, exactly as
 * `npm run dev -w mock-consumer` does, on a free port. Resolves once it prints its
 * {"listening": "..."} readiness line.
 */
export async function startMockConsumer(): Promise<MockConsumerProcess> {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_HOST: '127.0.0.1', MOCK_QUIET: 'true' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const origin = await new Promise<string>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`mock consumer exited early (${code})`)));
    lines.on('line', (line) => {
      try {
        const parsed = JSON.parse(line) as { listening?: string };
        if (parsed.listening) resolve(parsed.listening);
      } catch {
        // not the readiness line
      }
    });
  });
  return {
    origin,
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

/** GET/POST JSON against the mock consumer; fails the test on a non-200. */
export async function mockRequest(origin: string, path: string, body?: unknown): Promise<any> { // any: untyped test JSON
  const res = await fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (res.status !== 200) throw new Error(`mock ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}
