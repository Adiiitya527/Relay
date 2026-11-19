# 0002 — Leases with lease-token fencing for crash recovery

- Status: accepted (Day 1, 2026-11-11)
- Related: PROGRESS D5, D11, D13, D14, D51; ARCHITECTURE §4; invariants 3–5

## Context
A worker can crash, hang or lose its network after claiming a delivery. The row must go
back to the queue, but a slow worker that wakes up later must not overwrite the result of
the worker that took over. Holding a transaction (and a row lock) for the whole HTTP call
would solve ownership, but would exhaust connections and block vacuum.

## Decision
- A claim sets `status = 'in_flight'`, `locked_until = now() + LEASE_MS` and a fresh
  `lease_token`, and commits immediately. The HTTP request runs outside any transaction.
- Every result write is fenced: `WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'`.
  Zero rows updated means the lease was lost: the result is logged and discarded.
- A sweeper (in every worker, `SKIP LOCKED`) returns expired leases to `pending` (or `dead`)
  and records a `lease_expired` attempt with the old token.
- A claim takes only as many rows as there are free slots, so the lease and HTTP clocks
  start together; config enforces `LEASE_MS >= 2 * HTTP_TIMEOUT_MS + 5000`.
- `delivery_attempts.lease_token` is UNIQUE: one attempt row per claim, so the worker and
  the sweeper can never both log the same attempt.

## Consequences
- The fence is the token, not the clock: a result that arrives after the lease expired but
  before anyone swept it is still accepted (it is still the latest owner).
- Exactly-once is impossible: a consumer may receive a request whose result was lost
  (see 0003).
- Proven by tests with negative controls: removing the token condition lets a stale worker
  overwrite; removing the row lock causes double claims (596 claims for 200 rows), and
  removing only `SKIP LOCKED` makes concurrent claimers wait (D51).
