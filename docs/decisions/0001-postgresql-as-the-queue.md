# 0001 — PostgreSQL is both the store and the queue

- Status: accepted (Day 0, 2026-11-11)
- Related: PROGRESS D1, D3, D11, D18; ARCHITECTURE §1, §4

## Context
Relay must never lose a published event, and must never deliver an event whose message was
not stored (or store one that is never delivered). The usual design uses a database plus a
broker (Redis/BullMQ, RabbitMQ, SQS) and needs a transactional outbox to keep them in step.

## Decision
The `deliveries` table **is** the queue. Publishing writes the message and one delivery row
per subscribed endpoint in a single transaction. Workers claim due rows with
`SELECT … FOR UPDATE SKIP LOCKED` in a short transaction, limited to their free concurrency
slots. All queue logic is plain, parameterised SQL (no ORM, no query builder).

## Alternatives considered
- **Redis / BullMQ:** fast, but a second stateful system, an outbox to keep it consistent, and
  the queue logic would live in a library rather than in code we can explain.
- **A message broker:** same consistency problem, plus operational weight for a single team.

## Consequences
- Publish + enqueue is atomic for free; there is nothing to reconcile.
- One system to back up, monitor and reason about; queue state is queryable with SQL (the
  dashboard and `/metrics` read it directly).
- Throughput is bounded by PostgreSQL write capacity: fine for thousands of deliveries per
  second, not for millions. Partial indexes keep the hot paths (`pending`, `in_flight`,
  `dead`) small.
- Leaked transactions would block the queue, so pools set `statement_timeout` and
  `idle_in_transaction_session_timeout` (D18).
