# Day 1 Plan — Foundation: schema, API, idempotent ingestion

**Status:** approved 2026-11-11 (with answers Q1–Q8 and amendments A1–A3 applied).
**Scope:** workspace scaffold, config, migration runner, migration 001, `create-app`, API-key
auth, endpoints API, messages API with idempotent transactional fan-out, and their tests.
**Out of scope today:** the worker. Its SQL is specified here (§3) so the schema supports it,
but it is implemented on Day 2.

Future sessions: read `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`, then this
file. Work one step (§6) at a time; the per-step process is in §7.

---

## 1. Approved decisions (summary)

Review findings R1–R16 and amendments A1–A3 are logged as D11–D29 in `docs/PROGRESS.md`.
Answers to open questions:

| Q | Answer |
|---|---|
| Q1 Disabled endpoints | **Pause.** Publish does not fan out to disabled endpoints. Existing `pending` rows stay pending and are skipped by the claim; they resume when the endpoint is re-enabled. A replayed delivery for a disabled endpoint also stays paused. |
| Q2 Idempotency | Same key + same body → `200` + `Idempotent-Replayed: true`. Same key + different body → `409 idempotency_key_reused`. Keys are kept forever (expiry = future work). |
| Q3 Payload | Must be a JSON **object**. |
| Q4 PG version | Stay compatible with PG >= 16 (`gen_random_uuid()`, no `uuidv7()`). Local server is 18; CI tests on 16. |
| Q5 Schema additions | Approved: composite FKs, `UNIQUE lease_token` on attempts, `locked_by`, `lease_expired`, `recorded_at`, CHECK constraints instead of enums. |
| Q6 Claim sizing | Claim `LIMIT` = free concurrency slots. `WORKER_BATCH_SIZE` removed. |
| Q7 Local DB | Role `relay`, databases `relay` and `relay_test` exist (PG 18). Developer creates `.env` from `.env.example` after step 1. **Never print, read back or commit `.env`.** |
| Q8 Validation | Plain Zod `safeParse` via a small helper; no `fastify-type-provider-zod`. |

Amendments:
- **A1** `createPool()` takes timeouts as options. API and worker pools set
  `statement_timeout` and `idle_in_transaction_session_timeout`. The migration runner uses a
  dedicated connection with **no** `statement_timeout`, so long migrations and
  `pg_advisory_lock` waits are never cancelled. A test asserts this (`SHOW statement_timeout`
  on the runner's connection = `0`).
- **A2** Any test that makes concurrent requests uses a pool with `max >= 20`, so waiting
  transactions cannot exhaust the pool.
- **A3** Scripts use `--env-file-if-exists`, so `engines.node` is `">=22.9"`.

Config values for A1 come from env (invariant 10): `DB_STATEMENT_TIMEOUT_MS` (default 5000)
and `DB_IDLE_IN_TX_TIMEOUT_MS` (default 10000).

---

## 2. Final schema — migration 001

`schema_migrations` is owned by the runner (created by it, not by 001):

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,          -- filename, e.g. '001_init.sql'; applied set = done
  checksum    text NOT NULL,             -- sha256 of LF-normalised file; detects edited migrations
  applied_at  timestamptz NOT NULL DEFAULT now()
);
```

`server/migrations/001_init.sql`:

```sql
-- PG >= 16 compatible: gen_random_uuid() is core, no extensions needed.

CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),       -- tenant id; every query scopes by it
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  api_key_hash  bytea NOT NULL UNIQUE CHECK (length(api_key_hash) = 32),
                -- sha256(key); UNIQUE = the auth lookup index + no collisions; length check catches bugs
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id               uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  url                  text NOT NULL CHECK (length(url) <= 2048),     -- full validation in Zod + SSRF client
  description          text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  event_types          text[] NOT NULL DEFAULT '{}'
                       CHECK (array_position(event_types, NULL) IS NULL),
                       -- '{}' = subscribe to all; no NULL elements so `= ANY()` behaves predictably
  secret               text NOT NULL CHECK (secret LIKE 'whsec\_%'),  -- signing secret; format guard
  disabled             boolean NOT NULL DEFAULT false,               -- fan-out + claim skip (paused, Q1)
  circuit_state        text NOT NULL DEFAULT 'closed'
                       CHECK (circuit_state IN ('closed','open','half_open')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  circuit_open_until   timestamptz,                                  -- cooldown end (DB clock)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (circuit_state <> 'open' OR circuit_open_until IS NOT NULL), -- 'open' must have an expiry
  UNIQUE (id, app_id)            -- target of composite FKs from deliveries
);
CREATE INDEX endpoints_app_list_idx ON endpoints (app_id, created_at, id);
  -- GET /v1/endpoints and the fan-out SELECT (WHERE app_id = $1)

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- also the webhook-id header
  app_id           uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  event_type       text NOT NULL CHECK (event_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),  -- Q3; sent as payload::text
  idempotency_key  text CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, app_id)                                           -- composite FK target
);
CREATE UNIQUE INDEX messages_idempotency_uq
  ON messages (app_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  -- idempotent publish: arbiter for ON CONFLICT; partial so keyless messages never collide
CREATE INDEX messages_app_keyset_idx ON messages (app_id, created_at DESC, id DESC);
  -- GET /v1/messages keyset pagination

CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL,                     -- denormalised for tenant-scoped queries
  message_id       uuid NOT NULL,
  endpoint_id      uuid NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_flight','succeeded','dead')),
  attempt_count    integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),  -- incremented at claim
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),  -- when it becomes claimable
  locked_until     timestamptz,                         -- lease expiry (DB clock)
  lease_token      uuid,                                -- fencing token, fresh per claim
  locked_by        text,                                -- worker id holding the lease
  last_error       text,                                -- short summary for list views
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,                         -- when it reached succeeded/dead
  UNIQUE (message_id, endpoint_id),
    -- one delivery per (message, endpoint); leading column serves WHERE message_id = $1
  FOREIGN KEY (message_id, app_id)  REFERENCES messages  (id, app_id) ON DELETE CASCADE,
  FOREIGN KEY (endpoint_id, app_id) REFERENCES endpoints (id, app_id) ON DELETE CASCADE,
    -- a delivery's tenant MUST equal its message's and endpoint's tenant
  CHECK (status <> 'in_flight' OR (locked_until IS NOT NULL AND lease_token IS NOT NULL AND locked_by IS NOT NULL)),
  CHECK (status =  'in_flight' OR (locked_until IS NULL     AND lease_token IS NULL     AND locked_by IS NULL)),
    -- lease fields exist iff in_flight; clearing the token on exit makes stale tokens unmatchable
  CHECK ((status IN ('succeeded','dead')) = (completed_at IS NOT NULL))
);
CREATE INDEX deliveries_claim_idx ON deliveries (next_attempt_at) WHERE status = 'pending';
  -- claim query: ordered scan of due rows; only active rows indexed
CREATE INDEX deliveries_lease_idx ON deliveries (locked_until) WHERE status = 'in_flight';
  -- sweeper: find expired leases
CREATE INDEX deliveries_dead_idx ON deliveries (endpoint_id, updated_at) WHERE status = 'dead';
  -- DLQ view + POST /endpoints/:id/replay-dead
CREATE INDEX deliveries_endpoint_idx ON deliveries (endpoint_id, created_at DESC, id DESC);
  -- GET /v1/deliveries?endpoint_id=…; also indexes the FK so cascades don't seq-scan
CREATE INDEX deliveries_app_keyset_idx ON deliveries (app_id, created_at DESC, id DESC);
  -- GET /v1/deliveries for the tenant

