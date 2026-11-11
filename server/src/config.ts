import os from 'node:os';
import { z } from 'zod';

/**
 * Configuration comes only from environment variables (CLAUDE.md invariant 10) and is
 * validated once at startup. `loadConfig` is a pure function of the env object it is
 * given, so tests can call it with any env without touching `process.env`.
 *
 * Nothing here ever echoes a value back in an error: DATABASE_URL contains a password.
 */

// Booleans accept exactly "true" or "false". `z.coerce.boolean()` would be a security bug
// here: it uses JS truthiness, so the string "false" becomes `true` and
// RELAY_ALLOW_PRIVATE_NETWORKS=false would silently DISABLE SSRF protection.
const boolFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

// Env vars are strings; coerce to a number, then require an integer in range.
// Non-numeric input coerces to NaN, which `.int()` rejects.
const intVar = (defaultValue: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// or postgresql:// connection string');

const envSchema = z
  .object({
    DATABASE_URL: postgresUrl,
    TEST_DATABASE_URL: postgresUrl.optional(),
    DB_STATEMENT_TIMEOUT_MS: intVar(5_000, 100),
    DB_IDLE_IN_TX_TIMEOUT_MS: intVar(10_000, 100),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: intVar(3_000, 1, 65_535),
    MAX_PAYLOAD_BYTES: intVar(262_144, 1_024, 10 * 1024 * 1024),

    WORKER_ID: z.string().min(1).max(200).optional(),
    WORKER_CONCURRENCY: intVar(10, 1, 1_000),
    WORKER_POLL_INTERVAL_MS: intVar(500, 10),
    LEASE_MS: intVar(30_000, 1_000),
    SWEEP_INTERVAL_MS: intVar(5_000, 100),
    HTTP_TIMEOUT_MS: intVar(10_000, 100),

    RETRY_BASE_MS: intVar(2_000, 1),
    RETRY_CAP_MS: intVar(600_000, 1),
    MAX_ATTEMPTS: intVar(6, 1, 100),

    CIRCUIT_FAILURE_THRESHOLD: intVar(5, 1),
    CIRCUIT_COOLDOWN_MS: intVar(30_000, 100),

    RELAY_ALLOW_PRIVATE_NETWORKS: boolFlag.default(false),
    ALLOW_HTTP_ENDPOINTS: boolFlag.default(false),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  // Invariant 5: the lease must comfortably outlive one HTTP attempt, or a healthy slow
  // delivery is swept and sent twice. 2x the timeout + 5 s covers DNS/TLS/scheduling jitter.
  .refine((e) => e.LEASE_MS >= 2 * e.HTTP_TIMEOUT_MS + 5_000, {
    path: ['LEASE_MS'],
    message: 'must be >= 2 * HTTP_TIMEOUT_MS + 5000',
  })
  .refine((e) => e.RETRY_CAP_MS >= e.RETRY_BASE_MS, {
    path: ['RETRY_CAP_MS'],
    message: 'must be >= RETRY_BASE_MS',
  });

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string | undefined;
  db: { statementTimeoutMs: number; idleInTxTimeoutMs: number };
  api: { host: string; port: number; maxPayloadBytes: number };
  worker: {
    id: string;
    concurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
    sweepIntervalMs: number;
    httpTimeoutMs: number;
  };
  retry: { baseMs: number; capMs: number; maxAttempts: number };
  circuit: { failureThreshold: number; cooldownMs: number };
  security: { allowPrivateNetworks: boolean; allowHttpEndpoints: boolean };
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  // Treat empty strings as "not set" so `KEY=` lines in .env fall back to defaults
  // (otherwise `z.coerce.number()` would turn "" into 0).
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    // Only the variable name and the rule are reported, never the received value.
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const e = result.data;

  return {
    databaseUrl: e.DATABASE_URL,
    testDatabaseUrl: e.TEST_DATABASE_URL,
    db: {
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      idleInTxTimeoutMs: e.DB_IDLE_IN_TX_TIMEOUT_MS,
    },
    api: { host: e.API_HOST, port: e.API_PORT, maxPayloadBytes: e.MAX_PAYLOAD_BYTES },
    worker: {
      id: e.WORKER_ID ?? `${os.hostname()}-${process.pid}`,
      concurrency: e.WORKER_CONCURRENCY,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      leaseMs: e.LEASE_MS,
      sweepIntervalMs: e.SWEEP_INTERVAL_MS,
      httpTimeoutMs: e.HTTP_TIMEOUT_MS,
    },
    retry: { baseMs: e.RETRY_BASE_MS, capMs: e.RETRY_CAP_MS, maxAttempts: e.MAX_ATTEMPTS },
    circuit: {
      failureThreshold: e.CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: e.CIRCUIT_COOLDOWN_MS,
    },
    security: {
      allowPrivateNetworks: e.RELAY_ALLOW_PRIVATE_NETWORKS,
      allowHttpEndpoints: e.ALLOW_HTTP_ENDPOINTS,
    },
    logLevel: e.LOG_LEVEL,
  };
}
