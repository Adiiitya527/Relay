/**
 * Poll `check` until it returns a truthy value, then return it. For asynchronous
 * outcomes (a worker delivering in the background). Fails with `message` on timeout.
 */
export async function waitFor<T>(
  check: () => Promise<T> | T,
  { timeoutMs = 5_000, intervalMs = 20, message = 'condition' } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
