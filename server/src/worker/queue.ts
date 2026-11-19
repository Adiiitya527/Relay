import type { Db } from '../db/pool.js';

/**
 * The queue: the SQL that moves deliveries through their states (day1.md §3, T1–T4).
 * The `deliveries` table IS the queue (invariant 1); these statements are the only code
 * that takes rows out of `pending` or `in_flight`.
 */

// ---------------------------------------------------------------------------------------
// T1 — claim
// ---------------------------------------------------------------------------------------

export interface ClaimedDelivery {
  id: string;
  message_id: string;
  endpoint_id: string;
  /** Already incremented: this claim's attempt number (1 = first try). */
  attempt_count: number;
  /** Fencing token for this claim. The result write must present it (invariant 4). */
  lease_token: string;
  /** Exactly `payload::text`: the bytes to sign and send (D21, D45). */
  body: string;
  url: string;
  /** Endpoint signing secret. Never log a ClaimedDelivery as a whole. */
  secret: string;
}

export interface ClaimOptions {
  /** Free concurrency slots (invariant 5): every claimed row starts its request at once. */
  limit: number;
  leaseMs: number;
  workerId: string;
}

/**
 * Atomically take up to `limit` due deliveries and lease them to this worker.
 *
 * One statement = one short implicit transaction (invariant 3): the row locks below are
 * released as soon as it commits, long before any HTTP request starts. From then on the
 * LEASE (status in_flight + locked_until + lease_token) is what keeps other workers away.
 *
 *  (a) `due` CTE: find candidates via the partial index deliveries_claim_idx
 *      (next_attempt_at WHERE status = 'pending'). `now()` is the DB clock (invariant 7).
 *  (b) Paused rows are skipped and keep their attempts (invariant 9): disabled endpoints,
 *      and open circuits still cooling down. (Single-probe half-open: Day 3.)
 *  (c) FOR UPDATE OF d SKIP LOCKED: row-lock the chosen deliveries; rows another worker's
 *      claim has locked right now are SKIPPED instead of waited for, so concurrent
 *      workers get disjoint sets without blocking each other. After acquiring a lock,
 *      Postgres re-checks the WHERE on the row's newest version, so a row that another
 *      worker has just moved to in_flight is dropped. `OF d`: lock only delivery rows;
 *      locking the joined endpoint row would make other workers skip every delivery of
 *      that endpoint.
 *  (d) The UPDATE sets the lease, a fresh random lease_token and attempt_count + 1
 *      (counted at claim time so a delivery that crashes workers still reaches `dead`).
 *  (e) D45: UPDATE … FROM joins the message and endpoint so RETURNING hands the worker
 *      everything it needs to send (body, url, secret) in the same round trip.
 */
export async function claimDeliveries(db: Db, opts: ClaimOptions): Promise<ClaimedDelivery[]> {
  if (opts.limit <= 0) return [];
  const { rows } = await db.query<ClaimedDelivery>(
    `WITH due AS (
       SELECT d.id
         FROM deliveries d
         JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= now()
          AND NOT e.disabled
          AND (e.circuit_state = 'closed'
               OR (e.circuit_state = 'open' AND e.circuit_open_until <= now()))
        ORDER BY d.next_attempt_at
        LIMIT $1
          FOR UPDATE OF d SKIP LOCKED
     )
     UPDATE deliveries d
        SET status        = 'in_flight',
            locked_until  = now() + ($2::bigint * interval '1 millisecond'),
            lease_token   = gen_random_uuid(),
            locked_by     = $3,
            attempt_count = d.attempt_count + 1,
            updated_at    = now()
       FROM due, messages m, endpoints e
      WHERE d.id = due.id
        AND m.id = d.message_id
        AND e.id = d.endpoint_id
     RETURNING d.id, d.message_id, d.endpoint_id, d.attempt_count, d.lease_token,
               m.payload::text AS body, e.url, e.secret`,
    [opts.limit, opts.leaseMs, opts.workerId],
  );
  return rows;
}
