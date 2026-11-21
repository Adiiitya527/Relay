# Relay — Progress Tracker

Status legend: [x] done · [ ] pending · [~] in progress · [-] cut / deferred

**Current milestone:** Day 5 complete — v1 feature-complete
**Next action (yours):** record the demo / screenshots. CI's Docker stack + end-to-end demo job
passed on its first run; the test jobs (Node 22/24) failed at the mock consumer step until
22ff218. CI is green on 22ff218 (all three jobs, run 4).

---

## Day 0 — Setup and planning
- [x] Scope agreed (see "Scope" below)
- [x] Node, Git, PostgreSQL installed and verified (Node 26.13, PostgreSQL 18)
- [x] Databases `relay` and `relay_test` created (role `relay`)
- [x] Repo initialised; CLAUDE.md, docs/ARCHITECTURE.md, docs/PROGRESS.md committed
- [x] GitHub remote added and first push done (yours)
- [x] Day 1 plan produced in Plan Mode, reviewed and approved (`docs/plans/day1.md`)

## Day 1 — Foundation: schema, API, idempotent ingestion
Plan: `docs/plans/day1.md` (9 steps, one commit each).
- [x] npm workspaces scaffold (server, dashboard, mock-consumer), tsconfig, .gitignore, .gitattributes, .env.example
- [x] Config module (Zod-validated env)
- [x] Migration runner (schema_migrations table, one transaction per file, advisory lock)
- [x] Migration 001: applications, endpoints, messages, deliveries, delivery_attempts
- [x] `create-app` script (prints API key once, stores hash)
- [x] API key auth hook (tenant scoping)
- [x] Endpoints API: create / list / get / update / get-secret
- [x] Messages API: publish (transactional fan-out + idempotency), list (keyset pagination), get
- [x] Test harness: test DB, migrations in global setup, truncate per test
- [x] Tests: auth, tenant isolation, fan-out by event type, idempotent publish
- [-] Stretch: backoff + signing pure functions → moved to Day 2
- **Done when:** publish creates correct delivery rows; all tests green; typecheck green.
  **Met:** 274 tests in 16 files pass; typecheck clean (commit `45c6753`).

## Day 2 — Delivery engine (most important day)
- [x] Day 2 plan produced in Plan Mode, reviewed and approved (`docs/plans/day2.md`)
- [x] Backoff function (exponential + jitter, cap, max attempts) + unit tests
- [x] Standard Webhooks signing + unit tests (incl. verification helper)
- [x] SSRF-safe HTTP client (validated DNS lookup, IP pinning, no redirects, timeout, response cap) + tests
- [x] Claim query (SKIP LOCKED, lease, lease_token, LIMIT = free concurrency slots)
- [x] Result recording with fencing; attempt log rows
- [x] Lease sweeper (expired in_flight -> pending/dead, logs a `lease_expired` attempt)
- [x] Worker loop: poll, bounded concurrency, graceful shutdown
- [x] Tests: concurrent workers never double-claim; crash/lease recovery; stale-worker fencing; exhaustion -> dead
- **Done when:** a published message reaches a local receiver, failures retry on schedule, and concurrency tests pass.
- Met: 482 tests in 26 files (end-to-end worker tests publish through the API and deliver to local receivers).

## Day 3 — Resilience, replay, demo backend
Plan: `docs/plans/day3.md` (short plan, steps 0–7, two sessions).
- [x] Circuit breaker (closed / open / half_open single probe) wired into claim + result paths
- [x] Replay: single delivery, bulk replay of dead deliveries per endpoint
- [x] Deliveries API: list with filters, single delivery, attempts for a delivery
- [x] Mock consumer: signature verification, modes (ok / fail / flaky / slow / timeout), duplicate detection, control endpoint
- [x] `/healthz` (Day 1); `/metrics` (Prometheus text format)
- [x] End-to-end demo script works from the terminal (`npm run demo -w server`)
- **Done when:** kill consumer -> retries + circuit opens -> restore -> circuit closes -> replay DLQ works.
  **Met:** the demo does exactly this and is itself tested end to end. 539 server tests in 32
  files + 20 mock-consumer tests pass; typecheck clean.

