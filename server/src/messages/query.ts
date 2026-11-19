import { encodeCursor, sqlMicrosOf, sqlTimestampOfMicros, type Cursor } from '../db/cursor.js';
import type { Db } from '../db/pool.js';

// The keyset cursor (D33) lives in db/cursor.ts; re-exported for existing importers.
export { decodeCursor, encodeCursor, type Cursor } from '../db/cursor.js';

// ---------------------------------------------------------------------------------------

export interface MessageSummary {
  id: string;
  event_type: string;
  idempotency_key: string | null;
  created_at: Date;
}

export interface MessagePage {
  data: MessageSummary[];
  /** Pass back as ?cursor= to get the next (older) page; null on the last page. */
  next_cursor: string | null;
}

const MICROS_OF_CREATED_AT = sqlMicrosOf('created_at');
const TIMESTAMP_OF_CURSOR = sqlTimestampOfMicros('$2');

const LIST_COLUMNS = `id, event_type, idempotency_key, created_at, ${MICROS_OF_CREATED_AT} AS micros`;

/**
 * Newest first, keyset-paginated. Two static statements (first page / later pages) rather
 * than one with `$2 IS NULL OR ...`, so each keeps a simple, index-friendly plan.
 *
 * Both use messages_app_keyset_idx (app_id, created_at DESC, id DESC): equality on app_id,
 * then a ROW comparison `(created_at, id) < (c, i)`, which Postgres turns into an index
 * range scan starting exactly after the previous page. Cost is O(limit) however deep the
 * caller pages, unlike OFFSET, which reads and discards every earlier row.
 *
 * `id` breaks ties: every message inserted in one transaction has the same created_at
 * (now() is the transaction start time). Sorting by created_at alone would leave their
 * order undefined and rows could repeat or vanish across pages.
 *
 * We fetch limit + 1 rows: the extra row only tells us whether another page exists.
 */
export async function listMessages(
  db: Db,
  appId: string,
  opts: { limit: number; cursor: Cursor | undefined },
): Promise<MessagePage> {
  const { rows } = opts.cursor
    ? await db.query<MessageSummary & { micros: string }>(
        `SELECT ${LIST_COLUMNS}
           FROM messages
          WHERE app_id = $1
            AND (created_at, id) < (${TIMESTAMP_OF_CURSOR}, $3::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [appId, opts.cursor.micros, opts.cursor.id, opts.limit + 1],
      )
    : await db.query<MessageSummary & { micros: string }>(
        `SELECT ${LIST_COLUMNS}
           FROM messages
          WHERE app_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        [appId, opts.limit + 1],
      );

  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    data: page.map(({ micros: _micros, ...message }) => message),
    next_cursor: hasMore && last ? encodeCursor({ micros: last.micros, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------------------

export interface DeliveryDetail {
  id: string;
  endpoint_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface MessageDetail extends MessageSummary {
  payload: Record<string, unknown>;
  deliveries: DeliveryDetail[];
}

/**
 * One message (with payload) and its deliveries. Both queries filter by app_id: another
 * tenant's message id returns undefined (→ 404). Lease fields (locked_until, lease_token,
 * locked_by) are worker internals and are not exposed.
 *
 * Two statements without a transaction: a delivery may change state between them, which
 * is harmless for a read-only view.
 */
export async function getMessage(db: Db, appId: string, id: string): Promise<MessageDetail | undefined> {
  const { rows } = await db.query<Omit<MessageDetail, 'deliveries'>>(
    `SELECT id, event_type, idempotency_key, created_at, payload
       FROM messages
      WHERE id = $1 AND app_id = $2`,
    [id, appId],
  );
  const message = rows[0];
  if (!message) return undefined;

  const deliveries = await db.query<DeliveryDetail>(
    `SELECT id, endpoint_id, status, attempt_count, next_attempt_at, last_error,
            created_at, updated_at, completed_at
       FROM deliveries
      WHERE message_id = $1 AND app_id = $2
      ORDER BY created_at, id`,
    [id, appId],
  );
  return { ...message, deliveries: deliveries.rows };
}
