import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { eventTypeSchema } from '../../events/event-type.js';
import { PayloadRejectedError, publishMessage } from '../../messages/publish.js';
import { AppError } from '../errors.js';
import { parse } from '../validate.js';

const publishBody = z.strictObject({
  event_type: eventTypeSchema,
  // A JSON object (Q3). z.record rejects arrays, null and primitives.
  payload: z.record(z.string(), z.unknown()),
});

// Same bounds as the DB CHECK (1..255). Printable ASCII only: keys are opaque tokens
// (usually UUIDs); this rules out control characters in a value we store and compare.
const publishHeaders = z.object({
  'idempotency-key': z
    .string()
    .regex(/^[\x20-\x7E]{1,255}$/, 'must be 1-255 printable ASCII characters')
    .optional(),
});

/** Routes under /v1/messages. `scope` is the authenticated /v1 plugin. */
export function registerMessageRoutes(scope: FastifyInstance, pool: pg.Pool): void {
  // POST /v1/messages
  //   202 { message, deliveries }                         new message, fanned out
  //   200 { message, deliveries } + Idempotent-Replayed   same key, same body: original
  //   409 idempotency_key_reused                          same key, different body
  scope.post('/messages', async (request, reply) => {
    const headers = parse(publishHeaders, request.headers, 'headers');
    const body = parse(publishBody, request.body, 'body');

    let outcome;
    try {
      outcome = await publishMessage(pool, request.appId, {
        eventType: body.event_type,
        payload: body.payload,
        idempotencyKey: headers['idempotency-key'],
      });
    } catch (err) {
      if (err instanceof PayloadRejectedError) {
        throw new AppError(400, 'validation_failed', `body.payload: ${err.message}`);
      }
      throw err;
    }

    switch (outcome.kind) {
      case 'created':
        return reply.status(202).send({ message: outcome.message, deliveries: outcome.deliveries });
      case 'replayed':
        return reply
          .status(200)
          .header('idempotent-replayed', 'true')
          .send({ message: outcome.message, deliveries: outcome.deliveries });
      case 'key_reused':
        throw new AppError(
          409,
          'idempotency_key_reused',
          'This Idempotency-Key was already used with a different event_type or payload',
        );
    }
  });
}