CREATE TABLE delivery_attempts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- append-only, ordered log
  delivery_id       uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  lease_token       uuid NOT NULL UNIQUE,
    -- attempt identity: one row per claim; worker and sweeper can never both log the same claim
  attempt_number    integer NOT NULL CHECK (attempt_number >= 1),  -- attempt_count at claim; display only
  worker_id         text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),            -- DB clock
  duration_ms       integer CHECK (duration_ms >= 0),              -- NULL for lease_expired
  response_status   integer CHECK (response_status BETWEEN 100 AND 599),
  response_excerpt  text CHECK (length(response_excerpt) <= 1024),
  error_kind        text CHECK (error_kind IN
                     ('timeout','dns','connection','tls','ssrf_blocked','http_status','lease_expired')),
  error_message     text CHECK (length(error_message) <= 1024),
  CONSTRAINT delivery_attempts_failure_has_error_kind  -- non-success must be classified
    CHECK (error_kind IS NOT NULL
           OR (response_status IS NOT NULL AND response_status BETWEEN 200 AND 299))
    -- explicit IS NOT NULL: a CHECK passes on NULL, and NULL BETWEEN … is NULL (D30)
);
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts (delivery_id, id);
  -- GET /v1/deliveries/:id/attempts; also FK index for cascade
```

Notes vs. the reviewed plan:
- `messages.payload` gains `CHECK (jsonb_typeof(payload) = 'object')` to enforce Q3 at the
  database level as well as in Zod.
- In `server/migrations/001_init.sql`, table-level CHECKs and the composite FKs have explicit
  names (e.g. `deliveries_lease_set_when_in_flight`, `deliveries_endpoint_same_app_fk`) so
  errors are readable and tests can assert which constraint fired. Semantics unchanged.
- D30 (found by step 3 tests): the attempt CHECK originally read
  `error_kind IS NOT NULL OR response_status BETWEEN 200 AND 299`, which evaluates to NULL
  (= passes) when both are NULL. Fixed before 001 was ever applied to `relay`.

**Design notes**
- `ON DELETE CASCADE` follows ownership (application → endpoints/messages → deliveries →
  attempts). No v1 API deletes anything; "removing" an endpoint = `disabled = true`.
- Status fields are `text` + `CHECK`, not enums: easy to change in a later migration.
- No triggers: `updated_at` is set explicitly in each `UPDATE`.

---

## 3. Delivery state machine

States: `pending`, `in_flight`, `succeeded` (terminal), `dead` (terminal = DLQ).
"Paused" is not a state: a `pending` row whose endpoint is disabled or whose circuit is open
is simply not selected by the claim, and consumes no attempt (invariant 9).

| # | Transition | Performed by | Day |
|---|---|---|---|
| T0 | ∅ → pending | API publish (fan-out) | 1 |
| T1 | pending → in_flight | Worker claim | 2 |
| T2 | in_flight → succeeded | Worker record (2xx) | 2 |
| T3 | in_flight → pending / dead | Worker record (failure; CASE on attempts) | 2 |
| T4 | in_flight → pending / dead | Sweeper (lease expired) | 2 |
| T5 | dead / succeeded → pending | Replay (API) | 3 |

### T0 — publish fan-out (same transaction as the message insert, see step 7)
```sql
INSERT INTO deliveries (app_id, message_id, endpoint_id)
SELECT $1, $2, e.id
FROM endpoints e
WHERE e.app_id = $1
  AND NOT e.disabled
  AND (cardinality(e.event_types) = 0 OR $3 = ANY (e.event_types))
RETURNING id, endpoint_id, status;
```

### T1 — claim (one statement = one short transaction)
```sql
WITH due AS (
  SELECT d.id
  FROM deliveries d
  JOIN endpoints e ON e.id = d.endpoint_id
  WHERE d.status = 'pending'                 -- (a)
    AND d.next_attempt_at <= now()           -- (b)
    AND NOT e.disabled
    AND (e.circuit_state = 'closed'
         OR (e.circuit_state = 'open' AND e.circuit_open_until <= now()))  -- refined Day 3 (single probe)
  ORDER BY d.next_attempt_at                 -- (c)
  LIMIT $1                                   -- (d) = free concurrency slots
  FOR UPDATE OF d SKIP LOCKED                -- (e)
)
UPDATE deliveries d
SET status        = 'in_flight',
    locked_until  = now() + ($2 * interval '1 millisecond'),   -- (f) lease
    lease_token   = gen_random_uuid(),                          -- (g) fencing token
    locked_by     = $3,
    attempt_count = d.attempt_count + 1,                        -- (h)
    updated_at    = now()
