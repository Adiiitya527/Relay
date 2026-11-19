import { exec, execFile, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freePort } from '../helpers/servers.js';
import { testDatabaseUrl } from '../helpers/test-db.js';
import { waitFor } from '../helpers/wait.js';

// The production path: `npm run build -w server` compiles src/ to dist/, and the Docker
// image runs those files with plain `node` (no tsx). These tests build once and run each
// compiled entry point against the TEST database (DATABASE_URL overridden for the child).

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const children: ChildProcess[] = [];

const childEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  DATABASE_URL: testDatabaseUrl(),
  LOG_LEVEL: 'info',
  ...extra,
});

function start(entry: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--enable-source-maps', entry], { cwd: SERVER_DIR, env: childEnv(env) });
  let output = '';
  child.stdout.on('data', (c) => (output += String(c)));
  child.stderr.on('data', (c) => (output += String(c)));
  children.push(child);
  return { child, output: () => output };
}

beforeAll(async () => {
  // `npm` is a .cmd shim on Windows, so run it through the shell.
  await promisify(exec)('npm run build', { cwd: SERVER_DIR, timeout: 120_000 });
}, 150_000);

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null) return resolve();
          c.once('exit', () => resolve());
          c.kill();
        }),
    ),
  );
});

describe('compiled server (dist/)', () => {
  it('migrate:prod finds the migrations folder and reports the database up to date', async () => {
    const { stdout } = await run(process.execPath, ['dist/scripts/migrate.js'], { cwd: SERVER_DIR, env: childEnv() });
    expect(stdout).toContain('database is up to date');
  });

  it('the API starts and answers /healthz', { timeout: 20_000 }, async () => {
    const port = await freePort();
    const api = start('dist/server.js', { API_HOST: '127.0.0.1', API_PORT: String(port) });
    await waitFor(
      async () => {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
        return res?.status === 200;
      },
      { timeoutMs: 10_000, message: `compiled API to answer /healthz\n${api.output()}` },
    );
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ status: 'ok' });
  });

  it('the worker starts', { timeout: 20_000 }, async () => {
    const worker = start('dist/worker/index.js', { WORKER_ID: 'dist-test' });
    await waitFor(async () => worker.output().includes('worker started'), {
      timeoutMs: 10_000,
      message: 'compiled worker to start',
    });
    expect(worker.output()).toContain('"worker_id":"dist-test"');
  });

  it('a bad configuration fails fast with a readable message and no secrets', async () => {
    const result = await run(process.execPath, ['dist/server.js'], {
      cwd: SERVER_DIR,
      env: childEnv({ LEASE_MS: '1000' }),
    }).then(
      () => ({ code: 0, stderr: '' }),
      (err: { code: number; stderr: string }) => err,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('LEASE_MS');
    expect(result.stderr).not.toContain(testDatabaseUrl());
  });
});
