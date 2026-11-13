import { describe, expect, it, vi } from 'vitest';
import { startApi } from '../../src/api/start.js';
import { silentLogger, testConfig } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();

/** Sessions the API pool (application_name 'relay-api') currently holds on the server. */
async function apiSessions(): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE application_name = 'relay-api' AND datname = current_database()`,
  );
  return rows[0]!.n;
}

describe('startApi / stop', () => {
  it('listens on a real port, serves /healthz, then stops server and pool', async () => {
    const base = testConfig();
    // Port 0 = any free port; 127.0.0.1 so the test never listens on external interfaces.
    const config = { ...base, api: { ...base.api, host: '127.0.0.1', port: 0 } };
    const api = await startApi(config, silentLogger);
    const url = `http://127.0.0.1:${api.address.port}/healthz`;

    try {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(await apiSessions()).toBe(1);
    } finally {
      // Called twice on purpose: SIGINT + SIGTERM can both arrive; stop must be idempotent.
      await Promise.all([api.stop(), api.stop()]);
    }

    await expect(fetch(url)).rejects.toThrow(); // port closed
    // Pool ended: its server sessions disappear (the backend exits just after the socket closes).
    await vi.waitFor(async () => expect(await apiSessions()).toBe(0), { timeout: 3_000 });
  });
});