FROM due
WHERE d.id = due.id
RETURNING d.id, d.message_id, d.endpoint_id, d.attempt_count, d.lease_token;
```
- (a, b) match the partial index `deliveries_claim_idx`. `now()` is the DB clock.
- (c) oldest-due first (fairness, not ordering).
- (d) claim only what can start immediately, so the lease clock and the HTTP clock start together.
- (e) `FOR UPDATE` row-locks the selected rows; `SKIP LOCKED` skips rows locked by another
  worker's claim instead of waiting, so N workers get disjoint sets. Under READ COMMITTED,
  Postgres re-checks the `WHERE` on the newest row version after locking, so a row another
  worker just committed as `in_flight` is dropped. `OF d` locks only deliveries; locking
  endpoint rows too would make `SKIP LOCKED` skip every delivery of an endpoint being claimed.
- (f) The HTTP call runs with no transaction open; the lease is the logical lock.
- (g) A fresh token per claim lets result writes prove "I am still the holder".
- (h) Counting at claim means a crash still consumes an attempt (poison payloads reach `dead`).

### T2 / T3 — fenced result write (short transaction: UPDATE first, attempt INSERT only if 1 row)
```sql
-- success
UPDATE deliveries
SET status='succeeded', completed_at=now(), last_error=NULL,
    locked_until=NULL, lease_token=NULL, locked_by=NULL, updated_at=now()
WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'
RETURNING id;

-- failure: retry or dead, decided atomically in SQL
UPDATE deliveries
SET status          = CASE WHEN attempt_count >= $3 THEN 'dead' ELSE 'pending' END,
    next_attempt_at = CASE WHEN attempt_count >= $3 THEN next_attempt_at
                           ELSE now() + ($4 * interval '1 millisecond') END,   -- $4 = backoff+jitter (pure TS)
    completed_at    = CASE WHEN attempt_count >= $3 THEN now() END,
    last_error = $5, locked_until=NULL, lease_token=NULL, locked_by=NULL, updated_at=now()
WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'
RETURNING status;

-- only if the UPDATE returned a row:
INSERT INTO delivery_attempts (delivery_id, lease_token, attempt_number, worker_id,
  duration_ms, response_status, response_excerpt, error_kind, error_message)
VALUES ($1, $2, $6, $7, $8, $9, $10, $11, $12);
```
Zero rows ⇒ lease lost: log a warning (delivery_id, lease_token), roll back, discard.
The fence is the **token, not the clock**: if our lease expired but nobody has swept yet, the
token still matches and our result is the most accurate one, so it is accepted.

### T4 — sweeper (any worker, every `SWEEP_INTERVAL_MS`; concurrency-safe)
```sql
WITH expired AS (
  SELECT id, lease_token, locked_by, attempt_count
  FROM deliveries
  WHERE status = 'in_flight' AND locked_until < now()
  ORDER BY locked_until LIMIT 100
  FOR UPDATE SKIP LOCKED
), upd AS (
  UPDATE deliveries d
  SET status       = CASE WHEN d.attempt_count >= $1 THEN 'dead' ELSE 'pending' END,
      completed_at = CASE WHEN d.attempt_count >= $1 THEN now() END,
      next_attempt_at = now(),   -- the lease duration already acted as the delay
      last_error = 'lease expired', locked_until=NULL, lease_token=NULL, locked_by=NULL, updated_at=now()
  FROM expired x WHERE d.id = x.id
  RETURNING d.id
)
INSERT INTO delivery_attempts (delivery_id, lease_token, attempt_number, worker_id, error_kind, error_message)
SELECT x.id, x.lease_token, x.attempt_count, x.locked_by, 'lease_expired',
       'worker lease expired before result was recorded'
