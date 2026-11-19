import type { Db } from '../db/pool.js';

// ---------------------------------------------------------------------------------------
// GET /metrics: queue health in the Prometheus text exposition format (version 0.0.4).
//
// Everything is read from Postgres at scrape time (invariant 1: no other state store, so
// no in-process counters that would differ between API replicas and reset on restart).
//
// Deliberately aggregate-only: no app_id or endpoint_id labels. That keeps the endpoint
// from leaking one tenant's data to anyone who can reach it, and keeps label cardinality
// fixed however many tenants and endpoints exist.
//
// Every number must stay cheap on a large table: only statuses with a partial index are
// counted (pending: deliveries_claim_idx, in_flight: deliveries_lease_idx, dead:
// deliveries_dead_idx). `succeeded` is the unbounded history and has no such index, so it
// is not counted here; counting it would be a full scan on every scrape.
// ---------------------------------------------------------------------------------------

export interface MetricsSnapshot {
  deliveries: { pending: number; in_flight: number; dead: number };
  /** Pending AND due (next_attempt_at <= now()): waiting for a worker, or held by an open circuit / disabled endpoint. */
  due: number;
  /** now() - the oldest due delivery's next_attempt_at, in seconds; 0 when nothing is due. */
  oldestDueAgeSeconds: number;
  endpointsByCircuit: { closed: number; open: number; half_open: number };
  endpointsDisabled: number;
}

export async function readMetrics(db: Db): Promise<MetricsSnapshot> {
  // One round trip of scalar subqueries; all ages use the DB clock (invariant 7).
  // count(*) is bigint, which node-postgres returns as a string, so cast to float8:
  // Prometheus values are floats anyway, and float8 is exact up to 2^53.
  const { rows } = await db.query<{
    pending: number;
    in_flight: number;
    dead: number;
    due: number;
    oldest_due_age: number | null;
    closed: number;
    open: number;
    half_open: number;
    disabled: number;
  }>(
    `SELECT
       (SELECT count(*) FROM deliveries WHERE status = 'pending')::float8   AS pending,
       (SELECT count(*) FROM deliveries WHERE status = 'in_flight')::float8 AS in_flight,
       (SELECT count(*) FROM deliveries WHERE status = 'dead')::float8      AS dead,
       (SELECT count(*) FROM deliveries
         WHERE status = 'pending' AND next_attempt_at <= now())::float8     AS due,
       (SELECT extract(epoch FROM now() - min(next_attempt_at))::float8
          FROM deliveries
         WHERE status = 'pending' AND next_attempt_at <= now())             AS oldest_due_age,
       e.closed, e.open, e.half_open, e.disabled
     FROM (SELECT count(*) FILTER (WHERE circuit_state = 'closed')::float8    AS closed,
                  count(*) FILTER (WHERE circuit_state = 'open')::float8      AS open,
                  count(*) FILTER (WHERE circuit_state = 'half_open')::float8 AS half_open,
                  count(*) FILTER (WHERE disabled)::float8                    AS disabled
             FROM endpoints) e`,
  );
  const r = rows[0]!;
  return {
    deliveries: { pending: r.pending, in_flight: r.in_flight, dead: r.dead },
    due: r.due,
    oldestDueAgeSeconds: r.oldest_due_age ?? 0,
    endpointsByCircuit: { closed: r.closed, open: r.open, half_open: r.half_open },
    endpointsDisabled: r.disabled,
  };
}

/** Pure: snapshot → Prometheus text format. Label values here are constants, never user input. */
export function renderMetrics(s: MetricsSnapshot): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, samples: [labels: string, value: number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${formatValue(value)}`);
  };

  gauge('relay_deliveries', 'Deliveries by status (succeeded is not counted: unbounded history).', [
    ['{status="pending"}', s.deliveries.pending],
    ['{status="in_flight"}', s.deliveries.in_flight],
    ['{status="dead"}', s.deliveries.dead],
  ]);
  gauge('relay_deliveries_due', 'Pending deliveries whose next attempt is due now.', [['', s.due]]);
  gauge(
    'relay_oldest_due_delivery_age_seconds',
    'How long the oldest due delivery has been waiting (queue lag); 0 when none is due.',
    [['', s.oldestDueAgeSeconds]],
  );
  gauge('relay_endpoints', 'Endpoints by circuit breaker state.', [
    ['{circuit_state="closed"}', s.endpointsByCircuit.closed],
    ['{circuit_state="open"}', s.endpointsByCircuit.open],
    ['{circuit_state="half_open"}', s.endpointsByCircuit.half_open],
  ]);
  gauge('relay_endpoints_disabled', 'Endpoints disabled (paused) by their owner.', [['', s.endpointsDisabled]]);
  return `${lines.join('\n')}\n`;
}

/** Prometheus accepts Go float syntax; integers print plainly, fractions with ms precision. */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : value < 0 ? '-Inf' : 'NaN';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
