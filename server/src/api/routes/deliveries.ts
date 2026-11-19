import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { replayDeadForEndpoint, replayDelivery } from '../../deliveries/repo.js';
import { AppError } from '../errors.js';
import { parse } from '../validate.js';

const idParams = z.object({ id: z.guid() });

/** Routes under /v1 for deliveries and replay. `scope` is the authenticated /v1 plugin. */
export function registerDeliveryRoutes(scope: FastifyInstance, pool: pg.Pool): void {
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
