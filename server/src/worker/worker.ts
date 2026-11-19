import type pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { createSafeHttpClient, type SafeHttpClient } from '../delivery/http-client.js';
import { deliverOne } from './deliver.js';
import { claimDeliveries, sweepExpiredLeases, type ClaimedDelivery } from './queue.js';

/** Upper bound for the poll back-off while the database is failing. */
const MAX_ERROR_BACKOFF_MS = 5_000;

/**
 * A sleep that can be cut short. `wake()` before `sleep()` is remembered, so a wake-up
 * that arrives while the loop is busy (e.g. mid-claim) is not lost.
 */
function createSleeper() {
  let wakeCurrent: (() => void) | undefined;
  let pending = false;
  return {
    sleep(ms: number): Promise<void> {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wakeCurrent = undefined;
          resolve();
        };
        const timer = setTimeout(done, ms);
        wakeCurrent = done;
      });
    },
    wake() {
      if (wakeCurrent) wakeCurrent();
      else pending = true;
    },
  };
}

export interface WorkerDeps {
  config: Config;
  pool: pg.Pool;
  logger: Logger;
  /** Defaults to the SSRF-safe client built from config (invariant 8). */
  client?: SafeHttpClient;
}

export interface Worker {
  start(): void;
  /**
   * Stop claiming and sweeping, then wait (bounded) for in-progress deliveries to finish
   * and be recorded. Does not end the pool: the caller owns it.
   */
  stop(): Promise<void>;
  /** Deliveries currently being sent (for tests and logs). */
  readonly inFlight: number;
}

/**
 * The delivery loop (ARCHITECTURE §4):
 *
 *   free = concurrency - inFlight
 *   claim(limit: free)       → each claimed row starts its request immediately, so the
 *                              lease clock and the HTTP clock start together (invariant 5)
 *   sleep(pollInterval)      → cut short as soon as a delivery finishes and frees a slot
 *
 * A separate loop sweeps expired leases every SWEEP_INTERVAL_MS (first sweep at start-up,
 * so rows left behind by a crashed previous run are recovered straight away).
 *
 * Nothing here holds a DB transaction while waiting on the network: claim, record and
 * sweep are each their own short transaction.
 */
export function createWorker({ config, pool, logger, client: injected }: WorkerDeps): Worker {
  const w = config.worker;
  const client =
    injected ??
    createSafeHttpClient({
      allowPrivateNetworks: config.security.allowPrivateNetworks,
      allowHttp: config.security.allowHttpEndpoints,
      timeoutMs: w.httpTimeoutMs,
    });
  const deliverDeps = { pool, client, logger, workerId: w.id, retry: config.retry, circuit: config.circuit };

  const active = new Set<Promise<void>>();
  const claimSleeper = createSleeper();
  const sweepSleeper = createSleeper();
  let running = false;
  let loops: Promise<void> | undefined;

  function track(claim: ClaimedDelivery) {
    const task: Promise<void> = deliverOne(claim, deliverDeps)
      .then(
        () => undefined,
        (err: unknown) => {
          // Recording failed (DB down?). The row stays in_flight; the sweeper returns it
          // to the queue once the lease expires, so nothing is lost.
          logger.error(
            { err, delivery_id: claim.id, message_id: claim.message_id, endpoint_id: claim.endpoint_id },
            'could not record delivery result; it will be retried after lease expiry',
          );
        },
      )
      .finally(() => {
        active.delete(task);
        claimSleeper.wake(); // a slot is free: claim again now, not after the poll interval
      });
    active.add(task);
  }

  async function claimLoop() {
    let errorBackoff = 0;
    while (running) {
      const free = w.concurrency - active.size;
      if (free > 0) {
        try {
          const claims = await claimDeliveries(pool, {
            limit: free,
            leaseMs: w.leaseMs,
            workerId: w.id,
          });
          errorBackoff = 0;
          // Even if stop() was called meanwhile: these rows are leased to us, so send them.
          for (const claim of claims) track(claim);
          if (claims.length === free && running) continue; // more may be waiting
        } catch (err) {
          errorBackoff = Math.min(errorBackoff ? errorBackoff * 2 : w.pollIntervalMs, MAX_ERROR_BACKOFF_MS);
          logger.warn({ err, retry_in_ms: errorBackoff }, 'claim failed; backing off');
          await claimSleeper.sleep(errorBackoff);
          continue;
        }
      }
      await claimSleeper.sleep(w.pollIntervalMs);
    }
  }

  async function sweepLoop() {
    while (running) {
      try {
        const recovered = await sweepExpiredLeases(pool, { maxAttempts: config.retry.maxAttempts });
        if (recovered > 0) logger.warn({ count: recovered }, 'recovered deliveries with expired leases');
      } catch (err) {
        logger.warn({ err }, 'lease sweep failed; will retry');
      }
      await sweepSleeper.sleep(w.sweepIntervalMs);
    }
  }

  return {
    get inFlight() {
      return active.size;
    },

    start() {
      if (running) return;
      running = true;
      loops = Promise.all([claimLoop(), sweepLoop()]).then(() => undefined);
      logger.info({ worker_id: w.id, concurrency: w.concurrency }, 'worker started');
    },

    async stop() {
      running = false;
      claimSleeper.wake();
      sweepSleeper.wake();
      await loops; // finishes the claim/sweep statement in progress, if any

      // Each delivery is bounded by HTTP_TIMEOUT_MS, plus a moment to record its result.
      const graceMs = w.httpTimeoutMs + 5_000;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(timer);
      if (active.size > 0) {
        logger.warn(
          { count: active.size },
          'stopped with deliveries still in progress; they will be retried after lease expiry',
        );
      }
      logger.info({ worker_id: w.id }, 'worker stopped');
    },
  };
}