FROM expired x JOIN upd USING (id);
```
`RETURNING` yields new values (token already NULL), so the old token/worker come from
`expired`. Worker-vs-sweeper race: both lock the row; the second to commit re-checks its
`WHERE` and matches 0 rows.

### T5 — replay (API, tenant-scoped)
```sql
UPDATE deliveries
SET status='pending', attempt_count=0, next_attempt_at=now(),
    completed_at=NULL, last_error=NULL, updated_at=now()
WHERE id = $1 AND app_id = $2 AND status IN ('dead','succeeded')
RETURNING id;
-- 0 rows → SELECT status … WHERE id=$1 AND app_id=$2:
--   missing → 404; pending/in_flight → 409 delivery_not_replayable
-- bulk: same SET, WHERE endpoint_id = $1 AND app_id = $2 AND status = 'dead'
```
History is preserved (attempts are keyed by `lease_token`). A replay for a disabled endpoint
stays paused until re-enabled (Q1). A replay of a `succeeded` delivery reuses the same
`webhook-id`, so deduplicating consumers will ignore it (documented, matches Svix).

### Half-open (Day 3, single probe)
When `circuit_open_until <= now()`, exactly one worker may enter half-open:
`UPDATE endpoints SET circuit_state='half_open', updated_at=now()
 WHERE id=$1 AND circuit_state='open' AND circuit_open_until<=now() RETURNING id`.
Only the winner claims one probe delivery; success → `closed`, failure → `open` again.
The final claim SQL for this is designed on Day 3.

---

## 4. Failure scenarios

| Scenario | What happens | Mechanism | Test (Day) |
|---|---|---|---|
| Worker crash **before** HTTP call | Row stays `in_flight` until lease expiry → sweeper → `pending` + `lease_expired` attempt (counted) | Lease + sweeper | `lease recovery: expired in_flight returns to pending with lease_expired attempt` — sets `locked_until = now() - 1s` directly (2) |
| Worker crash **after** HTTP call, before record | Same; consumer receives it twice with the same `webhook-id` and dedupes | At-least-once + stable `webhook-id` | `redelivery after lost result reuses webhook-id` (2) |
| Two workers claim simultaneously | Disjoint sets | `FOR UPDATE SKIP LOCKED` | `no double claim`: 200 pending rows, 8 concurrent claim loops on a pool with max >= 20 (A2); union = all, intersection = ∅ (2) |
| Lease expires during a slow request | Sweeper re-queues; worker B claims with new token; A's late write matches 0 rows | `lease_token` fencing | `stale worker cannot overwrite`: claim → sweep → re-claim → record with old token = 0 rows (2) |
| Duplicate publish (sequential) | Original returned, `200`, `Idempotent-Replayed: true`, no new deliveries | Partial unique index + `ON CONFLICT` | `idempotent publish returns original message` (1) |
| Duplicate publish (concurrent) | Exactly one wins; others wait on the unique index then read the winner | Unique-index lock + READ COMMITTED re-read | `10 parallel publishes, same key → 1 message, N deliveries, one 202 + nine 200` (pool max >= 20) (1) |
| Same key, different body | `409 idempotency_key_reused` | jsonb equality (order-insensitive) | `key reuse with different payload → 409` (1) |
| API crash mid-publish | Transaction rolls back; nothing enqueued | One transaction | `publish is atomic`: temporary trigger `RAISE`s on deliveries insert → zero messages (1) |
| Endpoint down for a long time | Circuit opens; deliveries wait without spending attempts; single half-open probe closes it | Circuit breaker | `open circuit: not claimed, attempt_count unchanged`; `half-open admits one probe`; `success closes` (3) |
| Endpoint permanently broken | Exhausted → `dead`; replay revives | Fenced CASE + replay | `exhaustion → dead`; `replay resets and redelivers` (2/3) |
| Database restart | API: in-flight queries → `503 database_unavailable`; pool reconnects; idle-client errors handled (no crash). Worker: claim fails → log + back off; record fails → lease expiry → redelivery | `pool.on('error')`, error mapping, lease | `survives terminated connections`: `pg_terminate_backend()` on app connections → next request succeeds (1 API / 2 worker) |
| Clock differences between machines | Queue unaffected: all comparisons use `now()`. Worker clock only sets `webhook-timestamp` (consumer checks it against its own clock with tolerance) | Invariant 7 + documented exception | `claim ignores worker clock`: `vi.setSystemTime(+1h)`; rows due in 10 min are not claimed (2) |
| Malicious URLs (localhost, 169.254.169.254, `[::ffff:127.0.0.1]`, DNS rebinding, redirect to internal) | Create time: scheme / userinfo / length rejected. Send time: SSRF client blocks the IP → `ssrf_blocked`; redirects never followed | SSRF client with validating `lookup` + IP pinning | IP classifier table tests; local server on 127.0.0.1 receives **zero** requests; injected resolver maps `evil.test` → 127.0.0.1; 302 not followed (1 create-time / 2 client) |
| Cross-tenant access | 404; cross-tenant delivery rows can't be inserted | `app_id` scoping + composite FKs | `tenant B cannot read/patch A's endpoint/message`; schema test: mismatched `app_id` → 23503 (1) |

