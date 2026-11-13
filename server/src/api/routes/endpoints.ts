import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import {
  createEndpoint,
  getEndpoint,
  getEndpointSecret,
  listEndpoints,
  updateEndpoint,
} from '../../endpoints/repo.js';
import { endpointUrlSchema } from '../../endpoints/url.js';
import { eventTypeSchema } from '../../events/event-type.js';
import { AppError } from '../errors.js';
import { parse } from '../validate.js';

const MAX_EVENT_TYPES = 100;

/** [] = subscribed to every event type. Duplicates are dropped (order kept). */
const eventTypesSchema = z
  .array(eventTypeSchema)
  .max(MAX_EVENT_TYPES)
  .transform((types) => [...new Set(types)]);

const descriptionSchema = z.string().max(500); // matches the DB CHECK

// z.guid(): any 8-4-4-4-12 hex string, i.e. exactly what Postgres' uuid type accepts.
// Validating here turns "/v1/endpoints/abc" into a 400 instead of a Postgres 22P02 → 500.
const idParams = z.object({ id: z.guid() });

const notFound = () => new AppError(404, 'not_found', 'Endpoint not found');

/** Routes under /v1/endpoints. `scope` is the authenticated /v1 plugin (request.appId is set). */
export function registerEndpointRoutes(scope: FastifyInstance, db: Db, config: Config): void {
  const urlSchema = endpointUrlSchema(config.security.allowHttpEndpoints);

  // strictObject: unknown keys are a 400, so a typo ("event_type") or an attempt to set a
  // server-owned field ("secret", "circuit_state") fails loudly instead of being ignored.
  const createBody = z.strictObject({
    url: urlSchema,
    description: descriptionSchema.default(''),
    event_types: eventTypesSchema.default([]),
  });
  const patchBody = z
    .strictObject({
      url: urlSchema.optional(),
      description: descriptionSchema.optional(),
      event_types: eventTypesSchema.optional(),
      disabled: z.boolean().optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), {
      message: 'at least one field is required',
    });

  // POST /v1/endpoints → 201 with the endpoint AND its secret (the caller needs it to
  // verify signatures; it can be fetched again later via /secret).
  scope.post('/endpoints', async (request, reply) => {
    const body = parse(createBody, request.body, 'body');
    const endpoint = await createEndpoint(db, request.appId, {
      url: body.url,
      description: body.description,
      eventTypes: body.event_types,
    });
    return reply.status(201).send(endpoint);
  });

  scope.get('/endpoints', async (request) => {
    return { data: await listEndpoints(db, request.appId) };
  });

  scope.get('/endpoints/:id', async (request) => {
    const { id } = parse(idParams, request.params, 'params');
    const endpoint = await getEndpoint(db, request.appId, id);
    if (!endpoint) throw notFound();
    return endpoint;
  });

  scope.patch('/endpoints/:id', async (request) => {
    const { id } = parse(idParams, request.params, 'params');
    const body = parse(patchBody, request.body, 'body');
    const updated = await updateEndpoint(db, request.appId, id, {
      url: body.url,
      description: body.description,
      eventTypes: body.event_types,
      disabled: body.disabled,
    });
    if (!updated) throw notFound();
    return updated;
  });

  // Separate route so the secret is only ever returned when explicitly asked for, and is
  // never part of list/get responses (which a dashboard renders and might cache).
  scope.get('/endpoints/:id/secret', async (request, reply) => {
    const { id } = parse(idParams, request.params, 'params');
    const secret = await getEndpointSecret(db, request.appId, id);
    if (secret === undefined) throw notFound();
    // Tell browsers and proxies not to store the response.
    return reply.header('cache-control', 'no-store').send({ secret });
  });
}
