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
 * Take up to `limit` due deliveries and lease them to this worker: first circuit-breaker
 * probes (at most one per cooled-down endpoint), then ordinary deliveries for endpoints
 * whose circuit is closed. Each part is one statement = one short implicit transaction.
 */
export async function claimDeliveries(db: Db, opts: ClaimOptions): Promise<ClaimedDelivery[]> {
  if (opts.limit <= 0) return [];
  const probes = await claimProbes(db, opts);
  const normal = await claimClosed(db, { ...opts, limit: opts.limit - probes.length });
  return [...probes, ...normal];
}

/**
 * Ordinary claim: endpoints whose circuit is CLOSED.
 *
 * One statement = one short implicit transaction (invariant 3): the row locks below are
 * released as soon as it commits, long before any HTTP request starts. From then on the
 * LEASE (status in_flight + locked_until + lease_token) is what keeps other workers away.
 *
 *  (a) `due` CTE: find candidates via the partial index deliveries_claim_idx
 *      (next_attempt_at WHERE status = 'pending'). `now()` is the DB clock (invariant 7).
 *  (b) Paused rows are skipped and keep their attempts (invariant 9): disabled endpoints,
 *      and every circuit that is not closed (open ones are tried only via claimProbes).
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
async function claimClosed(db: Db, opts: ClaimOptions): Promise<ClaimedDelivery[]> {
  if (opts.limit <= 0) return [];
  const { rows } = await db.query<ClaimedDelivery>(
    `WITH due AS (
       SELECT d.id
         FROM deliveries d
         JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= now()
          AND NOT e.disabled
          AND e.circuit_state = 'closed'
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

/**
 * Half-open, single probe (ARCHITECTURE §4, D12). When an open circuit's cooldown has
 * passed, exactly ONE delivery is sent as a probe; everyone else keeps skipping the
 * endpoint until the probe's result closes or re-opens the circuit.
 *
 *  candidates: endpoints due for a probe: `open` with the cooldown over, or `half_open`
 *              whose probe deadline passed (its probe was lost: worker crash or lease
 *              lost). Only endpoints that actually have a due delivery, so we never park
 *              an endpoint in half_open with nothing to send. FOR UPDATE SKIP LOCKED:
 *              if another worker is promoting the same endpoint right now, skip it. This
 *              lock is what makes the probe single: only one statement can win the row.
 *  promoted:   → half_open, with circuit_open_until = now() + lease as the PROBE DEADLINE.
 *              The deadline makes half_open self-healing: no probe result by then means
 *              another probe is allowed (see candidates).
 *  probe:      exactly one due delivery per promoted endpoint (LATERAL … LIMIT 1).
 *              SKIP LOCKED again: if that row is locked we get none this time, and the
 *              deadline lets the endpoint be probed again later.
 *  UPDATE:     the same lease as an ordinary claim. url/secret come from `promoted`
 *              (RETURNING), not the endpoints table, which this statement's snapshot sees
 *              unmodified.
 *
 * Locks are only ever taken with SKIP LOCKED here, so this statement never waits and
 * cannot be part of a deadlock with result writes (which lock delivery, then endpoint).
 */
