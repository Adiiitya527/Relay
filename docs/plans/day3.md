# Day 3 Plan — Resilience, replay, demo backend

Short plan (agreed 2026-11-18: Days 3–5 get a one-page plan instead of a Plan Mode session).
Two sessions: S3 = steps 0–3, S4 = steps 4–7. Same rules: tests with every step, suite +
typecheck green before each commit, one commit per step. No new dependencies, no migration
(schema 001 already has `circuit_state`, `consecutive_failures`, `circuit_open_until`).

## Step 1 — `feat(worker): add per-endpoint circuit breaker with single-probe half-open`
**Result side** (inside `recordResult`'s transaction, after the attempt row, so the circuit
always agrees with the attempt log):
- success → `closed`, `consecutive_failures = 0`, `circuit_open_until = NULL`. Skipped when
  already closed with 0 failures (no-op writes cause row contention).
- failure → `consecutive_failures + 1`; becomes `open` until `now() + CIRCUIT_COOLDOWN_MS` if it
  was `half_open` (the probe failed) or the new count reaches `CIRCUIT_FAILURE_THRESHOLD`.
- `lease_lost` → no circuit change (the result was discarded).

**Claim side** (replaces the Day 1 placeholder `OR (open AND cooled down)`):
- Normal claim: only endpoints with `circuit_state = 'closed'`.
- Probe claim, a separate statement run first, using the free slots:
  1. lock cooled-down endpoints (`open`, or `half_open` whose probe deadline has passed,
     `circuit_open_until <= now()`) that have a due pending delivery, `FOR UPDATE SKIP LOCKED`;
  2. set them `half_open` with `circuit_open_until = now() + LEASE_MS` (**the probe deadline**);
  3. claim exactly ONE due delivery per such endpoint (`LATERAL … LIMIT 1 FOR UPDATE SKIP LOCKED`).
- Only one worker can win step 1 for an endpoint, so exactly one probe is in flight; everyone
  else skips the endpoint (it is not `closed`). Its other deliveries spend no attempts (invariant 9).
- **Self-healing:** if the probe's worker dies, or the probe result is `lease_lost`, the
  endpoint would otherwise sit in `half_open` forever. Because `half_open` carries a deadline,
  another probe becomes possible once it passes. No sweeper coupling is needed.
- Deadlock check: the probe claim only takes locks with `SKIP LOCKED` (it never waits); a result
  write locks its delivery row, then its endpoint row, always in that order.

Tests:
- threshold opens the circuit;
- open → nothing claimed, `attempt_count` unchanged;
- after the cooldown exactly one probe is claimed, even with 8 concurrent claimers;
- probe success closes; probe failure re-opens with a fresh cooldown;
- an expired probe deadline allows a new probe;
- success resets the counter;
- end to end: an endpoint that is down opens its circuit, its backlog is untouched, and it recovers.

## Step 2 — `feat(api): add single and bulk replay`
- `POST /v1/deliveries/:id/replay` → 202 `{ delivery }`. Uses T5 from day1.md: `dead` /
  `succeeded` → `pending`, `attempt_count = 0`, due now; history kept.
  - Missing or another tenant's delivery → 404.
  - `pending` / `in_flight` → 409 `delivery_not_replayable`.
- `POST /v1/endpoints/:id/replay-dead` → 202 `{ replayed: n }`. Unknown endpoint → 404.
- A replay for a disabled endpoint stays paused; one for an open circuit waits for the probe.

## Step 3 — `feat(api): add deliveries list, detail and attempt timeline`
- `GET /v1/deliveries?status=&endpoint_id=&limit=&cursor=`: keyset by `(created_at, id)` DESC.
  The microsecond cursor moves from `messages/query.ts` to a shared module. Each item includes
  `event_type` (joined) for the dashboard.
- `GET /v1/deliveries/:id` (added for the dashboard's delivery view).
- `GET /v1/deliveries/:id/attempts` → `{ data }`, oldest first. `lease_token` is internal and
  not exposed.

## Session 4
- **Step 4** `feat(mock-consumer): …`: zero-dependency receiver (ARCHITECTURE §8). It has its own
  signature verification (independent of `server/`), modes ok / fail / flaky / slow / timeout,
  duplicate detection by `webhook-id`, and `GET /stats`.
- **Step 5** `feat: add end-to-end demo script`: a Node script (no shell syntax, so it works on
  Windows and in Docker) that runs the whole story: create app and endpoint, publish, a failure
  mode, the circuit opening, recovery, replay.
- **Step 6** (if time allows) `GET /metrics` in Prometheus text format: delivery counts by status
  and the oldest pending age.
- **Step 7** `docs: record Day 3 progress, decisions and commands`.

## Departures from this plan (recorded after implementation)
- Step 1: the plan's "8 concurrent claimers → exactly one probe" test could not fail: with the
  candidates lock removed it still passed, because the claims never overlapped at the critical
  moment. Added a test that holds one probe claim's transaction open while another worker
  claims (PROGRESS D57).
- Step 4: the mock consumer is plain JavaScript with JSDoc types (`tsc --checkJs`) and is
  tested with `node:test`, so it stays zero-dependency and runs with bare `node`. Per-hook modes
  and secrets were added (the demo needs a healthy and a failing endpoint side by side), and
  duplicates are defined precisely: a re-send after a 2xx is a duplicate, after a failure a
  retry. Added an interop test: the real worker delivering to the real consumer process.
- Step 5: the demo logic lives in `server/src/demo/run-demo.ts` (tested end to end); the script
  creates its own application. It also covers idempotent publish and a late reply detected as a
  duplicate. Found: a body-less POST declared as JSON is a 400 (kept, documented, D62).
- Step 6: `/metrics` reports the oldest *due* delivery's age (queue lag) rather than the oldest
  pending one: a pending row scheduled for a later retry is not late. `succeeded` is not counted
  (no partial index; unbounded history).
