/**
 * Retry delay after a failed delivery attempt (ARCHITECTURE §4 "Backoff", D50).
 *
 *   base  = min(capMs, baseMs * 2^(attempt - 1))     exponential, capped
 *   delay = base * (0.8 + 0.4 * random())            ±20 % jitter
 *
 * `attempt` is the number of the attempt that just failed (1 = the first try), i.e. the
 * claimed `attempt_count`. With the defaults (base 2 s, cap 10 min) the schedule is
 * roughly 2 s, 4 s, 8 s, 16 s, 32 s, … until it reaches the cap.
 *
 * Why jitter: if an endpoint goes down, every delivery to it fails at about the same time.
 * Without jitter they would all retry at exactly the same moments and hit the endpoint in
 * synchronised waves just as it recovers. Jitter spreads them out.
 *
 * Why jitter is applied AFTER the cap (D50): clamping the jittered value to the cap would
 * turn every long delay into exactly `capMs`, so deliveries at the cap would fire in sync
 * again. The price is that the longest real delay is 1.2 * capMs.
 *
 * Pure: `random` is injected so tests are deterministic. It must return a value in [0, 1).
 */
export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

export function computeBackoffMs(
  attempt: number,
  { baseMs, capMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be an integer >= 1 (got ${attempt})`);
  }
  if (!(baseMs >= 0) || !(capMs >= baseMs)) {
    throw new RangeError('backoff requires 0 <= baseMs <= capMs');
  }

  // 2 ** n becomes Infinity for very large n, never NaN, and Math.min(cap, Infinity) is
  // cap, so a huge attempt number cannot overflow into a bogus delay.
  const exponential = baseMs * 2 ** (attempt - 1);
  const capped = Math.min(capMs, exponential);
  const jitterFactor = 0.8 + 0.4 * random();
  return Math.round(capped * jitterFactor);
}
