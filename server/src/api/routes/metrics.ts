import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/pool.js';
import { readMetrics, renderMetrics } from '../../metrics/metrics.js';

/**
 * GET /metrics: unauthenticated, like /healthz, because Prometheus scrapers usually
 * don't send API keys. It exposes only aggregate counts across all tenants (no ids, no
 * labels from user input). In production, restrict it at the network level (it is an
 * operator endpoint, not a customer one). If Postgres is down the central error handler
 * answers 503, which Prometheus records as a failed scrape.
 */
export function registerMetricsRoutes(app: FastifyInstance, db: Db): void {
  app.get('/metrics', async (_request, reply) => {
    const body = renderMetrics(await readMetrics(db));
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(body);
  });
}
