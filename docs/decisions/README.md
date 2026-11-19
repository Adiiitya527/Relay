# Architecture decision records

Short records of the decisions that shape Relay: the context, what was decided, the
alternatives considered, and the consequences. The full, numbered decisions log (D1–D72) is in
[../PROGRESS.md](../PROGRESS.md#decisions-log); each ADR links the entries it summarises.

| ADR | Decision |
|---|---|
| [0001](0001-postgresql-as-the-queue.md) | PostgreSQL is both the store and the queue |
| [0002](0002-leases-and-lease-token-fencing.md) | Leases with lease-token fencing for crash recovery |
| [0003](0003-at-least-once-with-stable-webhook-id.md) | At-least-once delivery with a stable `webhook-id` |
| [0004](0004-single-probe-circuit-breaker.md) | Per-endpoint circuit breaker with a single half-open probe |
| [0005](0005-ssrf-safe-client-with-ip-pinning.md) | An SSRF-safe HTTP client with validated, pinned IPs |
| [0006](0006-standard-webhooks-signatures.md) | Standard Webhooks signatures |
| [0007](0007-keyset-pagination-with-microsecond-cursors.md) | Keyset pagination with microsecond cursors |
| [0008](0008-dashboard-without-client-libraries.md) | A dashboard without router, state or data-fetching libraries |

New decisions: add the next number, keep it to one page, and add a line to the decisions log.
