import type { Db } from '../db/pool.js';

/**
 * Deliveries as the API shows them. Lease fields (locked_until, lease_token, locked_by)
 * are worker internals and never exposed.
 */
export interface DeliveryView {
  id: string;
  message_id: string;
  endpoint_id: string;
  status: 'pending' | 'in_flight' | 'succeeded' | 'dead';
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

// A constant column list (never user input).
export const DELIVERY_COLUMNS = `id, message_id, endpoint_id, status, attempt_count,
  next_attempt_at, last_error, created_at, updated_at, completed_at`;

// T5 (day1.md §3): back to the queue, due now, with a fresh attempt budget. History stays
// in delivery_attempts (keyed by lease_token, so new attempt rows never collide with old
// ones even though attempt_number restarts at 1).
const REPLAY_SET = `status = 'pending', attempt_count = 0, next_attempt_at = now(),
  completed_at = NULL, last_error = NULL, updated_at = now()`;

export type ReplayOutcome =
  | { kind: 'replayed'; delivery: DeliveryView }
  | { kind: 'not_found' }
  | { kind: 'not_replayable'; status: string };

/**
 * Replay one delivery. Only `dead` or `succeeded` deliveries can be replayed: a pending
 * or in-flight one is still owned by the queue, and resetting it would fight the worker
 * holding its lease.
 *
 * The status condition is in the UPDATE's WHERE, so the check and the change are one
 * atomic step: two concurrent replays of the same delivery → exactly one succeeds (the
 * other waits for the row lock, re-checks the WHERE, sees `pending`, matches 0 rows).
 * Only on 0 rows do we look again, to tell "missing / other tenant" (404) from "not
 * replayable right now" (409).
 *
 * Disabled endpoints and open circuits need no special case: the replayed row is simply
 * pending, and the claim skips it until the endpoint is enabled / the probe succeeds.
 */
export async function replayDelivery(db: Db, appId: string, id: string): Promise<ReplayOutcome> {
  const { rows } = await db.query<DeliveryView>(
    `UPDATE deliveries SET ${REPLAY_SET}
      WHERE id = $1 AND app_id = $2 AND status IN ('dead', 'succeeded')
     RETURNING ${DELIVERY_COLUMNS}`,
    [id, appId],
  );
  if (rows[0]) return { kind: 'replayed', delivery: rows[0] };

  const current = await db.query<{ status: string }>(
    'SELECT status FROM deliveries WHERE id = $1 AND app_id = $2',
    [id, appId],
  );
  const status = current.rows[0]?.status;
  return status === undefined ? { kind: 'not_found' } : { kind: 'not_replayable', status };
}

/**
 * Replay every dead delivery of one endpoint (the dead-letter queue "retry all" button).
 * One statement: the endpoint lookup (tenant-scoped) and the update. `endpoint_found`
 * distinguishes "unknown endpoint" (404) from "nothing was dead" (0 replayed).
 * Uses the partial index deliveries_dead_idx (endpoint_id, updated_at) WHERE status = 'dead'.
 */
export async function replayDeadForEndpoint(
  db: Db,
  appId: string,
  endpointId: string,
): Promise<{ found: boolean; replayed: number }> {
  const { rows } = await db.query<{ found: boolean; replayed: number }>(
    `WITH ep AS (
       SELECT id FROM endpoints WHERE id = $1 AND app_id = $2
     ), upd AS (
       UPDATE deliveries d SET ${REPLAY_SET}
         FROM ep
        WHERE d.endpoint_id = ep.id AND d.app_id = $2 AND d.status = 'dead'
       RETURNING d.id
     )
     SELECT EXISTS (SELECT 1 FROM ep) AS found, (SELECT count(*) FROM upd)::int AS replayed`,
    [endpointId, appId],
  );
  return rows[0]!;
}
