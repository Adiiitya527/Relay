import type pg from 'pg';
import { sanitizeText } from '../delivery/excerpt.js';
import type { SendResult } from '../delivery/http-client.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';

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

// ---------------------------------------------------------------------------------------
// T2 / T3 — record the result of an attempt, fenced by the lease token
// ---------------------------------------------------------------------------------------

/** What happened to the delivery row. `lease_lost` = our result was discarded. */
export type RecordOutcome = 'succeeded' | 'retrying' | 'dead' | 'lease_lost';

export interface RecordOptions {
  /** MAX_ATTEMPTS: a failure on this attempt number (or later) makes the delivery dead. */
  maxAttempts: number;
  /** Delay before the next attempt if this one failed (computeBackoffMs, pure TS). */
  backoffMs: number;
  workerId: string;
}

/** Short human-readable summary kept on the delivery row (the attempt row has details). */
function lastError(result: Extract<SendResult, { ok: false }>): string {
  return sanitizeText(
    result.errorKind === 'http_status'
      ? result.errorMessage
      : `${result.errorKind}: ${result.errorMessage}`,
  );
}

/**
 * Write one attempt's outcome. One short transaction (invariant 3), two statements:
 *
 * 1. The fenced UPDATE. `WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'`
 *    matches only if THIS claim still holds the lease (invariant 4). Every exit from
 *    in_flight clears lease_token, so after a sweep or another worker's re-claim our
 *    token can never match again: a slow "zombie" worker cannot overwrite a newer
 *    outcome. The fence is the TOKEN, not the clock: if our lease expired but nobody has
 *    swept it yet, the token still matches and our (real) result is accepted.
 *    Failure: retry-or-dead is decided by a CASE inside the same statement, so it reads
 *    the row's own attempt_count atomically with the update.
 * 2. Only if (1) matched: append the attempt row, keyed by the claim's lease_token
 *    (UNIQUE: one attempt row per claim, D13).
 *
 * Both commit together or not at all: never a state change without its attempt row, or
 * the reverse. Zero rows in (1) → 'lease_lost'; the caller logs it, nothing is written.
 */
export async function recordResult(
  pool: pg.Pool,
  claim: Pick<ClaimedDelivery, 'id' | 'lease_token' | 'attempt_count'>,
  result: SendResult,
  opts: RecordOptions,
): Promise<RecordOutcome> {
  return withTransaction(pool, async (client) => {
    const updated = result.ok
      ? await client.query<{ status: string }>(
          `UPDATE deliveries
              SET status = 'succeeded', completed_at = now(), last_error = NULL,
                  locked_until = NULL, lease_token = NULL, locked_by = NULL, updated_at = now()
            WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'
           RETURNING status`,
          [claim.id, claim.lease_token],
        )
      : await client.query<{ status: string }>(
          `UPDATE deliveries
              SET status          = CASE WHEN attempt_count >= $3 THEN 'dead' ELSE 'pending' END,
                  next_attempt_at = CASE WHEN attempt_count >= $3 THEN next_attempt_at
                                         ELSE now() + ($4::bigint * interval '1 millisecond') END,
                  completed_at    = CASE WHEN attempt_count >= $3 THEN now() END,
                  last_error = $5,
                  locked_until = NULL, lease_token = NULL, locked_by = NULL, updated_at = now()
            WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'
           RETURNING status`,
          [claim.id, claim.lease_token, opts.maxAttempts, opts.backoffMs, lastError(result)],
        );

    const row = updated.rows[0];
    if (!row) return 'lease_lost';

    await client.query(
      `INSERT INTO delivery_attempts
         (delivery_id, lease_token, attempt_number, worker_id, duration_ms,
          response_status, response_excerpt, error_kind, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        claim.id,
        claim.lease_token,
        claim.attempt_count,
        opts.workerId,
        result.durationMs,
        result.status ?? null,
        result.excerpt || null,
        result.ok ? null : result.errorKind,
        result.ok ? null : result.errorMessage,
      ],
    );

    return row.status === 'succeeded' ? 'succeeded' : row.status === 'dead' ? 'dead' : 'retrying';
  });
}
