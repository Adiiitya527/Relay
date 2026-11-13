import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/applications/repo.js';
import { hashApiKey } from '../../src/auth/api-keys.js';
import { useTestDb } from '../helpers/db.js';
import { testDatabaseUrl } from '../helpers/test-db.js';

const db = useTestDb();
const run = promisify(execFile);
const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const KEY_RE = /rly_[A-Za-z0-9_-]{43}/g;

/** Run the real CLI against the TEST database (DATABASE_URL overridden for the child only). */
async function runCreateApp(args: string[]) {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', 'src/scripts/create-app.ts', ...args],
      {
        cwd: SERVER_DIR,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl(), LOG_LEVEL: 'info' },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout: string; stderr: string };
    return { code: e.code ?? 1, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('createApplication', () => {
  it('stores only the SHA-256 hash of the returned key', async () => {
    const app = await createApplication(db(), 'demo');

    const { rows } = await db().query<{ api_key_hash: Buffer; as_text: string }>(
      `SELECT api_key_hash, row_to_json(a)::text AS as_text FROM applications a WHERE id = $1`,
      [app.id],
    );
    expect(rows[0]!.api_key_hash.equals(hashApiKey(app.apiKey))).toBe(true);
    // The plain key appears nowhere in the stored row.
    expect(rows[0]!.as_text).not.toContain(app.apiKey);
  });

  it('lets the returned key be looked up by its hash (what auth will do)', async () => {
    const app = await createApplication(db(), 'demo');
    const { rows } = await db().query('SELECT id FROM applications WHERE api_key_hash = $1', [
      hashApiKey(app.apiKey),
    ]);
    expect(rows).toEqual([{ id: app.id }]);
  });

  it('gives every application a different key', async () => {
    const a = await createApplication(db(), 'a');
    const b = await createApplication(db(), 'b');
    expect(a.apiKey).not.toBe(b.apiKey);
  });

  it('trims and validates the name', async () => {
    expect((await createApplication(db(), '  spaced  ')).name).toBe('spaced');
    await expect(createApplication(db(), '   ')).rejects.toThrow();
  });
});

describe('create-app script', () => {
  it('creates the app, prints the key once on stdout, and never logs it', async () => {
    const result = await runCreateApp(['demo', 'app']);

    expect(result.code).toBe(0);
    const keys = result.stdout.match(KEY_RE) ?? [];
    expect(keys).toHaveLength(1); // printed exactly once
    const key = keys[0]!;

    // stdout also carries pino's JSON log line ("application created"); it must contain
    // the app id but not the key. Check every log line, and stderr.
    const logLines = result.stdout.split('\n').filter((l) => l.startsWith('{'));
    expect(logLines.some((l) => l.includes('application created'))).toBe(true);
    for (const line of logLines) expect(line).not.toContain(key);
    expect(result.stderr).not.toContain(key);

    const { rows } = await db().query('SELECT name FROM applications WHERE api_key_hash = $1', [
      hashApiKey(key),
    ]);
    expect(rows).toEqual([{ name: 'demo app' }]);
  }, 20_000);

  it('exits 1 with usage and creates nothing when the name is missing', async () => {
    const result = await runCreateApp([]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage: npm run create-app');
    const { rows } = await db().query('SELECT count(*)::int AS n FROM applications');
    expect(rows[0].n).toBe(0);
  }, 20_000);
});
