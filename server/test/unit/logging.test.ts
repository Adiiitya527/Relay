import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { MigrationError } from '../../src/db/migrate.js';
import { createLogger, scrubError } from '../../src/logging.js';
import { testConfig } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
const SECRET = 'SECRET-PAYLOAD-4242';

/** A real PostgreSQL CHECK violation whose `detail` quotes the failing row. */
async function checkViolation(): Promise<Error> {
  const client = await db().connect();
  try {
    await client.query('CREATE TEMP TABLE scrub_probe (v text CHECK (length(v) < 5))');
    return await client.query('INSERT INTO scrub_probe VALUES ($1)', [SECRET]).then(
      () => {
        throw new Error('expected a check violation');
      },
      (err: Error) => err,
    );
  } finally {
    await client.query('DROP TABLE IF EXISTS scrub_probe').catch(() => undefined);
    client.release();
  }
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, logger: createLogger('info', stream) };
}

describe('logging', () => {
  it('a real PostgreSQL error carries the failing row in `detail` (why scrubbing exists)', async () => {
    const err = await checkViolation();
    expect((err as Error & { detail?: string }).detail).toContain(SECRET);
  });

  it('logged errors keep message, code and constraint but drop detail / where / internalQuery', async () => {
    const err = await checkViolation();
    const { lines, logger } = capture();
    logger.error({ err }, 'record failed');
    const entry = JSON.parse(lines[0]!);
    expect(lines[0]).not.toContain(SECRET);
    expect(entry.err).toMatchObject({ type: 'DatabaseError', code: '23514', constraint: 'scrub_probe_v_check' });
    expect(entry.err.message).toContain('violates check constraint');
    expect(entry.err).not.toHaveProperty('detail');
  });

  it('also scrubs a wrapped cause (e.g. MigrationError → DatabaseError)', async () => {
    const err = new MigrationError('migration "002_x.sql" failed and was rolled back', { cause: await checkViolation() });
    const { lines, logger } = capture();
    logger.error({ err }, 'migration failed');
    expect(lines[0]).toContain('002_x.sql');
    expect(lines[0]).not.toContain(SECRET);
  });

  it('scrubError is pure and leaves other values alone', () => {
    expect(scrubError({ message: 'm', detail: 'd', where: 'w', internalQuery: 'q', cause: { detail: 'x', code: '1' } })).toEqual({
      message: 'm',
      cause: { code: '1' },
    });
    expect(scrubError('text')).toBe('text');
    expect(scrubError(null)).toBeNull();
  });

  it('redacts the Authorization header', () => {
    const { lines, logger } = capture();
    logger.info({ req: { headers: { authorization: 'Bearer rly_secret_key' } } }, 'request');
    expect(lines[0]).not.toContain('rly_secret_key');
    expect(lines[0]).toContain('[Redacted]');
  });

  it("the API's 500 handler logs through the same serializer (Fastify request loggers inherit it)", async () => {
    const err = await checkViolation();
    const { lines, logger } = capture();
    const app = buildApp({ config: testConfig(), pool: db(), logger });
    app.get('/boom', async () => {
      throw err;
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
      const logged = lines.find((l) => l.includes('unhandled error'));
      expect(logged).toBeDefined();
      expect(logged).toContain('23514');
      expect(logged).not.toContain(SECRET);
    } finally {
      await app.close();
    }
  });
});
