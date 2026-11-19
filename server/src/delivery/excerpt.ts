/**
 * Text stored in delivery_attempts.response_excerpt / error_message (D46).
 *
 * Both columns are `text` with CHECK (length(...) <= 1024). Postgres `length()` counts
 * characters (code points), and a Postgres text value can never contain U+0000: inserting
 * one fails with SQLSTATE 22P05. A consumer controls its response body, so without this
 * sanitising a single NUL byte would make every result write for that delivery fail; the
 * lease would expire and the message would be redelivered forever.
 */

export const TEXT_LIMIT = 1024;

/** Strip NULs and cut to at most `max` code points (never splitting a surrogate pair). */
export function sanitizeText(text: string, max = TEXT_LIMIT): string {
  const clean = text.replaceAll('\u0000', '');
  if (clean.length <= max) return clean; // UTF-16 length >= code-point count
  return Array.from(clean).slice(0, max).join('');
}

/**
 * Response bytes → excerpt. Decoding is lossy: invalid UTF-8 (including a multi-byte
 * character cut in half at the read limit) becomes U+FFFD, which Postgres accepts.
 */
export function toExcerpt(bytes: Buffer): string {
  return sanitizeText(bytes.subarray(0, TEXT_LIMIT * 4).toString('utf8'));
}