---

## 5. Local PostgreSQL, test harness, Docker compatibility

- **Local DB (done):** role `relay`, databases `relay` and `relay_test` on PG 18. The developer
  writes `.env` from `.env.example`; Claude never reads, prints or commits it.
- **Env loading without dotenv:** scripts run
  `node --env-file-if-exists=../.env --import tsx src/…` (Node >= 22.9, A3). In Docker/CI the
  file is absent and real env vars apply. `vitest.config.ts` calls the built-in
  `process.loadEnvFile('../.env')` inside try/catch.
- **Harness:**
  1. `globalSetup` **safety guard**: refuse unless the `TEST_DATABASE_URL` database name ends in
     `_test` and differs from `DATABASE_URL` (protects dev data from `TRUNCATE`).
  2. `globalSetup` runs the **same migration runner** against `relay_test`.
  3. `fileParallelism: false` → files run sequentially (concurrency *within* a test is allowed).
  4. `beforeEach`: `TRUNCATE applications, endpoints, messages, deliveries, delivery_attempts
     RESTART IDENTITY CASCADE` (never `schema_migrations`).
  5. HTTP tests: `buildApp({ config, pool, logger })` + `app.inject()`; no port opened.
  6. Tests with concurrent requests/claims use a pool with `max >= 20` (A2).
  7. Migration-runner tests use a scratch schema (`options: '-c search_path=mig_test'`) +
     fixtures dir, then `DROP SCHEMA mig_test CASCADE` — inside `relay_test` only.
- **Docker-compatible:** env-only config, API binds `0.0.0.0`, no Windows paths (paths via
  `node:path` + `import.meta.dirname`), no shell syntax like `VAR=x cmd` in npm scripts,
  `.gitattributes` forces LF, SQL runs on PG >= 16 (CI service container `postgres:16`).

---

## 6. Implementation steps (one commit each)

Allowed dependencies only: root dev `typescript`; `server` runtime `fastify zod pg pino`;
`server` dev `tsx vitest @types/node @types/pg`. Nothing for `dashboard`/`mock-consumer` today.

### Step 1 — `chore: scaffold npm workspaces and Zod-validated config`
- Files: root `package.json` (workspaces, `engines.node ">=22.9"`, `typecheck` =
  `npm run typecheck --workspaces --if-present`, `test`), `tsconfig.base.json` (strict, `NodeNext`,
  `noUncheckedIndexedAccess`), `.gitignore` (incl. `.env`), `.gitattributes` (`* text=auto eol=lf`),
  `.env.example`; `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`,
  `server/src/config.ts`, `server/test/unit/config.test.ts`; placeholder
  `dashboard/package.json`, `mock-consumer/package.json`.
- Installs: `npm install -D typescript` (root);
  `npm install -w server fastify zod pg pino`;
  `npm install -w server -D tsx vitest @types/node @types/pg`.
