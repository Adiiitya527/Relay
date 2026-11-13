import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerToken, registerAuth } from '../../src/api/auth.js';
import { createApplication } from '../../src/applications/repo.js';
import { generateApiKey } from '../../src/auth/api-keys.js';
import type { Db } from '../../src/db/pool.js';
import { buildTestApp, unreachablePool } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';

const db = useTestDb();
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * The real app plus a protected probe route. No /v1 routes exist until step 6, so the
 * probe mounts the REAL registerAuth in its own scope, exactly as buildApp does for /v1.
 */
async function appWithProbe(authDb: Db = db()): Promise<FastifyInstance> {
  const a = buildTestApp(db());
  a.register(
    async (scope) => {
      registerAuth(scope, authDb);
      scope.get('/whoami', async (req) => ({ appId: req.appId }));
    },
    { prefix: '/probe' },
  );
  await a.ready();
  app = a;
  return a;
}

const whoami = (a: FastifyInstance, authorization?: string) =>
  a.inject({
    method: 'GET',
    url: '/probe/whoami',
    headers: authorization === undefined ? {} : { authorization },
  });

describe('API key auth', () => {
  it('a valid key → request.appId is the owning application', async () => {
    const created = await createApplication(db(), 'demo');
    const a = await appWithProbe();

    const res = await whoami(a, `Bearer ${created.apiKey}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ appId: created.id });
  });

  it('the scheme name is case-insensitive', async () => {
    const created = await createApplication(db(), 'demo');
    const a = await appWithProbe();
    expect((await whoami(a, `bearer ${created.apiKey}`)).statusCode).toBe(200);
  });

  it('each key resolves to its own application (no cross-tenant mix-up)', async () => {
    const one = await createApplication(db(), 'one');
    const two = await createApplication(db(), 'two');
    const a = await appWithProbe();
    expect((await whoami(a, `Bearer ${one.apiKey}`)).json()).toEqual({ appId: one.id });
    expect((await whoami(a, `Bearer ${two.apiKey}`)).json()).toEqual({ appId: two.id });
  });

  it('missing, malformed and unknown keys get the IDENTICAL 401', async () => {
    await createApplication(db(), 'demo'); // a real key exists; the unknown one is different
    const a = await appWithProbe();

    const cases = {
      missing: undefined,
      'wrong scheme': `Basic ${Buffer.from('u:p').toString('base64')}`,
      'scheme only': 'Bearer',
      'bad format': 'Bearer rly_tooshort',
      'two tokens': `Bearer ${generateApiKey()} extra`,
      'unknown key': `Bearer ${generateApiKey()}`,
    };
    for (const [label, header] of Object.entries(cases)) {
      const res = await whoami(a, header);
      expect(res.statusCode, label).toBe(401);
      expect(res.json(), label).toEqual({
        error: { code: 'unauthorized', message: 'Missing or invalid API key' },
      });
      expect(res.headers['www-authenticate'], label).toBe('Bearer');
    }
  });

  it('a revoked key (row gone) stops working immediately', async () => {
    const created = await createApplication(db(), 'demo');
    const a = await appWithProbe();
    expect((await whoami(a, `Bearer ${created.apiKey}`)).statusCode).toBe(200);
    await db().query('DELETE FROM applications WHERE id = $1', [created.id]);
    expect((await whoami(a, `Bearer ${created.apiKey}`)).statusCode).toBe(401);
  });

  it('database down during auth → 503, not a misleading 401', async () => {
    const down = unreachablePool();
    try {
      const a = await appWithProbe(down);
      const res = await whoami(a, `Bearer ${generateApiKey()}`);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('database_unavailable');
    } finally {
      await down.end();
    }
  });

  it('/healthz needs no API key (auth is scoped to the /v1 plugin)', async () => {
    const a = buildTestApp(db());
    await a.ready();
    app = a;
    expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER   abc', 'abc'],
  ])('%j → %j', (header, token) => expect(bearerToken(header)).toBe(token));

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'Bearerabc', ' Bearer abc'])(
    'rejects %j',
    (header) => expect(bearerToken(header)).toBeUndefined(),
  );
});
