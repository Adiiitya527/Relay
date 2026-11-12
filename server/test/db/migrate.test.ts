import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectForMigrations, migrate, MigrationError } from '../../src/db/migrate.js';
import { testDatabaseUrl } from '../helpers/test-db.js';

// The runner is tested in a scratch schema inside relay_test, so these tests never touch
// the real schema. `-c search_path=...` makes unqualified names (schema_migrations,
// widgets) resolve to the scratch schema for the runner's connection.
const SCHEMA = 'relay_mig_test';
const url = testDatabaseUrl();
const connection: pg.ClientConfig = { connectionString: url, options: `-c search_path=${SCHEMA}` };
const fixtures = (name: string) =>
  fileURLToPath(new URL(`../fixtures/migrations/${name}/`, import.meta.url));
const logger = { info: () => undefined };

let admin: pg.Client | undefined;
let tmpDirs: string[] = [];

/** The connected admin client (only assigned once connect() succeeded). */
function db(): pg.Client {
  if (!admin) throw new Error('admin client not connected (see the beforeAll error)');
  return admin;
}

/** Copy a fixture set to a temp dir so a test can edit/delete files safely. */
async function tempCopy(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-mig-'));
  tmpDirs.push(dir);
  await cp(fixtures(name), dir, { recursive: true });
  return dir;
}

async function appliedVersions(): Promise<string[]> {
  const { rows } = await db().query<{ version: string }>(
    `SELECT version FROM ${SCHEMA}.schema_migrations ORDER BY version`,
  );
  return rows.map((r) => r.version);
}

beforeAll(async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  admin = client; // only after a successful connect, so afterAll can't touch a dead client
});

beforeEach(async () => {
  await db().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db().query(`CREATE SCHEMA ${SCHEMA}`);
});

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

afterAll(async () => {
  if (!admin) return; // connect failed; the real error is already reported by beforeAll
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

describe('migrate', () => {
  it('applies pending migrations in order and records them', async () => {
    const result = await migrate({ connection, dir: fixtures('ok'), logger });

    expect(result).toEqual({
      applied: ['001_create_widgets.sql', '002_add_widget_color.sql'],
      alreadyApplied: 0,
    });
    expect(await appliedVersions()).toEqual(['001_create_widgets.sql', '002_add_widget_color.sql']);
    const { rows } = await db().query(`SELECT name, color FROM ${SCHEMA}.widgets`);
    expect(rows).toEqual([{ name: 'first', color: 'red' }]);
  });

  it('is a no-op on the second run', async () => {
    await migrate({ connection, dir: fixtures('ok'), logger });
    const second = await migrate({ connection, dir: fixtures('ok'), logger });
    expect(second).toEqual({ applied: [], alreadyApplied: 2 });
  });

  it('rolls back a failing file completely and keeps earlier files applied', async () => {
    const run = migrate({ connection, dir: fixtures('broken'), logger });

    const err = await run.then(
      () => expect.unreachable('broken migration should fail'),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).message).toContain('002_broken.sql');
    expect(((err as MigrationError).cause as { code?: string }).code).toBe('42601'); // syntax_error

    expect(await appliedVersions()).toEqual(['001_create_widgets.sql']);
    // gadgets was created by the first statement of 002 and must have been rolled back.
    const { rows } = await db().query(`SELECT to_regclass('${SCHEMA}.gadgets') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('fails when an applied migration was edited (checksum mismatch)', async () => {
    const dir = await tempCopy('ok');
    await migrate({ connection, dir, logger });

    await writeFile(
      path.join(dir, '001_create_widgets.sql'),
      (await readFile(path.join(dir, '001_create_widgets.sql'), 'utf8')) + '-- sneaky edit\n',
    );

    await expect(migrate({ connection, dir, logger })).rejects.toThrow(
      /checksum mismatch.*001_create_widgets\.sql/,
    );
  });

  it('treats CRLF and LF versions of a file as identical', async () => {
    const dir = await tempCopy('ok');
    await migrate({ connection, dir, logger });

    const file = path.join(dir, '001_create_widgets.sql');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/\n/g, '\r\n'));

    await expect(migrate({ connection, dir, logger })).resolves.toEqual({
      applied: [],
      alreadyApplied: 2,
    });
  });

  it('fails when an applied migration file has been deleted', async () => {
    const dir = await tempCopy('ok');
    await migrate({ connection, dir, logger });
    await rm(path.join(dir, '002_add_widget_color.sql'));

    await expect(migrate({ connection, dir, logger })).rejects.toThrow(/missing/);
  });

  it.each([
    ['1_too_short.sql', /invalid migration filename/],
    ['001_Bad-Name.sql', /invalid migration filename/],
  ])('rejects a badly named file %s', async (name, error) => {
    const dir = await tempCopy('ok');
    await writeFile(path.join(dir, name), 'SELECT 1;');
    await expect(migrate({ connection, dir, logger })).rejects.toThrow(error);
  });

  it('rejects two files with the same number', async () => {
    const dir = await tempCopy('ok');
    await writeFile(path.join(dir, '002_another.sql'), 'SELECT 1;');
    await expect(migrate({ connection, dir, logger })).rejects.toThrow(/duplicate migration number 002/);
  });

  it('serialises concurrent runners with the advisory lock (each file applied once)', async () => {
    // Without the lock both runners would see "nothing applied" and the second would
    // fail on CREATE TABLE widgets / the schema_migrations primary key.
    const results = await Promise.all([
      migrate({ connection, dir: fixtures('ok'), logger }),
      migrate({ connection, dir: fixtures('ok'), logger }),
    ]);

    const allApplied = results.flatMap((r) => r.applied).sort();
    expect(allApplied).toEqual(['001_create_widgets.sql', '002_add_widget_color.sql']);
    expect(await appliedVersions()).toHaveLength(2);
  });

  describe('A1: the runner connection has no timeouts', () => {
    it('disables statement/lock/idle timeouts even if the connection config sets one', async () => {
      const client = await connectForMigrations({ ...connection, statement_timeout: 100 });
      try {
        const settings = await client.query(
          `SELECT current_setting('statement_timeout') AS st,
                  current_setting('lock_timeout') AS lt,
                  current_setting('idle_in_transaction_session_timeout') AS it`,
        );
        expect(settings.rows[0]).toEqual({ st: '0', lt: '0', it: '0' });
      } finally {
        await client.end();
      }
    });

    it('runs a migration slower than an inherited statement_timeout', async () => {
      // 001_slow.sql sleeps 500 ms; a 100 ms statement_timeout would cancel it.
      const result = await migrate({
        connection: { ...connection, statement_timeout: 100 },
        dir: fixtures('slow'),
        logger,
      });
      expect(result.applied).toEqual(['001_slow.sql']);
    });
  });
});
