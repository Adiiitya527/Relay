# 0003 — At-least-once delivery with a stable `webhook-id`

- Status: accepted (Day 0, 2026-11-11)
- Related: PROGRESS D6, D21; ARCHITECTURE §4; invariant 6

## Context
Over HTTP, a sender cannot know whether a request whose response was lost (timeout, reset,
crash before recording) was processed. It must either risk losing the event or risk sending
it twice.

## Decision
Relay never drops an event it could not confirm: delivery is **at-least-once**. The
`webhook-id` header is the message id and is identical on every retry and replay, so
consumers deduplicate on it. The bytes sent and signed are exactly `payload::text`.

## Consequences
- Consumers must be idempotent (store processed `webhook-id`s). The mock consumer does this
  and reports duplicates; the demo shows one (a reply slower than Relay's timeout).
- Replaying a `succeeded` delivery is, by design, a duplicate to a deduplicating consumer.
- Two endpoints of the same message get the same `webhook-id`; deduplication is per
  endpoint (consumer).
