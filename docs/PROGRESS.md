# Relay — Progress Tracker

Status legend: [x] done · [ ] pending · [~] in progress · [-] cut / deferred

**Current milestone:** Day 0 — Setup and planning
**Next action:** Run the Day 1 Plan Mode prompt in Claude Code

---

## Day 0 — Setup and planning
- [x] Scope agreed (see "Scope" below)
- [ ] Node, Git, PostgreSQL installed and verified
- [ ] Databases `relay` and `relay_test` created
- [ ] Repo initialised; CLAUDE.md, docs/ARCHITECTURE.md, docs/PROGRESS.md committed
- [ ] GitHub remote added and first push done
- [ ] Day 1 plan produced in Plan Mode, reviewed and approved

## Day 1 — Foundation: schema, API, idempotent ingestion
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
- [ ] Claim query (SKIP LOCKED, lease, lease_token, batch)
- [ ] Result recording with fencing; attempt log rows
- [ ] Lease sweeper (expired in_flight -> pending)
- [ ] Worker loop: poll, bounded concurrency, graceful shutdown
- [ ] Tests: concurrent workers never double-claim; crash/lease recovery; stale-worker fencing; exhaustion -> dead
- **Done when:** a published message reaches a local receiver, failures retry on schedule, and concurrency tests pass.

## Day 3 — Resilience, replay, demo backend
- [ ] Circuit breaker (closed / open / half_open) wired into claim + result paths
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
multi-user accounts / RBAC, cloud deployment.

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

## Known limitations / blockers
- Docker/WSL2 not working on dev machine; Docker Compose deferred to Day 5 (validated in CI).
- Half-open circuit may allow a few concurrent probes (bounded by batch size); documented trade-off.

## Session log
| Date | Session | Outcome |
|---|---|---|
| | Day 0 | Starter files created |
