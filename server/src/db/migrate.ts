import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * Minimal SQL migration runner.
 *
 * - Files named `NNN_description.sql` in one directory, applied in numeric order.
 * - Each file runs in its own transaction together with its `schema_migrations` row,
 *   so a file is either fully applied and recorded, or not at all.
 * - A session-level advisory lock serialises concurrent runners (two deploys, two
 *   developers, a test racing a script).
 * - A SHA-256 checksum per file detects edits to already-applied migrations.
 *
 * Files must not contain their own BEGIN/COMMIT, and statements that cannot run inside
 * a transaction (e.g. CREATE INDEX CONCURRENTLY) are not supported.
 */

export interface MigrationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface MigrateOptions {
  /** Connection settings. Tests pass `options: '-c search_path=<scratch schema>'`. */
  connection: pg.ClientConfig;
  /** Directory containing NNN_*.sql files. */
  dir: string;
  logger: MigrationLogger;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** Arbitrary constant identifying "the relay migration lock" among advisory locks. */
const MIGRATION_LOCK_KEY = '7242026001';

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  version: string; // full filename, e.g. '001_init.sql'
  sql: string; // LF-normalised content
  checksum: string;
}

/** LF-normalise so a CRLF checkout on Windows hashes the same as LF on Linux CI. */
export function normaliseSql(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(normaliseSql(sql), 'utf8').digest('hex');
}

async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seenNumbers = new Set<string>();
  const files: MigrationFile[] = [];

  for (const name of entries) {
    const match = FILE_PATTERN.exec(name);
    if (!match) {
      throw new MigrationError(`invalid migration filename "${name}" (expected NNN_lower_snake.sql)`);
    }
    const num = match[1] as string; // group 1 always exists when the pattern matches
    if (seenNumbers.has(num)) {
      throw new MigrationError(`duplicate migration number ${num} ("${name}")`);
    }
    seenNumbers.add(num);

    const sql = normaliseSql(await readFile(path.join(dir, name), 'utf8'));
    files.push({ version: name, sql, checksum: checksumOf(sql) });
  }
  return files;
}

/**
 * Open the connection the runner uses. Exported so a test can assert the A1 guarantee.
 *
 * A1: migrations must never be cancelled by a timeout. We don't just "not set"
 * statement_timeout; we explicitly SET it (and lock/idle timeouts) to 0, because a
 * default could also come from `ALTER ROLE/DATABASE ... SET statement_timeout` or from
 * the connection config. Waiting on pg_advisory_lock while another runner works is a
 * normal, possibly long, wait and must not be killed either.
 */
export async function connectForMigrations(connection: pg.ClientConfig): Promise<pg.Client> {
  const client = new pg.Client({ ...connection, application_name: 'relay-migrate' });
  await client.connect();
  try {
    await client.query(
      'SET statement_timeout = 0; SET lock_timeout = 0; SET idle_in_transaction_session_timeout = 0',
    );
  } catch (err) {
    await client.end();
    throw err;
  }
  return client;
}

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const files = await readMigrationFiles(opts.dir);
  const client = await connectForMigrations(opts.connection);

  try {
    // Session-level lock: held until we unlock or the connection closes. If this process
    // crashes, Postgres ends the session and the lock is released automatically.
    // A second runner blocks here until the first is done, then sees its work as applied.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      return await applyPending(client, files, opts.logger);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function applyPending(
  client: pg.Client,
  files: MigrationFile[],
  logger: MigrationLogger,
): Promise<MigrateResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  // Read the applied set only AFTER taking the lock, so it can't be stale.
  const { rows } = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  // Every recorded migration must still exist, unchanged, on disk.
  const onDisk = new Map(files.map((f) => [f.version, f]));
  for (const [version, checksum] of applied) {
    const file = onDisk.get(version);
    if (!file) {
      throw new MigrationError(`applied migration "${version}" is missing from the migrations directory`);
    }
    if (file.checksum !== checksum) {
      throw new MigrationError(
        `checksum mismatch for applied migration "${version}": it was edited after being applied. ` +
          'Never edit an applied migration; add a new one.',
      );
    }
  }

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file.version)) continue;

    await client.query('BEGIN');
    try {
      // No parameters → simple query protocol, which allows many statements per file.
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        file.version,
        file.checksum,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      // If the connection itself died, ROLLBACK fails too; keep the original error.
      await client.query('ROLLBACK').catch(() => undefined);
      throw new MigrationError(`migration "${file.version}" failed and was rolled back`, {
        cause: err,
      });
    }
    logger.info({ version: file.version }, 'applied migration');
    newlyApplied.push(file.version);
  }

  return { applied: newlyApplied, alreadyApplied: applied.size };
}
