import { describe, expect, it, vi } from 'vitest';
import { startWorker } from '../../src/worker/start.js';
import { silentLogger, testConfig } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();

/** Sessions the worker pool (application_name 'relay-worker') holds on the server. */
async function workerSessions(): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE application_name = 'relay-worker' AND datname = current_database()`,
  );
  return rows[0]!.n;
}

describe('startWorker / stop', () => {
  it('connects, runs, then stops loops and ends its pool (stop is idempotent)', async () => {
    const worker = await startWorker(testConfig({ SWEEP_INTERVAL_MS: '100' }), silentLogger);
    try {
      expect(await workerSessions()).toBeGreaterThanOrEqual(1);
    } finally {
      // SIGINT + SIGTERM can both arrive: stop must be idempotent.
      await Promise.all([worker.stop(), worker.stop()]);
    }
    await vi.waitFor(async () => expect(await workerSessions()).toBe(0), { timeout: 3_000 });
  });

  it('fails fast when the database is unreachable (and leaves nothing running)', async () => {
    const config = testConfig({ DATABASE_URL: 'postgresql://relay@127.0.0.1:1/relay_test' });
    await expect(startWorker(config, silentLogger)).rejects.toThrow();
  });
});
