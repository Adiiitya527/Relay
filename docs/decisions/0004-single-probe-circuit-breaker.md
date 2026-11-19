# 0004 — Per-endpoint circuit breaker with a single half-open probe

- Status: accepted (Day 1 design, Day 3 implementation, 2026-11-19)
- Related: PROGRESS D12, D54–D57; ARCHITECTURE §4; invariant 9

## Context
An endpoint that is down for twenty minutes would otherwise burn every delivery's retry
budget (pushing all of them to the dead-letter queue) and occupy worker slots with
timeouts, delaying healthy endpoints. A naive half-open state lets every worker send a
"probe" at once when the cooldown ends.

## Decision
- `closed → open` after `CIRCUIT_FAILURE_THRESHOLD` consecutive failures, for
  `CIRCUIT_COOLDOWN_MS`. The normal claim takes only deliveries of `closed` endpoints, so
  held deliveries **spend no attempts**.
- A separate probe claim, run first, locks cooled-down endpoints with
  `FOR UPDATE SKIP LOCKED`, promotes them to `half_open` and claims **one** due delivery each.
  The endpoint row lock is what makes the probe single.
- `half_open` carries a **probe deadline** (`now() + LEASE_MS`): if the probe's worker dies
  or its result is discarded, a new probe becomes possible after the deadline (self-healing).
- The circuit is updated inside the result transaction (delivery row, then endpoint row);
  success closes it, failure re-opens it with a fresh cooldown. No-op writes are skipped.

## Consequences
- An outage costs one request per cooldown instead of a stampede; recovery drains the
  backlog automatically.
- Contention on the endpoint row is limited to state changes.
- Testing lesson: a test with eight concurrent claimers still passed with the lock removed
  (the race window is too short to hit). The real guard is a test that holds a probe claim's
  transaction open while another worker claims (D57).