- Behaviour: Zod schema for every var in ARCHITECTURE §9; refinement
  `LEASE_MS >= 2 * HTTP_TIMEOUT_MS + 5000`; strict boolean parsing (`"true"`/`"false"` only —
  `z.coerce.boolean()` would turn `"false"` into `true`); pure `loadConfig(env)`.
- Verify: `npm install`; `npm test -w server` (defaults, bad port rejected, `"false"` → false,
  lease refinement); `npm run typecheck`. Then the developer creates `.env`.

### Step 2 — `feat(db): add pg pool and migration runner with checksum and advisory lock`
- Files: `server/src/db/pool.ts`, `server/src/db/migrate.ts`, `server/src/scripts/migrate.ts`,
  `server/test/db/migrate.test.ts`, `server/test/fixtures/migrations/…`.
- `createPool({ connectionString, max?, statementTimeoutMs?, idleInTxTimeoutMs? })` (A1):
  passes the timeouts to `pg` as `statement_timeout` / `idle_in_transaction_session_timeout`;
  registers `pool.on('error')` (logs, never crashes).
- Runner: own `pg.Client` with **no** `statement_timeout` (A1, commented + tested) →
  `pg_advisory_lock(<const>)` → create `schema_migrations` → for each `NNN_*.sql` in order:
  applied ⇒ compare checksum (fail on mismatch); else `BEGIN; <file>; INSERT schema_migrations;
  COMMIT` → `pg_advisory_unlock` in `finally`.
- Verify: tests (scratch schema): applies once; second run no-op; checksum mismatch fails;
  broken file rolls back with earlier files kept; runner connection reports
  `statement_timeout = 0`. Then `npm run migrate -w server` against `relay`.

### Step 3 — `feat(db): add migration 001 schema and integration test harness`
- Files: `server/migrations/001_init.sql` (§2), `server/test/global-setup.ts` (guard + migrate),
  `server/test/helpers/db.ts` (test pool, truncate, fixture builders),
  `server/test/db/schema.test.ts`.
- Verify: schema tests — invalid status → 23514; cross-tenant delivery → 23503; duplicate
  `(message_id, endpoint_id)` → 23505; duplicate idempotency key per app → 23505 but same key in
  another app OK; `in_flight` without lease → 23514; non-object payload → 23514.
  Inspect with `psql … -c '\d deliveries'`.

### Step 4 — `feat: add API key generation and create-app script`
- Files: `server/src/auth/api-keys.ts`, `server/src/scripts/create-app.ts`,
  `server/test/unit/api-keys.test.ts`, `server/test/scripts/create-app.test.ts`.
- Key format `rly_` + base64url(32 random bytes). Pure `generateApiKey()`, `hashApiKey()`
  (SHA-256 → Buffer). `createApplication(pool, name)` inserts the hash; the script prints the key once.
- Verify: unit + integration tests; `npm run create-app -w server -- demo`; in psql
  `api_key_hash` is 32 bytes and not the key.

### Step 5 — `feat(api): add Fastify app factory, error handler, auth hook and healthz`
- Files: `server/src/api/app.ts` (`buildApp({ config, pool, logger })`, `bodyLimit` from
  `MAX_PAYLOAD_BYTES`), `server/src/api/errors.ts` (`AppError`; `{error:{code,message}}`;
  Zod → 400 `validation_failed`; pg connection errors → 503 `database_unavailable`),
  `server/src/api/validate.ts` (`parse(schema, data)`), `server/src/api/auth.ts`,
  `server/src/api/routes/health.ts`, `server/src/server.ts` (listen; SIGINT/SIGTERM →
  `app.close()` → `pool.end()`), `dev:api` script.
- Auth on `/v1`: parse `Bearer`, hash, `SELECT id FROM applications WHERE api_key_hash = $1`,
  set `request.appId`. Missing / malformed / unknown → identical 401 `unauthorized`.
- Verify: tests for the three 401 cases, valid key, `/healthz` ok and 503 after
  `pg_terminate_backend`; `npm run dev:api -w server` + `curl localhost:3000/healthz`.

