# Relay — Project Instructions for Claude Code

Relay is reliable webhook delivery infrastructure. Applications publish events to Relay;
Relay delivers them to subscribed HTTP endpoints with at-least-once guarantees, signed
payloads, retries with backoff, a dead-letter queue, replay, per-endpoint circuit
breaking, and SSRF protection.

Full design: `docs/ARCHITECTURE.md`. Current status: `docs/PROGRESS.md`. Read both
before starting any milestone.

## Working agreement
- The developer wants to UNDERSTAND every change. Explain non-obvious code, especially SQL,
  concurrency and security logic. Prefer small, reviewable steps over large dumps.
- Implement one plan step at a time. Stop when the step's tests pass and summarise.
- Never add a dependency that is not listed below without asking first and justifying it.
- If a request conflicts with this file or ARCHITECTURE.md, say so before proceeding.
- At the end of each milestone, update `docs/PROGRESS.md` (done / pending / decisions).

## Stack (fixed)
- Node.js (current LTS, >= 22), TypeScript (strict), npm workspaces.
- `server/`: Fastify, Zod, `pg` (node-postgres), pino. Dev: tsx, vitest, @types/node, @types/pg.
- `dashboard/`: React + Vite + TypeScript + Tailwind CSS.
- `mock-consumer/`: zero runtime dependencies (node:http, node:crypto only).
- PostgreSQL >= 16, installed locally. Plain SQL only.
- NOT allowed: ORMs or query builders, Redis, BullMQ, message brokers, dotenv
  (use `node --env-file`), axios/got (use node:http/https), lodash, moment/dayjs.

## Repository layout
```
relay/
  CLAUDE.md
  .env.example
  docs/            ARCHITECTURE.md, PROGRESS.md, decisions/
  server/src/      config.ts, db/, api/, delivery/, worker/, server.ts
  server/test/     integration + unit tests
  dashboard/       React app
  mock-consumer/   demo webhook receiver with failure modes
```

## Commands (keep this list accurate as scripts are added)
- `npm install`                  install all workspaces
- `npm run migrate -w server`    apply SQL migrations to DATABASE_URL
- `npm run dev:api -w server`    start API (port from env, default 3000)
- `npm run dev:worker -w server` start delivery worker
- `npm run create-app -w server -- <name>`  create an application and print its API key
- `npm run dev -w mock-consumer` start mock consumer (default port 4000)
- `npm run dev -w dashboard`     start dashboard (Vite)
- `npm test -w server`           run tests against TEST_DATABASE_URL
- `npm run typecheck`            typecheck all workspaces (must pass before commit)

## Architecture invariants (never violate)
1. PostgreSQL is the single source of truth AND the queue. No other state store.
2. Publishing a message and creating its delivery rows happens in ONE transaction.
3. Workers claim deliveries only via `SELECT ... FOR UPDATE SKIP LOCKED` in a short
   transaction. NEVER hold a DB transaction open during an outbound HTTP request.
4. Every claim sets a lease (`locked_until`) and a fresh `lease_token`. Result writes
   must match `id AND lease_token AND status = 'in_flight'` (fencing). Zero rows
   updated = the lease was lost; log it and discard the result.
5. Lease duration must exceed the HTTP timeout by a safe margin.
6. Delivery is at-least-once. The `webhook-id` header equals the message id and is
   stable across retries so consumers can deduplicate.
7. All time comparisons use the database clock (`now()`), never the worker's clock.
8. Every outbound HTTP request to a customer URL goes through the SSRF-safe client in
   `server/src/delivery/`. No other code may call customer URLs.
9. Deliveries skipped because a circuit is open do NOT consume retry attempts.
10. Config comes only from environment variables, validated with Zod at startup.
    No hard-coded hosts, ports or Windows paths (must stay Docker-compatible).

## Coding conventions
- ES modules, `async/await`, no callbacks. Strict TypeScript; no `any` without a comment.
- SQL lives in the module that owns it, as parameterised queries (`$1, $2`). Never
  build SQL by string concatenation with user input.
- Validate every request body, query and param with Zod. Return errors as
  `{ "error": { "code": "snake_case", "message": "..." } }` with correct status codes.
- Small pure functions for logic (backoff, signing, IP classification) so they are
  unit-testable; DB/network code stays thin.
- Structured logging with pino; include delivery_id / message_id / endpoint_id fields.
  Never log secrets, API keys or full payloads.
- Graceful shutdown on SIGINT/SIGTERM for API and worker.
- Commit messages: Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).

## Testing requirements
- Vitest. Integration tests hit a real PostgreSQL database (`TEST_DATABASE_URL`), never mocks
  of the DB. Tests run sequentially; each test starts from truncated tables.
- Every behavioural change ships with tests in the same step.
- Required guarantees to test: no double claim under concurrent workers; expired leases
  are recovered; stale workers cannot overwrite results (fencing); idempotent publish;
  backoff schedule and exhaustion -> dead; signature verification; SSRF blocking
  (private, loopback, link-local, IPv4-mapped IPv6, redirects not followed); circuit
  breaker open/half-open/close; replay.
- Do not mark a step done until `npm test -w server` and `npm run typecheck` pass.

## Security rules
- API keys: random, high-entropy, shown once, stored only as SHA-256 hashes.
- Endpoint signing secrets: `whsec_` + base64 random bytes; never logged.
- Signatures follow the Standard Webhooks scheme (see ARCHITECTURE.md).
- SSRF protection is ON by default. `RELAY_ALLOW_PRIVATE_NETWORKS=true` is for local
  development only and must default to false.
- Enforce payload size limits, request timeouts and response-size caps.
- Every query is scoped by `app_id` from the authenticated key (tenant isolation).

## Never do
- Never run destructive commands (`rm -rf`, `git reset --hard`, `git push --force`,
  `DROP DATABASE`) without explicit approval.
- Never edit an already-applied migration; add a new one.
- Never commit `.env` or secrets.
- Never skip or weaken a failing test to make it pass; find the root cause.
