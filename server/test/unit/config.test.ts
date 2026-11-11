import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

// A fake URL with a recognisable "password" so we can assert it never leaks into errors.
const DB = 'postgres://relay:s3cret-pw@localhost:5432/relay';
const base = { DATABASE_URL: DB };

/** Run loadConfig and return the ConfigError (fails the test if it does not throw one). */
function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadConfig to throw ConfigError');
}

describe('loadConfig', () => {
  it('applies documented defaults when only DATABASE_URL is set', () => {
    const c = loadConfig(base);
    expect(c.databaseUrl).toBe(DB);
    expect(c.testDatabaseUrl).toBeUndefined();
    expect(c.db).toEqual({ statementTimeoutMs: 5000, idleInTxTimeoutMs: 10000 });
    expect(c.api).toEqual({ host: '0.0.0.0', port: 3000, maxPayloadBytes: 262144 });
    expect(c.worker).toMatchObject({
      concurrency: 10,
      pollIntervalMs: 500,
      leaseMs: 30000,
      sweepIntervalMs: 5000,
      httpTimeoutMs: 10000,
    });
    expect(c.retry).toEqual({ baseMs: 2000, capMs: 600000, maxAttempts: 6 });
    expect(c.circuit).toEqual({ failureThreshold: 5, cooldownMs: 30000 });
    expect(c.security).toEqual({ allowPrivateNetworks: false, allowHttpEndpoints: false });
    expect(c.logLevel).toBe('info');
  });

  it('requires DATABASE_URL', () => {
    expect(configError({}).problems).toEqual([expect.stringMatching(/^DATABASE_URL:/)]);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    const err = configError({ DATABASE_URL: 'mysql://relay:s3cret-pw@localhost/relay' });
    expect(err.problems[0]).toMatch(/^DATABASE_URL:/);
  });

  it('never includes received values (secrets) in error messages', () => {
    const err = configError({
      DATABASE_URL: 'mysql://relay:s3cret-pw@localhost/relay',
      API_PORT: 'not-a-port',
    });
    expect(err.message).not.toContain('s3cret-pw');
    expect(err.message).not.toContain('not-a-port');
  });

  describe('boolean flags', () => {
    it('parses "false" as false (z.coerce.boolean would make it true)', () => {
      const c = loadConfig({ ...base, RELAY_ALLOW_PRIVATE_NETWORKS: 'false', ALLOW_HTTP_ENDPOINTS: 'false' });
      expect(c.security).toEqual({ allowPrivateNetworks: false, allowHttpEndpoints: false });
    });

    it('parses "true" as true', () => {
      const c = loadConfig({ ...base, RELAY_ALLOW_PRIVATE_NETWORKS: 'true', ALLOW_HTTP_ENDPOINTS: 'true' });
      expect(c.security).toEqual({ allowPrivateNetworks: true, allowHttpEndpoints: true });
    });

    it.each(['1', '0', 'yes', 'TRUE', 'False', 'on'])('rejects ambiguous value %j', (value) => {
      const err = configError({ ...base, RELAY_ALLOW_PRIVATE_NETWORKS: value });
      expect(err.problems[0]).toMatch(/^RELAY_ALLOW_PRIVATE_NETWORKS:/);
    });
  });

  describe('integers', () => {
    it('coerces numeric strings', () => {
      expect(loadConfig({ ...base, API_PORT: '8080' }).api.port).toBe(8080);
    });

    it.each(['abc', '0', '70000', '3000.5', '-1'])('rejects API_PORT=%j', (value) => {
      expect(configError({ ...base, API_PORT: value }).problems[0]).toMatch(/^API_PORT:/);
    });

    it('treats an empty string as unset and falls back to the default', () => {
      expect(loadConfig({ ...base, API_PORT: '', WORKER_ID: '' }).api.port).toBe(3000);
    });
  });

  describe('lease vs HTTP timeout (invariant 5)', () => {
    it('accepts LEASE_MS exactly 2 * HTTP_TIMEOUT_MS + 5000', () => {
      const c = loadConfig({ ...base, HTTP_TIMEOUT_MS: '10000', LEASE_MS: '25000' });
      expect(c.worker.leaseMs).toBe(25000);
    });

    it('rejects LEASE_MS below 2 * HTTP_TIMEOUT_MS + 5000', () => {
      const err = configError({ ...base, HTTP_TIMEOUT_MS: '10000', LEASE_MS: '24999' });
      expect(err.problems).toEqual(['LEASE_MS: must be >= 2 * HTTP_TIMEOUT_MS + 5000']);
    });

    it('rejects a lease shortened only by raising the timeout', () => {
      const err = configError({ ...base, HTTP_TIMEOUT_MS: '20000' }); // default lease 30000 < 45000
      expect(err.problems[0]).toMatch(/^LEASE_MS:/);
    });
  });

  it('rejects RETRY_CAP_MS below RETRY_BASE_MS', () => {
    const err = configError({ ...base, RETRY_BASE_MS: '5000', RETRY_CAP_MS: '1000' });
    expect(err.problems).toEqual(['RETRY_CAP_MS: must be >= RETRY_BASE_MS']);
  });

  it('defaults WORKER_ID to <hostname>-<pid> and honours an explicit value', () => {
    expect(loadConfig(base).worker.id).toBe(`${os.hostname()}-${process.pid}`);
    expect(loadConfig({ ...base, WORKER_ID: 'worker-a' }).worker.id).toBe('worker-a');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(configError({ ...base, LOG_LEVEL: 'verbose' }).problems[0]).toMatch(/^LOG_LEVEL:/);
  });

  it('reports every problem at once, not just the first', () => {
    const err = configError({ API_PORT: 'x', MAX_ATTEMPTS: '0' });
    const keys = err.problems.map((p) => p.split(':')[0]);
    expect(keys).toEqual(expect.arrayContaining(['DATABASE_URL', 'API_PORT', 'MAX_ATTEMPTS']));
  });

  it('ignores unrelated environment variables', () => {
    expect(() => loadConfig({ ...base, PATH: '/usr/bin', SOME_OTHER_TOOL: 'x' })).not.toThrow();
  });
});
