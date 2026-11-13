import type { Db } from '../db/pool.js';
import { generateEndpointSecret } from './secret.js';

/** What the API returns for an endpoint. Deliberately WITHOUT the secret. */
export interface EndpointView {
  id: string;
  url: string;
  description: string;
  event_types: string[];
  disabled: boolean;
  circuit_state: 'closed' | 'open' | 'half_open';
  circuit_open_until: Date | null;
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
}

// A fixed column list (a constant, never user input). `secret` is not in it, so list/get
// cannot leak it by accident; only createEndpoint and getEndpointSecret select it.
const VIEW_COLUMNS = `id, url, description, event_types, disabled, circuit_state,
  circuit_open_until, consecutive_failures, created_at, updated_at`;

export interface NewEndpoint {
  url: string;
  description: string;
  eventTypes: string[];
}

export async function createEndpoint(
  db: Db,
  appId: string,
  input: NewEndpoint,
): Promise<EndpointView & { secret: string }> {
  const { rows } = await db.query<EndpointView & { secret: string }>(
    `INSERT INTO endpoints (app_id, url, description, event_types, secret)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${VIEW_COLUMNS}, secret`,
    [appId, input.url, input.description, input.eventTypes, generateEndpointSecret()],
  );
  return rows[0]!;
}

/**
 * All endpoints of one application, oldest first. Not paginated: an application has few
 * endpoints (this is per tenant, not per message). Uses endpoints_app_list_idx.
 */
export async function listEndpoints(db: Db, appId: string): Promise<EndpointView[]> {
  const { rows } = await db.query<EndpointView>(
    `SELECT ${VIEW_COLUMNS} FROM endpoints WHERE app_id = $1 ORDER BY created_at, id`,
    [appId],
  );
  return rows;
}

// Every lookup by id ALSO filters by app_id (tenant isolation): another tenant's endpoint
// is indistinguishable from a missing one, so the API answers 404 for both.

export async function getEndpoint(db: Db, appId: string, id: string): Promise<EndpointView | undefined> {
  const { rows } = await db.query<EndpointView>(
    `SELECT ${VIEW_COLUMNS} FROM endpoints WHERE id = $1 AND app_id = $2`,
    [id, appId],
  );
  return rows[0];
}

export async function getEndpointSecret(db: Db, appId: string, id: string): Promise<string | undefined> {
  const { rows } = await db.query<{ secret: string }>(
    'SELECT secret FROM endpoints WHERE id = $1 AND app_id = $2',
    [id, appId],
  );
  return rows[0]?.secret;
}

export interface EndpointPatch {
  url?: string;
  description?: string;
  eventTypes?: string[];
  disabled?: boolean;
}

/**
 * Partial update with ONE static statement: each column is `COALESCE($n, column)`, so a
 * field left out (passed as NULL) keeps its current value. This works because none of
 * these columns may ever be NULL, so NULL can safely mean "not provided". It avoids
 * building SET clauses dynamically.
 *
 * Re-enabling (`disabled: false`) needs nothing else: paused pending deliveries become
 * claimable again because the claim query filters on `disabled` (decision Q1).
 */
export async function updateEndpoint(
  db: Db,
  appId: string,
  id: string,
  patch: EndpointPatch,
): Promise<EndpointView | undefined> {
  const { rows } = await db.query<EndpointView>(
    `UPDATE endpoints
        SET url         = COALESCE($3, url),
            description = COALESCE($4, description),
            event_types = COALESCE($5, event_types),
            disabled    = COALESCE($6, disabled),
            updated_at  = now()
      WHERE id = $1 AND app_id = $2
      RETURNING ${VIEW_COLUMNS}`,
    [
      id,
      appId,
      patch.url ?? null,
      patch.description ?? null,
      patch.eventTypes ?? null,
      patch.disabled ?? null,
    ],
  );
  return rows[0];
}
