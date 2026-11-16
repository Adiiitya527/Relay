import type pg from 'pg';
import { withTransaction } from '../db/tx.js';

export interface PublishInput {
  eventType: string;
  /** Already validated to be a JSON object (Q3). */
  payload: Record<string, unknown>;
  idempotencyKey: string | undefined;
}

/** The message as returned by publish. The payload is not echoed back (it can be 256 KB). */
export interface PublishedMessage {
  id: string;
  event_type: string;
  idempotency_key: string | null;
  created_at: Date;
}

export interface DeliverySummary {
  id: string;
  endpoint_id: string;
  status: string;
}

export type PublishOutcome =
  | { kind: 'created'; message: PublishedMessage; deliveries: DeliverySummary[] }
  | { kind: 'replayed'; message: PublishedMessage; deliveries: DeliverySummary[] }
  | { kind: 'key_reused' };

/** Postgres refused the payload's content even though it is valid JSON (see below). */
export class PayloadRejectedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PayloadRejectedError';
  }
}

/**
 * Valid JSON that jsonb cannot store:
 *   22P05 untranslatable_character: "\u0000" (jsonb text cannot contain NUL)
 *   22P02 invalid_text_representation: a lone UTF-16 surrogate such as "\ud800"
 * Only the message INSERT can raise these (every other parameter is a validated uuid or
 * text), so they are the client's fault: 400, not 500.
 */
const PAYLOAD_SQLSTATES = new Set(['22P05', '22P02']);

/**
 * Publish one message and fan it out, atomically (invariant 2).
 *
 *   BEGIN
 *   INSERT message ... ON CONFLICT (app_id, idempotency_key) WHERE ... DO NOTHING RETURNING
 *   ├─ row returned → INSERT deliveries (fan-out) → COMMIT → created
 *   └─ no row (key already used) → SELECT the existing message, compare → COMMIT
 *        → same event_type + payload: replayed (original message, current deliveries)
 *        → different: key_reused (→ 409)
 *
 * Concurrency (READ COMMITTED, the default): two requests with the same key race on the
 * unique index. The second INSERT BLOCKS on the first's uncommitted index entry.
 *   - First commits → second's ON CONFLICT DO NOTHING returns no row; the follow-up SELECT
 *     runs with a NEW snapshot (per statement in READ COMMITTED), so it sees the winner.
 *   - First rolls back → the second's INSERT simply succeeds.
 * Either way exactly one message and one set of deliveries exist.
 */
export async function publishMessage(
  pool: pg.Pool,
  appId: string,
  input: PublishInput,
): Promise<PublishOutcome> {
  // jsonb parameter as TEXT: node-postgres would turn a JS array into a Postgres array
  // literal, and objects are only JSON-encoded implicitly. Explicit JSON.stringify + ::jsonb
  // states exactly what Postgres receives.
  const payloadJson = JSON.stringify(input.payload);

  try {
    return await withTransaction(pool, async (client) => {
      const inserted = await client.query<PublishedMessage>(
        `INSERT INTO messages (app_id, event_type, payload, idempotency_key)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (app_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id, event_type, idempotency_key, created_at`,
        // The WHERE after ON CONFLICT (...) is required: it lets Postgres infer the PARTIAL
        // unique index messages_idempotency_uq as the arbiter. Without it: error 42P10.
        [appId, input.eventType, payloadJson, input.idempotencyKey ?? null],
      );

      const message = inserted.rows[0];
      if (message) {
        // T0 fan-out: one pending delivery per ENABLED endpoint of this app that subscribes
        // to everything ('{}') or to this event type. Disabled endpoints get nothing (Q1).
        const fanOut = await client.query<DeliverySummary>(
          `INSERT INTO deliveries (app_id, message_id, endpoint_id)
           SELECT $1, $2, e.id
             FROM endpoints e
            WHERE e.app_id = $1
              AND NOT e.disabled
              AND (cardinality(e.event_types) = 0 OR $3 = ANY (e.event_types))
           RETURNING id, endpoint_id, status`,
          [appId, message.id, input.eventType],
        );
        return { kind: 'created', message, deliveries: fanOut.rows };
      }

      if (input.idempotencyKey === undefined) {
        throw new Error('INSERT without an idempotency key returned no row'); // impossible
      }

      // Key already used in this app. jsonb equality ignores key order and whitespace,
      // so {"a":1,"b":2} and {"b":2,"a":1} count as the same request.
      const existing = await client.query<PublishedMessage & { same: boolean }>(
        `SELECT id, event_type, idempotency_key, created_at,
                (event_type = $3 AND payload = $4::jsonb) AS same
           FROM messages
          WHERE app_id = $1 AND idempotency_key = $2`,
        [appId, input.idempotencyKey, input.eventType, payloadJson],
      );
      const original = existing.rows[0];
      if (!original) throw new Error('idempotency conflict but no existing message found');
      if (!original.same) return { kind: 'key_reused' };

      const { same: _same, ...originalMessage } = original;
      // Current state of the original deliveries (they may have progressed since).
      const deliveries = await client.query<DeliverySummary>(
        `SELECT id, endpoint_id, status FROM deliveries
          WHERE message_id = $1 AND app_id = $2
          ORDER BY created_at, id`,
        [original.id, appId],
      );
      return { kind: 'replayed', message: originalMessage, deliveries: deliveries.rows };
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && PAYLOAD_SQLSTATES.has(code)) {
      throw new PayloadRejectedError(
        'payload contains characters that cannot be stored (\\u0000 or an unpaired surrogate)',
        { cause: err },
      );
    }
    throw err;
  }
}
