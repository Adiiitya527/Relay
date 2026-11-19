import { encodeCursor, sqlMicrosOf, sqlTimestampOfMicros, type Cursor } from '../db/cursor.js';
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

// ---------------------------------------------------------------------------------------
// Reads: list (keyset-paginated), one delivery, attempt timeline
// ---------------------------------------------------------------------------------------

/** A delivery with its message's event type (what the dashboard lists). */
export interface DeliveryListItem extends DeliveryView {
  event_type: string;
}

export interface DeliveryPage {
  data: DeliveryListItem[];
  /** Pass back as ?cursor= for the next (older) page; null on the last page. */
  next_cursor: string | null;
}

export interface DeliveryFilter {
  status: DeliveryView['status'] | undefined;
  endpointId: string | undefined;
  limit: number;
  cursor: Cursor | undefined;
}

const ITEM_COLUMNS = `d.id, d.message_id, d.endpoint_id, m.event_type, d.status, d.attempt_count,
  d.next_attempt_at, d.last_error, d.created_at, d.updated_at, d.completed_at`;

/**
 * Newest first, optionally filtered by status and/or endpoint. Same keyset scheme as the
 * message list: ORDER BY (created_at, id) DESC with a microsecond cursor (D33), so pages
 * never skip or repeat rows and cost O(limit) at any depth.
 *
 * Optional filters are written `($n IS NULL OR column = $n)` in ONE static statement
 * (8 combinations would otherwise need 8 statements). That is index-friendly here because
 * node-postgres sends unnamed prepared statements, which Postgres plans with the actual
 * parameter values: the `NULL OR …` branches fold away before planning. Every query is
 * scoped by app_id; filtering by another tenant's endpoint id simply returns nothing.
 */
export async function listDeliveries(db: Db, appId: string, f: DeliveryFilter): Promise<DeliveryPage> {
  const { rows } = await db.query<DeliveryListItem & { micros: string }>(
    `SELECT ${ITEM_COLUMNS}, ${sqlMicrosOf('d.created_at')} AS micros
       FROM deliveries d
       JOIN messages m ON m.id = d.message_id
      WHERE d.app_id = $1
        AND ($2::text IS NULL OR d.status = $2)
        AND ($3::uuid IS NULL OR d.endpoint_id = $3)
        AND ($4::bigint IS NULL OR (d.created_at, d.id) < (${sqlTimestampOfMicros('$4')}, $5::uuid))
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $6`,
    [appId, f.status ?? null, f.endpointId ?? null, f.cursor?.micros ?? null, f.cursor?.id ?? null, f.limit + 1],
  );
  const hasMore = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    data: page.map(({ micros: _micros, ...item }) => item),
    next_cursor: hasMore && last ? encodeCursor({ micros: last.micros, id: last.id }) : null,
  };
}

export async function getDelivery(db: Db, appId: string, id: string): Promise<DeliveryListItem | undefined> {
  const { rows } = await db.query<DeliveryListItem>(
    `SELECT ${ITEM_COLUMNS}
       FROM deliveries d
       JOIN messages m ON m.id = d.message_id
      WHERE d.id = $1 AND d.app_id = $2`,
    [id, appId],
  );
  return rows[0];
}

export interface AttemptView {
  /** bigint identity, as a string (JS numbers can't hold every int8). */
  id: string;
  attempt_number: number;
  worker_id: string;
  recorded_at: Date;
  duration_ms: number | null;
  response_status: number | null;
  response_excerpt: string | null;
  error_kind: string | null;
  error_message: string | null;
}

/**
 * The attempt timeline, oldest first (insertion order = id order). Includes attempts from
 * before a replay. lease_token is internal and not exposed. Scoped via the delivery's
 * app_id; the route checks the delivery exists first so "no attempts yet" ≠ 404.
 */
export async function listAttempts(db: Db, appId: string, deliveryId: string): Promise<AttemptView[]> {
  const { rows } = await db.query<AttemptView>(
    `SELECT a.id::text AS id, a.attempt_number, a.worker_id, a.recorded_at, a.duration_ms,
            a.response_status, a.response_excerpt, a.error_kind, a.error_message
       FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id
      WHERE a.delivery_id = $1 AND d.app_id = $2
      ORDER BY a.id`,
    [deliveryId, appId],
  );
  return rows;
}
