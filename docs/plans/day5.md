# Day 5 Plan — Hardening and presentation

Short plan (Days 3–5 rule). Two sessions: **S6 = steps 0–4** (review, production build, CI,
Docker), **S7 = steps 5–7** (README, ADRs, final docs). Same gate before every commit: server,
mock-consumer and dashboard tests, typecheck, dashboard build. No new npm dependencies.

## Step 1 — Review pass (`fix:` commits, one per finding, each with a test)
Read every module with four questions, and fix only what a test can demonstrate:
- **Tenant scoping:** every SQL statement reachable from `/v1` filters by `app_id`
  (grep all queries; cross-tenant tests exist for each route).
- **Concurrency:** every multi-statement write uses `withTransaction`; no transaction spans
  an await on anything but the database; claim / record / sweep / probe / replay races.
- **Error handling:** no unhandled rejections in the worker loops; every route error ends in
  the `{ error: { code, message } }` shape; no stack traces or SQL to clients.
- **Secrets & SSRF:** no logs of keys, secrets, URLs or payloads (pino redaction check);
  every outbound call to a customer URL goes through `createSafeHttpClient`.
If nothing is found for a question, the report says so (no change for its own sake).

## Step 2 — `feat(server): run compiled JavaScript in production`
`tsx` is a dev dependency, so production should not need it. Add `tsconfig.build.json`
(emit `src/` to `server/dist/`, no tests), `npm run build -w server`, and `start:api`,
`start:worker`, `migrate:prod` scripts using `node dist/...`. Verified by a test that runs the
built API entry point as a child process against `relay_test` and calls `/healthz`.

## Step 3 — `ci: add GitHub Actions workflow`
`.github/workflows/ci.yml`: Node 22 + 24 matrix, `postgres:16` service, `npm ci`, typecheck,
all three test suites, dashboard build, server build. `TEST_DATABASE_URL` points at a
`relay_test` database in the service container; secrets are not needed (throwaway DB).

## Step 4 — `feat: add Dockerfiles and docker-compose`
- `server/Dockerfile` (multi-stage: build with dev deps, run with `npm ci --omit=dev`,
  non-root user); one image, three commands: migrate, API, worker.
- `mock-consumer/Dockerfile` (just `node src/index.js`).
- `dashboard/Dockerfile`: build with Vite, serve with `nginx:alpine`, which also
  reverse-proxies `/v1`, `/healthz` to the API (same origin in production, no CORS).
- `docker-compose.yml`: postgres → migrate (one-shot) → api + worker + mock-consumer +
  dashboard; healthchecks; demo-friendly timings via env; private-network flags enabled
  **only** in compose (the mock consumer is on the compose network) with a comment.
- Docker does not work on the dev machine (D10), so CI validates it: a second job runs
  `docker compose up --wait`, then the end-to-end demo against the stack.

## Step 5 — `docs: add README` (S7)
Problem, architecture diagram (text), guarantees and how each is enforced, quick start
(local and Docker), demo walkthrough (terminal + dashboard), API summary, testing approach,
limitations and future work.

## Step 6 — `docs: add architecture decision records` (S7)
`docs/decisions/0001-…` short ADRs (context / decision / consequences) for: PostgreSQL as the
queue; leases with lease-token fencing; at-least-once with stable `webhook-id`; single-probe
circuit breaker with probe deadline; SSRF-safe client with IP pinning; Standard Webhooks
signing; keyset pagination with microsecond cursors; dashboard without client libraries.

## Step 7 — `docs: record Day 5 progress` (S7)
PROGRESS (tick Day 5, final status, limitations), CLAUDE.md commands, departures.

**Yours:** creating the GitHub remote and the first push (CI then runs), and the demo
recording / screenshots.