## Day 4 — Dashboard
Plan: `docs/plans/day4.md` (short plan, steps 0–6, one session).
- [x] Vite + React + TS + Tailwind scaffold, Vite dev proxy to API
- [x] API-key login (sessionStorage, memory fallback; validated before storing)
- [x] Endpoints view (status, circuit state, create endpoint, reveal secret, enable/disable, replay dead)
- [x] Messages view + message detail (deliveries per endpoint) + "Send test event"
- [x] Delivery detail: attempt timeline (status code, duration, error kind, excerpt, replay boundaries)
- [x] Dead-letter view with single + bulk replay (no `Content-Type` on body-less POSTs, D62)
- [x] Polling refresh (every 3 s, paused while hidden, no overlapping requests)
- **Done when:** the full demo can be performed from the browser.
  **Met (pending your walkthrough):** every API call the views make passed a live check through
  the Vite proxy, and is pinned by a contract test. 546 server + 20 mock-consumer + 109
  dashboard tests; typecheck and production build clean.

## Day 5 — Hardening and presentation (buffer day)
Plan: `docs/plans/day5.md` (short plan, steps 0–7, sessions 6–7).
- [x] Code review pass (race conditions, error handling, tenant scoping, SSRF): 2 bugs fixed (D69, D70)
- [x] README: problem, architecture diagram, guarantees, how to run, demo walkthrough, limitations
- [x] ADRs in docs/decisions/ for the key decisions (0001–0008)
- [x] GitHub Actions CI: typecheck + tests with a Postgres service container (written; runs after the first push)
- [x] Dockerfiles + docker-compose.yml, validated by a CI job that runs the demo inside the stack (D72)
- [x] Production build: compiled JavaScript, no tsx at runtime (D71)
- [ ] Demo recording / screenshots (yours)
- **Met:** 557 server + 20 mock-consumer + 109 dashboard tests; typecheck, dashboard and server
  builds clean. Pending only the first CI run and the recording.
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
| D31 | Every multi-statement transaction goes through `withTransaction()` (`src/db/tx.ts`), which listens for `'error'` on the checked-out client and destroys broken clients | pg-pool removes its error listener from a checked-out client; a connection dying mid-transaction would otherwise be an unhandled `'error'` event and crash the process (verified by a negative-control test). Extends D19 |
| D32 | 503 `database_unavailable` (+ `Retry-After: 5`) covers connection errors AND `57014` statement timeout and `53300` too many connections | All mean "retry later", not "bug"; 500 is reserved for real bugs |
| D33 | Message-list cursor = base64url of `<created_at epoch µs>\|<id>`, computed in SQL, never via a JS `Date` | Postgres has µs precision, `Date` only ms: a ms cursor silently skips rows in the same millisecond (verified by a negative-control test). Unsigned: every query is scoped by `app_id` |
| D34 | Valid JSON that jsonb cannot store (`\u0000`, unpaired surrogate; SQLSTATE 22P05 / 22P02) → 400 `validation_failed` | It is the client's input, not a server fault |
| D35 | Auth runs in `onRequest` (before body parsing); missing / malformed / unknown key → identical 401 + `WWW-Authenticate: Bearer`; DB error during auth → 503, never 401 | No body buffering for anonymous callers; no key-probing signal; outages don't look like bad keys |
| D36 | Request bodies and list query strings are strict: unknown fields → 400 | Typos (`event_type` vs `event_types`) and attempts to set server-owned fields (`secret`, `circuit_state`) fail loudly |
| D37 | Secret returned only on create and `GET /v1/endpoints/:id/secret` (`Cache-Control: no-store`); message list and publish responses omit payloads | Secrets never in list/get views; avoids 25 MB list pages |
| D38 | Endpoint URLs stored WHATWG-normalised; the 2048-char limit applies to the normalised form | The stored form is what the worker requests; normalising can lengthen a URL |
| D39 | JSON with `__proto__` or `constructor.prototype` → 400 `invalid_json` (`onConstructorPoisoning: 'error'`); parser messages never echoed | Prototype-pollution input is never legitimate; V8 parse errors quote the body |
| D40 | Plan correction (step 5): `pg_terminate_backend` on idle pool connections does NOT make `/healthz` 503 — the pool drops them and recovers. Tested as "recovers without restart"; 503 tested with an unreachable DB | The plan's expectation was wrong; both behaviours are now pinned by tests |
| D41 | Any destination port is allowed (replaces "default ports unless configured") | IP blocking is the protection; real consumers use :8443 etc. |
| D42 | A hostname is blocked if ANY resolved address is blocked (no filtering) | A mixed answer is an attack signal; filtering invites games with ordering/family |
| D43 | IP-literal URLs are classified before the request | Node's `net.connect` never calls `lookup` for IP literals; without it `http://127.0.0.1/` passed (negative control: 5 tests failed) |
| D44 | IPv4: block list of special ranges. IPv6: allow list (`2000::/3` minus documentation, 6to4, Teredo); IPv4-mapped and NAT64 judged by the embedded IPv4. Implemented with integer arithmetic, not `BlockList` | Fail closed; the URL parser writes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`; signed bit-shifts break at 128.0.0.0 |
| D45 | Claim `RETURNING` includes `payload::text AS body, url, secret` (`UPDATE … FROM`) | One round trip; the body is serialised once and is exactly what is signed |
| D46 | Response excerpt / error message: UTF-8 decoded, `\u0000` stripped, ≤ 1024 code points | Postgres text rejects NUL; an unstorable excerpt would fail every record → endless redelivery |
| D47 | Outcome decided by the status line; the 1 KB excerpt is best-effort within the same deadline; socket destroyed after | A slow or huge body cannot change or delay the outcome |
| D48 | `agent: false` per request | No socket reuse across deliveries; every connection passes the validating lookup |
| D49 | Logs carry delivery/message/endpoint ids, never the URL or secret | Webhook URLs often embed tokens |
| D50 | Backoff caps the base delay, then applies ±20 % jitter (max real delay 1.2 × cap) | Clamping after jitter would re-synchronise retries at the cap |
| D51 | Plan correction (step 5): removing only `SKIP LOCKED` does NOT cause double claims; the `FOR UPDATE` row lock + WHERE re-check does. Both halves are now pinned: double-claim test (fails without the row lock: 596 claims for 200 rows) and a no-wait test (hangs without `SKIP LOCKED`) | The plan's negative control assumed the wrong mechanism |
| D52 | A response status outside 100–599 is a failure (`http_status`) recorded without `response_status` | llhttp accepts any 3-digit status; the DB CHECK would reject it and the record would fail forever |
| D53 | `recordResult` returns the outcome (`succeeded / retrying / dead / lease_lost`); `deliverOne` does the logging | Queue SQL stays free of logging; one place formats delivery logs |
| D54 | The normal claim takes only `closed` endpoints. A separate probe claim runs first: lock cooled-down endpoints `FOR UPDATE SKIP LOCKED`, promote to `half_open`, claim one due delivery each (`LATERAL … LIMIT 1`). Refines D12 | The endpoint row lock is what guarantees a single probe; one statement keeps it to one round trip |
| D55 | `half_open` carries a probe deadline: `circuit_open_until = now() + LEASE_MS`; an expired one makes the endpoint a candidate again | Without it, a crashed or `lease_lost` probe would leave the endpoint in `half_open` forever |
| D56 | Circuit updated inside `recordResult`'s transaction, after the attempt row; lock order delivery → endpoint; `lease_lost` leaves the circuit alone | The circuit always agrees with the attempt log; the probe claim never waits, so no deadlock |
| D57 | Test correction (step 1): "8 concurrent claimers → 1 probe" still passed with the candidates lock removed (the race window is too short to hit). Added a test that holds one probe claim's transaction open while another claims; it fails without the lock | Same lesson as D51: a negative control must prove the test can fail |
| D58 | Replay → 202 `{ delivery }` / `{ replayed }`; only `dead` / `succeeded`; `409 delivery_not_replayable` otherwise; status checked in the `UPDATE`'s `WHERE` | Atomic under concurrent replays (one 202, one 409, tested); never fights a worker's lease |
| D59 | Added `GET /v1/deliveries/:id`; the µs cursor moved to `server/src/db/cursor.ts`; list filters are one statement with `($n IS NULL OR …)` | The dashboard needs a delivery view; `EXPLAIN` confirmed the folded plans use the right indexes |
| D60 | Mock consumer is plain JS + JSDoc (`tsc --checkJs`), tested with `node:test`; verifier shares no code with `server/`. Duplicate = re-send of an id already answered 2xx; re-send after a failure = retry | Zero dependencies, runs with bare `node`; independent verifier proves interoperability (broken-verifier control fails the interop test) |
| D61 | `/metrics`: read from Postgres per scrape, aggregate-only, unauthenticated, only partially indexed statuses (no `succeeded`); 503 when the DB is down | One source of truth; no tenant leak or label explosion; scrape cost independent of history size (index-only scans) |
| D62 | Demo script drives running processes over HTTP, creates its own application in the DB, derives wait limits from config; sends `Content-Type` only with a body | Realistic customer path; found that an empty body declared as JSON is a 400 (kept; documented for the dashboard) |
| D63 | Dashboard without router / state / data-fetching libraries: hash router, a poller and a paged-list hook | Six views; the libraries would be most of the bundle and most of the concepts (ARCHITECTURE §7) |
| D64 | Dashboard tests cover pure logic only (no jsdom / Testing Library); views stay thin | Agreed 2026-11-19: no unlisted dependencies; logic that can break is in tested modules |
| D65 | API key in `sessionStorage` (memory fallback), checked before storing, never in URLs or logs; any 401 logs out | Tab-scoped; a revoked key cannot leave a half-working UI |
| D66 | Vite dev proxy for `/v1`, `/healthz`, `/metrics`; config reads only `DASHBOARD_*` from the repo `.env`; dashboard requires Node ≥ 22.12 (Vite 8) | One origin, no CORS; no server secret can reach the bundle |
| D67 | Paged lists: every fetched page is authoritative for the range it covers | Polling + "Load more" otherwise loses rows when pages shift or keeps replayed rows in the DLQ |
| D68 | Contract test (`server/test/api/dashboard-contract.test.ts`) runs the dashboard's real API client against the real API | API changes that break the dashboard fail the server suite, not the browser |
| D69 | The migration runner's own `pg.Client` gets an `'error'` listener; the advisory unlock in `finally` is best effort | A connection killed mid-migration crashed the process (uncaught ECONNRESET), and the failing unlock replaced the real `MigrationError`; the session ending releases the lock anyway. Found by the Day 5 review, pinned by a test |
| D70 | One `createLogger()` for every process: Authorization redaction plus an `err` serializer that drops PostgreSQL `detail` / `where` / `internalQuery` (also from causes) | A constraint error's `detail` is the whole failing row (payloads, response excerpts). Negative control: without the serializer the row reaches the log |
| D71 | Production runs `server/dist` compiled by `tsconfig.build.json` (`start:api`, `start:worker`, `migrate:prod`) | Runtime images need only node and production dependencies; tested by running the compiled entry points |
| D72 | Docker: one server image (migrate / API / worker / demo); nginx serves the dashboard and proxies `/v1` (same origin, upstream from env, CSP, `/metrics` not forwarded); compose enables the private-network flags only for its own network. Validated in CI by running the demo inside the stack | Docker does not run on the dev machine (D10); the Dockerfiles' install/build steps were rehearsed locally in clean folders |

## Known limitations / blockers
- Docker/WSL2 not working on dev machine; the Docker stack is validated in CI only (D10).
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
- `GET /v1/endpoints` is not paginated (an application has few endpoints).
- Changing an endpoint's URL does not reset its circuit state.
- Windows does not deliver SIGTERM to Node; Ctrl+C (SIGINT) triggers graceful shutdown locally.
- If a DB connection drops during COMMIT, the client gets 503 although the commit may have
  succeeded; retrying with the same `Idempotency-Key` resolves it safely.

- Response excerpts keep only the first 1 KB of the consumer's body.
- Each worker runs its own sweeper (cheap, concurrency-safe via SKIP LOCKED); no leader election.
- A delivery whose endpoint secret is not valid base64 (impossible through the API) would throw in
  signing and be recovered by lease expiry until it is dead.
- Migrations are applied to `relay_test` by the test setup only; run `npm run migrate -w server` once
  before using the dev database (`relay`).
- Probe claim: if a promoted endpoint's only due delivery is row-locked at that instant (no Relay code
  path does this to a pending row; e.g. an operator's open manual transaction), the endpoint becomes `half_open` without a probe and waits for the probe
  deadline (`LEASE_MS`) before the next try. Self-healing; costs at most one lease of delay.
- `relay_oldest_due_delivery_age_seconds` also counts deliveries held by an open circuit or a
  disabled endpoint, so it rises during a single endpoint's outage, not only when workers lag.
- `/metrics` is unauthenticated (like `/healthz`); restrict it at the network level in production.
- The mock consumer keeps its state in memory (counters and duplicate memory reset on restart).
- The demo with default timings (cooldown 30 s, HTTP timeout 10 s) takes several minutes;
  `.env.example` lists faster demo values.
- Dashboard: rows fetched with "Load more" are not re-polled; their status can be stale until a
  later page covering them is fetched (the first page is always fresh).
- Dashboard: in the unfiltered dead-letter view, the bulk "replay all dead" buttons cover only
  endpoints with dead rows on the loaded pages (filter by endpoint for any other).
- Dashboard: relative times ("12 s ago") use the browser clock (display only).
- Dashboard UI has no component tests (D64); checked by tsc, the build and a manual walkthrough.
- The dev machine runs Node 26; Node 22 and 24 (the supported minimum and current LTS) are
  tested only in CI. A Node 26-only behaviour (`node --test` with a directory) went unnoticed
  locally and failed CI's first runs (fixed in 22ff218).
- `docker-compose.yml` is a demo stack (fixed database password, development-only network flags),
  not a production deployment.

## Session log
| Date | Session | Outcome |
|---|---|---|
| | Day 0 | Starter files created |
| 2026-11-11 | Day 1 planning | Architecture reviewed (R1–R16), schema + state machine finalised, plan approved with A1–A3; saved to `docs/plans/day1.md` |
| 2026-11-11 – 11-17 | Day 1 implementation | Steps 0–9 done, one commit each. 274 tests green. Found and fixed: NULL-passing CHECK (D30), checked-out-client crash (D31), ms-truncated cursor (D33), jsonb-unstorable payloads (D34); corrected the `/healthz` test expectation (D40). Stretch (backoff/signing) moved to Day 2 |
| 2026-11-17 | Day 2 planning | Plan approved and saved to `docs/plans/day2.md` (steps 0–9, decisions D41–D50 proposed). Chosen: any destination port allowed; HTTPS tested with a committed self-signed test cert |
| 2026-11-18 – 11-19 | Day 2 implementation | Steps 1–9 done (switched to several steps per session, Claude commits each step). 482 tests green. Found: IP literals bypass `lookup` (D43), NUL / invalid status from consumers would poison records (D46, D52), the plan's SKIP LOCKED negative control was wrong (D51) |
| 2026-11-19 | Day 3 session 3 | Short plan (`docs/plans/day3.md`); circuit breaker with single-probe half-open and probe deadline, replay, deliveries API. 526 tests. Found: the concurrent probe test could not fail (D57) |
| 2026-11-19 | Day 3 session 4 | Mock consumer, interop test against the real worker, demo script (tested end to end), `/metrics`, docs. 539 + 20 tests. Found: empty JSON-typed POST body is a 400 (D62) |
| 2026-11-19 | Day 4 session 5 | Short plan (`docs/plans/day4.md`), dashboard scaffold, client/auth/router/poller, endpoints, messages, deliveries + DLQ + timeline, contract test, docs. 546 + 20 + 109 tests. Found: Node's `RequestInit` has no `cache` (dropped; nothing to cache) |
| 2026-11-19 | Day 5 session 6 | Short plan (`docs/plans/day5.md`); review pass found and fixed 2 bugs (D69 migration-runner crash, D70 row data in logs); compiled production build; CI workflow; Dockerfiles, nginx, compose, CI demo job. 557 + 20 + 109 tests |
| 2026-11-20 | Day 5 session 7 | README, ADRs 0001–0008, final docs. The gate caught 2 intermittent failures; looping the full suite traced one to a fixed sleep in the D69 migration-kill test (now waits on pg_stat_activity) and found waits longer than the 5 s test timeout (explicit timeouts added); 10/10 full runs green. A one-off failure of the compiled-server build step (1 in ~27 runs) was not reproduced; the test now reports its full output. A third failure (a migrate test reported at 677 s despite its 5 s timeout) was the laptop entering Modern Standby mid-run: the Windows event log shows standby from 00:09:10 to 00:20:27 IST, 677 s, matching the reported duration exactly; not a code issue. v1 feature-complete; awaiting first push / CI run |
