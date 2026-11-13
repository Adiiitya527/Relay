# Relay — Progress Tracker

Status legend: [x] done · [ ] pending · [~] in progress · [-] cut / deferred

**Current milestone:** Day 1 — Foundation
**Next action:** Day 1 step 1 (workspace scaffold + config) — see `docs/plans/day1.md`

---

## Day 0 — Setup and planning
- [x] Scope agreed (see "Scope" below)
- [x] Node, Git, PostgreSQL installed and verified (Node 26.13, PostgreSQL 18)
- [x] Databases `relay` and `relay_test` created (role `relay`)
- [x] Repo initialised; CLAUDE.md, docs/ARCHITECTURE.md, docs/PROGRESS.md committed
- [ ] GitHub remote added and first push done
- [x] Day 1 plan produced in Plan Mode, reviewed and approved (`docs/plans/day1.md`)

## Day 1 — Foundation: schema, API, idempotent ingestion
Plan: `docs/plans/day1.md` (9 steps, one commit each).
- [ ] npm workspaces scaffold (server, dashboard, mock-consumer), tsconfig, .gitignore, .gitattributes, .env.example
- [ ] Config module (Zod-validated env)
- [ ] Migration runner (schema_migrations table, one transaction per file, advisory lock)
- [ ] Migration 001: applications, endpoints, messages, deliveries, delivery_attempts
- [ ] `create-app` script (prints API key once, stores hash)
- [ ] API key auth hook (tenant scoping)
- [ ] Endpoints API: create / list / get / update / get-secret
- [ ] Messages API: publish (transactional fan-out + idempotency), list (keyset pagination), get
- [ ] Test harness: test DB, migrations in global setup, truncate per test
- [ ] Tests: auth, tenant isolation, fan-out by event type, idempotent publish
- **Done when:** publish creates correct delivery rows; all tests green; typecheck green.

## Day 2 — Delivery engine (most important day)
- [ ] Backoff function (exponential + jitter, cap, max attempts) + unit tests
- [ ] Standard Webhooks signing + unit tests (incl. verification helper)
- [ ] SSRF-safe HTTP client (validated DNS lookup, IP pinning, no redirects, timeout, response cap) + tests
- [ ] Claim query (SKIP LOCKED, lease, lease_token, LIMIT = free concurrency slots)
- [ ] Result recording with fencing; attempt log rows
- [ ] Lease sweeper (expired in_flight -> pending/dead, logs a `lease_expired` attempt)
- [ ] Worker loop: poll, bounded concurrency, graceful shutdown
- [ ] Tests: concurrent workers never double-claim; crash/lease recovery; stale-worker fencing; exhaustion -> dead
- **Done when:** a published message reaches a local receiver, failures retry on schedule, and concurrency tests pass.

## Day 3 — Resilience, replay, demo backend
- [ ] Circuit breaker (closed / open / half_open single probe) wired into claim + result paths
- [ ] Replay: single delivery, bulk replay of dead deliveries per endpoint
- [ ] Deliveries API: list with filters, attempts for a delivery
- [ ] Mock consumer: signature verification, modes (ok / fail / flaky / slow / timeout), duplicate detection, control endpoint
- [ ] `/healthz`; `/metrics` (Prometheus text format) if time allows
- [ ] End-to-end manual demo script works from the terminal
- **Done when:** kill consumer -> retries + circuit opens -> restore -> circuit closes -> replay DLQ works.

## Day 4 — Dashboard
- [ ] Vite + React + TS + Tailwind scaffold, Vite dev proxy to API
- [ ] API-key login (kept in memory / sessionStorage)
- [ ] Endpoints view (status, circuit state, create endpoint)
- [ ] Messages view + message detail (deliveries per endpoint)
- [ ] Delivery detail: attempt timeline (status code, duration, error kind)
- [ ] Dead-letter view with single + bulk replay
- [ ] Polling refresh (every ~3s)
- **Done when:** the full demo can be performed from the browser.

## Day 5 — Hardening and presentation (buffer day)
- [ ] Code review pass (race conditions, error handling, tenant scoping, SSRF)
- [ ] README: problem, architecture diagram, guarantees, how to run, demo walkthrough, limitations
- [ ] ADRs in docs/decisions/ for the key decisions below
- [ ] GitHub Actions CI: typecheck + tests with a Postgres service container
- [ ] Dockerfiles + docker-compose.yml (can be written and CI-validated even without local Docker)
- [ ] Demo recording / screenshots
- **Cut first if behind:** dashboard polish, /metrics, Dockerfiles. **Never cut:** tests.

---

## Scope
**In:** ingestion with idempotency, fan-out by event type, SKIP LOCKED worker with leases and
fencing, exponential backoff + jitter, DLQ, Standard Webhooks signing, SSRF protection, circuit
breaker, replay (single + bulk), attempt log, dashboard, mock consumer, integration tests, CI.

**Deferred (Future work in README):** ordered delivery per key, customer-facing consumer
portal, client SDKs, per-endpoint rate limiting, secret rotation with dual signatures,
encryption of secrets at rest, OpenTelemetry tracing, AI failure classification,
multi-user accounts / RBAC, cloud deployment, idempotency-key expiry, message retention /
cleanup, auto-disable endpoints on 410 Gone.

