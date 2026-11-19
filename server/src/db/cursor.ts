// ---------------------------------------------------------------------------------------
// Keyset-pagination cursor shared by every "newest first" list (messages, deliveries).
//
// An opaque base64url string encoding "<created_at in epoch MICROseconds>|<id>" (D33).
//
// Why microseconds as an integer, not an ISO date: Postgres timestamptz has microsecond
// precision, but node-postgres converts it to a JS Date, which keeps only milliseconds.
// A cursor built from the Date would be truncated, and `(created_at, id) < (cursor)` would
// then silently skip rows created within the same millisecond as the page's last row.
// So the exact value is computed in SQL and never passes through a Date.
//
// The cursor is not signed. Tampering can only move the caller to another position in
// THEIR OWN list (every query is scoped by app_id), so there is nothing to protect.
// ---------------------------------------------------------------------------------------

export interface Cursor {
  /**
   * created_at as integer microseconds since the Unix epoch. Kept as a decimal string
   * end-to-end (SQL → cursor → SQL parameter), so it is never rounded through a JS number.
   */
  micros: string;
  id: string;
}

const CURSOR_PATTERN =
  /^(\d{1,16})\|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.micros}|${cursor.id}`, 'utf8').toString('base64url');
}

/** Returns undefined for anything that is not a cursor we could have produced. */
export function decodeCursor(value: string): Cursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) return undefined;
  const match = CURSOR_PATTERN.exec(Buffer.from(value, 'base64url').toString('utf8'));
  if (!match) return undefined;
  return { micros: match[1]!, id: match[2]!.toLowerCase() };
}

/**
 * SQL: a timestamptz column → exact epoch microseconds as text. extract(epoch ...) returns
 * numeric (exact) since PG 14, so "* 1000000 → bigint" loses nothing. `column` must be a
 * constant from our own code, never user input.
 */
export function sqlMicrosOf(column: string): string {
  return `(extract(epoch FROM ${column}) * 1000000)::bigint::text`;
}

/**
 * SQL: epoch-microseconds parameter → timestamptz. bigint * interval is computed in
 * float8, which is exact for whole numbers below 2^53 µs (≈ the year 2255).
 */
export function sqlTimestampOfMicros(param: string): string {
  return `('epoch'::timestamptz + ${param}::bigint * interval '1 microsecond')`;
}
