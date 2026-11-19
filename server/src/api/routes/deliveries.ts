import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { decodeCursor } from '../../db/cursor.js';
import {
  getDelivery,
  listAttempts,
  listDeliveries,
  replayDeadForEndpoint,
  replayDelivery,
} from '../../deliveries/repo.js';
import { AppError } from '../errors.js';
import { parse } from '../validate.js';

const idParams = z.object({ id: z.guid() });

const listQuery = z.strictObject({
  status: z.enum(['pending', 'in_flight', 'succeeded', 'dead']).optional(),
  endpoint_id: z.guid().optional(),
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

/** Routes under /v1 for deliveries and replay. `scope` is the authenticated /v1 plugin. */
export function registerDeliveryRoutes(scope: FastifyInstance, pool: pg.Pool): void {
  // GET /v1/deliveries?status=dead&endpoint_id=…&limit=20&cursor=…
  //   → { data: [...newest first], next_cursor }. Filtering by status=dead is the DLQ view.
  scope.get('/deliveries', async (request) => {
    const q = parse(listQuery, request.query, 'query');
    return listDeliveries(pool, request.appId, {
      status: q.status,
      endpointId: q.endpoint_id,
      limit: q.limit,
      cursor: q.cursor,
    });
  });

  // GET /v1/deliveries/:id → one delivery (with its event_type)
  scope.get('/deliveries/:id', async (request) => {
    const { id } = parse(idParams, request.params, 'params');
    const delivery = await getDelivery(pool, request.appId, id);
    if (!delivery) throw new AppError(404, 'not_found', 'Delivery not found');
    return delivery;
  });

  // GET /v1/deliveries/:id/attempts → { data: [...oldest first] }
  scope.get('/deliveries/:id/attempts', async (request) => {
    const { id } = parse(idParams, request.params, 'params');
    // Existence first, so a delivery with no attempts yet is `{ data: [] }`, not 404.
    if (!(await getDelivery(pool, request.appId, id))) {
      throw new AppError(404, 'not_found', 'Delivery not found');
    }
    return { data: await listAttempts(pool, request.appId, id) };
  });

  // POST /v1/deliveries/:id/replay
  //   202 { delivery }                       queued again (attempts reset, history kept)
  //   404 not_found                          missing, or another tenant's
  //   409 delivery_not_replayable            still pending / in flight
  scope.post('/deliveries/:id/replay', async (request, reply) => {
    const { id } = parse(idParams, request.params, 'params');
    const outcome = await replayDelivery(pool, request.appId, id);
    switch (outcome.kind) {
      case 'replayed':
        return reply.status(202).send({ delivery: outcome.delivery });
      case 'not_found':
        throw new AppError(404, 'not_found', 'Delivery not found');
      case 'not_replayable':
        throw new AppError(
          409,
          'delivery_not_replayable',
          `Delivery is ${outcome.status}; only dead or succeeded deliveries can be replayed`,
        );
    }
  });

  // POST /v1/endpoints/:id/replay-dead → 202 { replayed: n }  (404 for an unknown endpoint)
  scope.post('/endpoints/:id/replay-dead', async (request, reply) => {
    const { id } = parse(idParams, request.params, 'params');
    const { found, replayed } = await replayDeadForEndpoint(pool, request.appId, id);
    if (!found) throw new AppError(404, 'not_found', 'Endpoint not found');
    return reply.status(202).send({ replayed });
  });
}
