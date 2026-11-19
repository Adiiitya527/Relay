import type pg from 'pg';
import type { Logger } from 'pino';
import { computeBackoffMs } from '../delivery/backoff.js';
import type { SafeHttpClient } from '../delivery/http-client.js';
import { signPayload } from '../delivery/signing.js';
import { recordResult, type ClaimedDelivery, type RecordOutcome } from './queue.js';

export const USER_AGENT = 'Relay/0.1';

export interface DeliverDeps {
  pool: pg.Pool;
  client: SafeHttpClient;
  logger: Logger;
  workerId: string;
  retry: { baseMs: number; capMs: number; maxAttempts: number };
  /** Worker clock for webhook-timestamp only (invariant 7 exception). Injectable for tests. */
  nowMs?: () => number;
}

/**
 * Send one claimed delivery and record the outcome. Runs with NO transaction open: the
 * claim committed before this started, and recordResult opens its own short one after
 * the HTTP request has finished (invariant 3).
 *
 * The body is turned into bytes ONCE and those exact bytes are both signed and sent, so
 * the signature always matches what the consumer receives (D21).
 *
 * Throws only if recording fails (e.g. the DB is down). The row then stays in_flight
 * and the sweeper retries it after the lease expires: at-least-once (invariant 6).
 */
export async function deliverOne(claim: ClaimedDelivery, deps: DeliverDeps): Promise<RecordOutcome> {
  const body = Buffer.from(claim.body, 'utf8');
  // Spec: unix seconds at send time, from the sender's clock. The consumer compares it
  // with its own clock (± tolerance). Nothing in Relay compares against it.
  const timestamp = Math.floor((deps.nowMs ?? Date.now)() / 1000);

  const result = await deps.client.post(
    claim.url,
    {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      // Stable across retries (it is the message id), so consumers can dedupe (invariant 6).
      'webhook-id': claim.message_id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signPayload({
        secret: claim.secret,
        msgId: claim.message_id,
        timestamp,
        body,
      }),
    },
    body,
  );

  const backoffMs = result.ok ? 0 : computeBackoffMs(claim.attempt_count, deps.retry);
  const outcome = await recordResult(deps.pool, claim, result, {
    maxAttempts: deps.retry.maxAttempts,
    backoffMs,
    workerId: deps.workerId,
  });

  // D49: ids only. Never the URL (it may carry a token) or the secret.
  const fields = {
    delivery_id: claim.id,
    message_id: claim.message_id,
    endpoint_id: claim.endpoint_id,
    attempt: claim.attempt_count,
    outcome,
    duration_ms: result.durationMs,
    ...(result.status !== undefined && { status: result.status }),
    ...(!result.ok && { error_kind: result.errorKind }),
    ...(outcome === 'retrying' && { retry_in_ms: backoffMs }),
  };
  if (outcome === 'succeeded') deps.logger.info(fields, 'delivered');
  else if (outcome === 'lease_lost') {
    deps.logger.warn(
      { ...fields, lease_token: claim.lease_token },
      'lease lost before the result was recorded; result discarded',
    );
  } else if (outcome === 'dead') deps.logger.warn(fields, 'delivery failed permanently (dead)');
  else deps.logger.info(fields, 'delivery attempt failed; will retry');

  return outcome;
}