### Step 6 — `feat(api): add endpoints CRUD and secret reveal`
- Files: `server/src/api/routes/endpoints.ts`, `server/src/endpoints/{repo,secret,url}.ts`,
  `server/test/api/endpoints.test.ts`.
- Secret `whsec_` + base64(24 random bytes); returned on create and `GET /:id/secret`, never in
  list/get. Create-time URL check: `https:` (or `http:` if `ALLOW_HTTP_ENDPOINTS`), no userinfo,
  ≤ 2048 chars. PATCH: `url`, `description`, `event_types`, `disabled`. Every query has
  `AND app_id = $n`.
- Verify: tests for create/list/get/patch/secret; secret absent from list/get; http rejected by
  default; userinfo rejected; bad uuid param → 400; tenant B → 404 on A's endpoint
  (get/patch/secret).

### Step 7 — `feat(api): add idempotent publish with transactional fan-out`
- Files: `server/src/messages/publish.ts`, `server/src/api/routes/messages.ts` (POST),
  `server/test/api/publish.test.ts`.
- Zod body `{ event_type, payload: object }`; optional `Idempotency-Key` header
  (1–255 printable ASCII). Flow on one pooled client:
  ```
  BEGIN
  INSERT INTO messages (app_id, event_type, payload, idempotency_key)
    VALUES ($1,$2,$3::jsonb,$4)              -- $3 = JSON.stringify(payload): pg would turn JS arrays into PG arrays
    ON CONFLICT (app_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id, created_at
  ├─ 1 row  → T0 fan-out INSERT … SELECT → COMMIT → 202 { message, deliveries }
  └─ 0 rows → SELECT id, (event_type=$2 AND payload=$3::jsonb) AS same FROM messages
              WHERE app_id=$1 AND idempotency_key=$4
              → COMMIT → same ? 200 + Idempotent-Replayed: true : 409 idempotency_key_reused
  any error → ROLLBACK; client.release() in finally
  ```
  The `WHERE` after `ON CONFLICT (…)` is required to infer the partial unique index.
  Concurrent same key: the second INSERT blocks on the first's uncommitted index entry; after
  commit, `DO NOTHING` returns 0 rows and the follow-up SELECT (new snapshot under READ
  COMMITTED) sees the winner. If the first rolls back, the second inserts.
- Verify: fan-out (`[]` = all, specific match, non-match), disabled excluded (Q1), zero endpoints
  → 202 with none, sequential + 10-concurrent idempotency (pool max >= 20), 409 mismatch, same
  key in two apps, atomicity via trigger, oversized payload → 413, non-object payload → 400.

### Step 8 — `feat(api): add message list with keyset pagination and message detail`
- Files: same routes file, `server/src/messages/query.ts`, `server/test/api/messages-read.test.ts`.
- `GET /v1/messages?limit=&cursor=`; opaque base64url cursor of `created_at|id`;
  `WHERE app_id=$1 AND (created_at, id) < ($2,$3) ORDER BY created_at DESC, id DESC LIMIT $4+1`
  (the extra row signals a next page). `GET /v1/messages/:id` → message + deliveries.
- Verify: 25 messages paged by 10 with no gaps/dupes (incl. identical `created_at` from one
  transaction); tampered cursor → 400; tenant 404; detail includes deliveries.

### Step 9 — `docs: record Day 1 progress, decisions and commands`
- Tick `docs/PROGRESS.md`, session log, CLAUDE.md commands, ARCHITECTURE corrections found
  during implementation.
- Verify: `npm test -w server` and `npm run typecheck` green.

**Stretch (only if early):** pure `backoff.ts` and `signing.ts` with unit tests.

---

## 7. Per-step process

1. Before editing, list the files to create/change (2–3 lines).
2. Implement the step with its tests. Show each `npm install` command before running it.
3. Run `npm test -w server` and `npm run typecheck`; show results.
4. Briefly explain the important parts (SQL, concurrency, security) and how to verify manually.
5. Propose the commit command, then **stop and wait for "continue"**.
6. If the plan turns out to be wrong, stop and say so — never work around it silently.
