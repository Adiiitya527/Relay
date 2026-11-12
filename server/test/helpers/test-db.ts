/**
 * Safety guard for every test that touches PostgreSQL.
 *
 * Tests TRUNCATE tables and DROP scratch schemas, so they must never run against the
 * development database. We refuse unless TEST_DATABASE_URL points at a database whose
 * name ends in `_test` and is not the same database as DATABASE_URL.
 * Error messages never include the URLs (they contain the password).
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Create .env from .env.example (or set it in the environment).',
    );
  }

  const name = databaseName(url);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run tests: TEST_DATABASE_URL database "${name}" must end in "_test".`);
  }

  const devUrl = process.env.DATABASE_URL;
  if (devUrl && sameDatabase(devUrl, url)) {
    throw new Error('Refusing to run tests: TEST_DATABASE_URL points at the same database as DATABASE_URL.');
  }
  return url;
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function sameDatabase(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return (
    ua.hostname === ub.hostname &&
    (ua.port || '5432') === (ub.port || '5432') &&
    databaseName(a) === databaseName(b)
  );
}