async function claimProbes(db: Db, opts: ClaimOptions): Promise<ClaimedDelivery[]> {
  const { rows } = await db.query<ClaimedDelivery>(
    `WITH candidates AS (
       SELECT e.id
         FROM endpoints e
        WHERE e.circuit_state IN ('open', 'half_open')
          AND e.circuit_open_until <= now()
          AND NOT e.disabled
          AND EXISTS (SELECT 1 FROM deliveries d
                       WHERE d.endpoint_id = e.id
                         AND d.status = 'pending'
                         AND d.next_attempt_at <= now())
        ORDER BY e.circuit_open_until
        LIMIT $1
          FOR UPDATE SKIP LOCKED
     ), promoted AS (
       UPDATE endpoints e
          SET circuit_state      = 'half_open',
              circuit_open_until = now() + ($2::bigint * interval '1 millisecond'),
              updated_at         = now()
         FROM candidates c
        WHERE e.id = c.id
       RETURNING e.id, e.url, e.secret
     ), probe AS (
       SELECT x.id
         FROM promoted p
        CROSS JOIN LATERAL (
          SELECT d.id
            FROM deliveries d
           WHERE d.endpoint_id = p.id
             AND d.status = 'pending'
             AND d.next_attempt_at <= now()
           ORDER BY d.next_attempt_at
           LIMIT 1
             FOR UPDATE SKIP LOCKED
        ) x
     )
     UPDATE deliveries d
        SET status        = 'in_flight',
            locked_until  = now() + ($2::bigint * interval '1 millisecond'),
            lease_token   = gen_random_uuid(),
            locked_by     = $3,
            attempt_count = d.attempt_count + 1,
            updated_at    = now()
       FROM probe, messages m, promoted p
      WHERE d.id = probe.id
        AND m.id = d.message_id
        AND p.id = d.endpoint_id
     RETURNING d.id, d.message_id, d.endpoint_id, d.attempt_count, d.lease_token,
               m.payload::text AS body, p.url, p.secret`,
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
  /** CIRCUIT_FAILURE_THRESHOLD / CIRCUIT_COOLDOWN_MS. */
  circuit: { failureThreshold: number; cooldownMs: number };
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
 * 3. Update the endpoint's circuit breaker from this result (see updateCircuit).
 *
 * All commit together or not at all: never a state change without its attempt row, or a
 * circuit change the attempt log doesn't explain. Zero rows in (1) → 'lease_lost': the
 * result is discarded, including its effect on the circuit.
 *
 * Lock order is always delivery row (1), then endpoint row (3), in every result write,
 * and claims never wait for locks, so result writes cannot deadlock each other or claims.
 */
export async function recordResult(
  pool: pg.Pool,
  claim: Pick<ClaimedDelivery, 'id' | 'lease_token' | 'attempt_count'>,
  result: SendResult,
  opts: RecordOptions,
): Promise<RecordOutcome> {
  return withTransaction(pool, async (client) => {
    const updated = result.ok
      ? await client.query<{ status: string; endpoint_id: string }>(
          `UPDATE deliveries
              SET status = 'succeeded', completed_at = now(), last_error = NULL,
                  locked_until = NULL, lease_token = NULL, locked_by = NULL, updated_at = now()
            WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'
           RETURNING status, endpoint_id`,
          [claim.id, claim.lease_token],
        )
      : await client.query<{ status: string; endpoint_id: string }>(
          `UPDATE deliveries
              SET status          = CASE WHEN attempt_count >= $3 THEN 'dead' ELSE 'pending' END,
                  next_attempt_at = CASE WHEN attempt_count >= $3 THEN next_attempt_at
                                         ELSE now() + ($4::bigint * interval '1 millisecond') END,
                  completed_at    = CASE WHEN attempt_count >= $3 THEN now() END,
                  last_error = $5,
                  locked_until = NULL, lease_token = NULL, locked_by = NULL, updated_at = now()
            WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'
           RETURNING status, endpoint_id`,
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

    await updateCircuit(client, row.endpoint_id, result.ok, opts.circuit);

    return row.status === 'succeeded' ? 'succeeded' : row.status === 'dead' ? 'dead' : 'retrying';
  });
}

/**
 * Circuit breaker transitions on a recorded result (ARCHITECTURE §4). In SET, every
 * column reference reads the row's OLD values, so `circuit_state = 'half_open'` below
 * means "it WAS half_open", i.e. this result is the probe's.
 *
 *  success → closed, counter reset. Skipped when already closed with 0 failures: the
 *            common case writes nothing, which keeps contention on the endpoint row low.
 *  failure → counter + 1, and open for CIRCUIT_COOLDOWN_MS if the probe failed or the
 *            counter reached the threshold. While open, the claim skips the endpoint's
 *            deliveries entirely, so they wait without spending attempts (invariant 9).
 */
async function updateCircuit(
  client: pg.PoolClient,
  endpointId: string,
  succeeded: boolean,
  circuit: RecordOptions['circuit'],
): Promise<void> {
  if (succeeded) {
    await client.query(
      `UPDATE endpoints
          SET circuit_state = 'closed', consecutive_failures = 0, circuit_open_until = NULL,
              updated_at = now()
        WHERE id = $1 AND (circuit_state <> 'closed' OR consecutive_failures <> 0)`,
      [endpointId],
    );
    return;
  }
  await client.query(
    `UPDATE endpoints
        SET consecutive_failures = consecutive_failures + 1,
            circuit_state = CASE
              WHEN circuit_state = 'half_open' OR consecutive_failures + 1 >= $2 THEN 'open'
              ELSE circuit_state END,
            circuit_open_until = CASE
              WHEN circuit_state = 'half_open' OR consecutive_failures + 1 >= $2
                THEN now() + ($3::bigint * interval '1 millisecond')
              ELSE circuit_open_until END,
            updated_at = now()
      WHERE id = $1`,
    [endpointId, circuit.failureThreshold, circuit.cooldownMs],
  );
}

// ---------------------------------------------------------------------------------------
// T4 — sweep expired leases (crash recovery)
// ---------------------------------------------------------------------------------------

export interface SweepOptions {
  maxAttempts: number;
  /** Rows per statement; the sweep repeats while batches come back full. */
  batchSize?: number;
}

/**
 * Return deliveries whose worker vanished (crash, kill -9, network partition) to the
 * queue. Any worker may run this at any time; it is safe concurrently with other
 * sweepers and with live workers.
 *
 * One statement per batch (atomic), three parts:
 *   expired: in_flight rows whose lease ran out (DB clock), via the partial index
 *            deliveries_lease_idx. FOR UPDATE SKIP LOCKED: a row being swept by another
 *            sweeper, or being recorded by its worker right now, is skipped.
 *   upd:     back to pending (the lease time already acted as the delay), or dead if the
 *            attempt that crashed was the last allowed one. The attempt was counted at
 *            claim time, so a payload that crashes every worker still ends up dead.
 *            Clearing lease_token fences out the original worker (see recordResult).
 *   INSERT:  a `lease_expired` attempt row so the crash shows in the timeline. The old
 *            token and worker come from `expired`: RETURNING in `upd` would only show
 *            the new values (already NULL). lease_token is UNIQUE, so a sweep and the
 *            worker's own result can never both log the same claim.
 *
 * Worker-vs-sweeper race: both need the row lock. If the worker's record holds it, the
 * sweeper skips the row (and the worker wins). If the sweeper holds it, the worker's
 * fenced UPDATE waits, re-checks its WHERE, finds lease_token NULL and gets 0 rows
 * (lease_lost). Either way exactly one outcome and one attempt row.
 *
 * Returns the number of deliveries recovered.
 */
export async function sweepExpiredLeases(db: Db, opts: SweepOptions): Promise<number> {
  const batchSize = opts.batchSize ?? 100;
  let total = 0;
  for (;;) {
    const { rowCount } = await db.query(
      `WITH expired AS (
         SELECT id, lease_token, locked_by, attempt_count
           FROM deliveries
          WHERE status = 'in_flight' AND locked_until < now()
          ORDER BY locked_until
          LIMIT $2
            FOR UPDATE SKIP LOCKED
       ), upd AS (
         UPDATE deliveries d
            SET status          = CASE WHEN d.attempt_count >= $1 THEN 'dead' ELSE 'pending' END,
                completed_at    = CASE WHEN d.attempt_count >= $1 THEN now() END,
                next_attempt_at = now(),
                last_error      = 'lease expired',
                locked_until = NULL, lease_token = NULL, locked_by = NULL, updated_at = now()
           FROM expired x
          WHERE d.id = x.id
         RETURNING d.id
       )
       INSERT INTO delivery_attempts
         (delivery_id, lease_token, attempt_number, worker_id, error_kind, error_message)
       SELECT x.id, x.lease_token, x.attempt_count, x.locked_by, 'lease_expired',
              'worker lease expired before a result was recorded'
         FROM expired x JOIN upd USING (id)`,
      [opts.maxAttempts, batchSize],
    );
    const swept = rowCount ?? 0;
    total += swept;
    if (swept < batchSize) return total;
  }
}