## Decisions log
| # | Decision | Why |
|---|---|---|
| D1 | PostgreSQL is both store and queue; no Redis/BullMQ | One durable system; atomic publish + enqueue; queue logic is our own, explainable code |
| D2 | Fastify instead of NestJS | Less boilerplate for a 5-day build; strong TS support |
| D3 | Plain SQL via `pg`, no ORM | Claim/lease/fencing SQL is the core engineering; must be explicit |
| D4 | API and worker: one codebase, two processes | Shared domain code, independent scaling |
| D5 | Leases + lease_token fencing for crash recovery | Recover from dead workers without double-writing results |
| D6 | At-least-once delivery, stable `webhook-id` | Exactly-once is impossible over HTTP; enable consumer dedupe |
| D7 | Standard Webhooks signature format | Industry spec; consumers can use existing verifiers |
| D8 | SSRF client built on node:http with validating `lookup` | Validates and pins resolved IPs (defeats DNS rebinding) with zero deps |
| D9 | Dashboard polls instead of WebSockets | Same demo value, no extra failure modes |
| D10 | Local PostgreSQL instead of Docker for now | WSL2 not working; env-based config keeps Docker Compose addable later |
| D11 | (R1) Claim `LIMIT` = free concurrency slots; `WORKER_BATCH_SIZE` removed; config enforces `LEASE_MS >= 2*HTTP_TIMEOUT_MS + 5000` | Lease clock and HTTP clock start together; queued-but-unstarted rows can't be swept and duplicated |
| D12 | (R2) Half-open is a real single-probe state, entered by one atomic `UPDATE endpoints … WHERE circuit_state='open' AND circuit_open_until<=now()` | Prevents a probe stampede that burns attempts and defeats invariant 9 |
| D13 | (R3) Attempt identity = `delivery_attempts.lease_token UNIQUE`; `attempt_number` is display-only | Replay resets `attempt_count`; one attempt row per claim, worker and sweeper can't double-log |
| D14 | (R4) Sweeper logs a `lease_expired` attempt; `deliveries.locked_by` records the lease holder | Crashed attempts are visible in the timeline, attributed to a worker |
| D15 | (R5) Composite FKs `(message_id, app_id)` / `(endpoint_id, app_id)` on deliveries | Cross-tenant delivery rows impossible at the DB level |
| D16 | (R6) Idempotency key reused with a different body → `409 idempotency_key_reused`; keys kept forever | Client bugs surface instead of silently returning the old message; expiry is future work |
| D17 | (R7) Publish: `INSERT … ON CONFLICT … DO NOTHING RETURNING`, then on 0 rows a follow-up `SELECT` in the same transaction | `DO NOTHING` returns no row on conflict; READ COMMITTED re-read sees the winner |
| D18 | (R8) API/worker pools set `statement_timeout` and `idle_in_transaction_session_timeout` | Postgres kills a leaked transaction instead of letting it block the queue (backs invariant 3) |
| D19 | (R9) `pool.on('error')` handler in the DB module | Idle-client errors on DB restart would otherwise crash Node |
| D20 | (R10) jsonb params always `JSON.stringify` + `$n::jsonb`; payload must be a JSON object (Zod + DB CHECK) | `pg` turns JS arrays into PG array literals; object payloads match Standard Webhooks consumers |
| D21 | (R11) Worker sends and signs exactly `payload::text` | Signature and body are the same bytes; jsonb normalises key order |
| D22 | (R12) Status fields are `text` + `CHECK`, not PG enums | Enums are awkward to change in migrations |
| D23 | (R13) Migration runner stores LF-normalised SHA-256 checksums and fails on mismatch; `.gitattributes` forces LF | Enforces "never edit an applied migration"; same checksum on Windows and CI |
| D24 | (R14) Disabled endpoints pause: no fan-out, pending rows skipped by claim, resume on re-enable; replays also paused | Disabling is reversible and loses nothing |
| D25 | (R15) `webhook-timestamp` is the one allowed use of the worker clock; durations use `performance.now()`; attempts use DB `recorded_at` | Spec requires send time; everything compared stays on the DB clock |
| D26 | (R16) Backoff + signing (pure functions) may move to Day 1 as stretch | Day 2 is overloaded |
| D27 | (A1) `createPool()` takes timeouts as options (env `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TX_TIMEOUT_MS`); migration runner uses its own connection with NO `statement_timeout` (tested) | Long migrations and `pg_advisory_lock` waits must not be cancelled |
| D28 | (A2) Tests with concurrent requests use a pool with `max >= 20` | Waiting transactions can't exhaust the pool and cause false failures |
| D29 | (A3) `engines.node >= 22.9`; scripts use `node --env-file-if-exists` | Flag needs 22.9; absent file is a no-op in Docker/CI |
| D30 | CHECK constraints on nullable columns must make the NULL case explicit (`x IS NOT NULL AND …`) | A CHECK passes when its expression is NULL; found by a step-3 test on `delivery_attempts` and fixed in 001 before it reached `relay` (only `relay_test` was reset) |

## Known limitations / blockers
- Docker/WSL2 not working on dev machine; Docker Compose deferred to Day 5 (validated in CI).
- Claim query filters open-circuit / disabled endpoints after the index scan, so a large paused
  backlog is rescanned each poll. Fine at demo scale; future fix: push `next_attempt_at` forward
  when a circuit opens.
- Keyset pagination uses `created_at = now()` (transaction start); a slow transaction can commit a
  row "behind" a page already read. Acceptable for the dashboard.
- Replaying a `succeeded` delivery reuses the same `webhook-id`; deduplicating consumers (and the
  mock consumer) will treat it as a duplicate. Intended; explained in the demo.
- Circuit-breaker updates hit the same endpoint row on every result; no-op writes are skipped to
  limit contention.
- JSON numbers beyond 2^53 lose precision when the API parses the body in JS.
- Endpoint signing secrets stored in plaintext (encryption at rest = future work).

## Session log
| Date | Session | Outcome |
|---|---|---|
| | Day 0 | Starter files created |
| 2026-11-11 | Day 1 planning | Architecture reviewed (R1–R16), schema + state machine finalised, plan approved with A1–A3; saved to `docs/plans/day1.md` |
