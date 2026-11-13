import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { registerAuth } from './auth.js';
import { registerErrorHandling } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';

export interface AppDeps {
  config: Config;
  /** Owned by the caller: buildApp never ends it (tests share one pool across apps). */
  pool: Db;
  /** A pino logger. Typed as Fastify's base logger so the app keeps the default instance type. */
  logger: FastifyBaseLogger;
}

/**
 * Build the HTTP app without listening. Tests drive it with `app.inject()`;
 * `start.ts` calls `listen()`.
 */
export function buildApp({ config, pool, logger }: AppDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // Hard cap on request bodies; larger ones are rejected with 413 while streaming,
    // before being buffered in full.
    bodyLimit: config.api.maxPayloadBytes,
    // Reject JSON containing "__proto__" (Fastify default) AND "constructor.prototype"
    // (default is to ignore) instead of silently stripping: prototype-pollution input
    // is never legitimate in a webhook payload.
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
  });

  // Must be registered before any child plugin so they inherit it.
  registerErrorHandling(app);
  // Declares the property's shape up front (Fastify requires decorations before use).
  app.decorateRequest('appId', '');

  registerHealthRoutes(app, pool);

  // Everything under /v1 requires an API key. The auth hook lives inside this
  // encapsulated plugin, so it does not apply to /healthz.
  app.register(
    async (v1) => {
      registerAuth(v1, pool);
      // Step 6+: endpoints and messages routes are registered here.
    },
    { prefix: '/v1' },
  );

  return app;
}
