-- 001_init: core schema for Relay.
-- Approved in docs/plans/day1.md §2. PG >= 16 compatible: gen_random_uuid() is core,
-- no extensions. Status fields are text + CHECK (not enums) so later migrations can
-- change them easily. Ownership cascades: application -> endpoints / messages ->
-- deliveries -> attempts. No v1 API deletes anything; this is for admin/test cleanup.

-- ---------------------------------------------------------------------------
-- applications: a tenant. Every query is scoped by its id.
-- ---------------------------------------------------------------------------
CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- SHA-256 of the API key. UNIQUE doubles as the index for the auth lookup.
  api_key_hash  bytea NOT NULL UNIQUE CHECK (length(api_key_hash) = 32),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- endpoints: where an application wants events delivered.
-- ---------------------------------------------------------------------------
CREATE TABLE endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id               uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  url                  text NOT NULL CHECK (length(url) <= 2048),
  description          text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  -- '{}' = subscribed to all event types. NULL elements are forbidden so that
  -- `$type = ANY (event_types)` never has to reason about NULL.
  event_types          text[] NOT NULL DEFAULT '{}'
                       CHECK (array_position(event_types, NULL) IS NULL),
  secret               text NOT NULL CHECK (secret LIKE 'whsec\_%'),
  -- Disabled = paused: no fan-out, pending deliveries are skipped by the claim.
  disabled             boolean NOT NULL DEFAULT false,
  circuit_state        text NOT NULL DEFAULT 'closed'
                       CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  circuit_open_until   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT endpoints_open_circuit_has_expiry
    CHECK (circuit_state <> 'open' OR circuit_open_until IS NOT NULL),
  -- Redundant with the PK on its own, but required as the target of the composite
  -- FK from deliveries (endpoint_id, app_id).
  CONSTRAINT endpoints_id_app_id_key UNIQUE (id, app_id)
);
-- GET /v1/endpoints and the fan-out SELECT (WHERE app_id = $1).
CREATE INDEX endpoints_app_list_idx ON endpoints (app_id, created_at, id);

-- ---------------------------------------------------------------------------
-- messages: an event published once. messages.id is the webhook-id header.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  event_type       text NOT NULL CHECK (event_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  -- Must be a JSON object (Q3). The worker sends and signs exactly payload::text.
  payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key  text CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_id_app_id_key UNIQUE (id, app_id)   -- composite FK target
);
-- Idempotent publish: the arbiter index for ON CONFLICT. Partial, so messages without
-- a key never conflict with each other.
CREATE UNIQUE INDEX messages_idempotency_uq
  ON messages (app_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- GET /v1/messages keyset pagination: WHERE app_id = $1 AND (created_at, id) < (...)
CREATE INDEX messages_app_keyset_idx ON messages (app_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- deliveries: one message to one endpoint. THIS TABLE IS THE QUEUE.
-- ---------------------------------------------------------------------------
CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL,   -- denormalised for tenant-scoped queries without joins
  message_id       uuid NOT NULL,
  endpoint_id      uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'in_flight', 'succeeded', 'dead')),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),  -- +1 at claim
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),  -- claimable when <= now()
  locked_until     timestamptz,                         -- lease expiry (DB clock)
  lease_token      uuid,                                -- fencing token, fresh per claim
  locked_by        text,                                -- worker holding the lease
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,                         -- set on succeeded / dead
  -- One delivery per (message, endpoint). Leading column also serves WHERE message_id = $1.
  CONSTRAINT deliveries_message_endpoint_key UNIQUE (message_id, endpoint_id),
  -- Tenant integrity: a delivery's app_id MUST equal its message's and endpoint's app_id.
  CONSTRAINT deliveries_message_same_app_fk FOREIGN KEY (message_id, app_id)
    REFERENCES messages (id, app_id) ON DELETE CASCADE,
  CONSTRAINT deliveries_endpoint_same_app_fk FOREIGN KEY (endpoint_id, app_id)
    REFERENCES endpoints (id, app_id) ON DELETE CASCADE,
  -- Lease fields exist if and only if the row is in_flight. Clearing the token on every
  -- exit from in_flight means a stale worker's token can never match again.
  CONSTRAINT deliveries_lease_set_when_in_flight
    CHECK (status <> 'in_flight'
           OR (locked_until IS NOT NULL AND lease_token IS NOT NULL AND locked_by IS NOT NULL)),
  CONSTRAINT deliveries_lease_cleared_when_not_in_flight
    CHECK (status = 'in_flight'
           OR (locked_until IS NULL AND lease_token IS NULL AND locked_by IS NULL)),
  CONSTRAINT deliveries_completed_at_iff_terminal
    CHECK ((status IN ('succeeded', 'dead')) = (completed_at IS NOT NULL))
);
-- Claim query: ordered scan of due pending rows. Partial: only active rows are indexed.
CREATE INDEX deliveries_claim_idx ON deliveries (next_attempt_at) WHERE status = 'pending';
-- Sweeper: find expired leases.
CREATE INDEX deliveries_lease_idx ON deliveries (locked_until) WHERE status = 'in_flight';
-- Dead-letter view and POST /v1/endpoints/:id/replay-dead.
CREATE INDEX deliveries_dead_idx ON deliveries (endpoint_id, updated_at) WHERE status = 'dead';
-- GET /v1/deliveries?endpoint_id=...; also indexes the FK so cascades don't seq-scan.
CREATE INDEX deliveries_endpoint_idx ON deliveries (endpoint_id, created_at DESC, id DESC);
-- GET /v1/deliveries for the tenant.
CREATE INDEX deliveries_app_keyset_idx ON deliveries (app_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- delivery_attempts: append-only log, exactly one row per claim.
-- ---------------------------------------------------------------------------
CREATE TABLE delivery_attempts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id       uuid NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
  -- Attempt identity. UNIQUE: the worker and the sweeper can never both log one claim.
  lease_token       uuid NOT NULL UNIQUE,
  attempt_number    integer NOT NULL CHECK (attempt_number >= 1),  -- display only
  worker_id         text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),            -- DB clock
  duration_ms       integer CHECK (duration_ms >= 0),              -- NULL for lease_expired
  response_status   integer CHECK (response_status BETWEEN 100 AND 599),
  response_excerpt  text CHECK (length(response_excerpt) <= 1024),
  error_kind        text CHECK (error_kind IN
                      ('timeout', 'dns', 'connection', 'tls', 'ssrf_blocked',
                       'http_status', 'lease_expired')),
  error_message     text CHECK (length(error_message) <= 1024),
  -- Anything that is not a 2xx response must be classified.
  -- The explicit IS NOT NULL matters: a CHECK passes when its expression is NULL, and
  -- `NULL BETWEEN 200 AND 299` is NULL, so without it a row with neither a status nor
  -- an error_kind would be accepted (D30).
  CONSTRAINT delivery_attempts_failure_has_error_kind
    CHECK (error_kind IS NOT NULL
           OR (response_status IS NOT NULL AND response_status BETWEEN 200 AND 299))
);
-- GET /v1/deliveries/:id/attempts timeline; also the FK index for cascades.
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts (delivery_id, id);
