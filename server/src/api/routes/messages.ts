import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { eventTypeSchema } from '../../events/event-type.js';
import { PayloadRejectedError, publishMessage } from '../../messages/publish.js';
import { decodeCursor, getMessage, listMessages } from '../../messages/query.js';
import { AppError } from '../errors.js';
import { parse } from '../validate.js';

const listQuery = z.strictObject({
  // Query values arrive as strings; coerce, then require an integer in range.
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .transform((value, ctx) => {
      const cursor = decodeCursor(value);
      if (!cursor) {
        ctx.addIssue({ code: 'custom', message: 'invalid cursor' });
        return z.NEVER;
      }
      return cursor;
    })
    .optional(),
});

const idParams = z.object({ id: z.guid() });

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
  // GET /v1/messages?limit=20&cursor=... → { data: [...newest first], next_cursor }
  // The list omits payloads (100 × 256 KB would be 25 MB); fetch one message for its payload.
  scope.get('/messages', async (request) => {
    const query = parse(listQuery, request.query, 'query');
    return listMessages(pool, request.appId, { limit: query.limit, cursor: query.cursor });
  });

  // GET /v1/messages/:id → message with payload + its deliveries
  scope.get('/messages/:id', async (request) => {
    const { id } = parse(idParams, request.params, 'params');
    const message = await getMessage(pool, request.appId, id);
    if (!message) throw new AppError(404, 'not_found', 'Message not found');
    return message;
  });

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
