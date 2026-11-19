# 0006 — Standard Webhooks signatures

- Status: accepted (Day 0, 2026-11-11)
- Related: PROGRESS D7, D21, D25, D60; ARCHITECTURE §5, §8

## Context
Consumers need to verify that a request came from Relay and was not altered or replayed.
A home-grown scheme would force every consumer to write custom verification code.

## Decision
Sign with the [Standard Webhooks](https://www.standardwebhooks.com/) scheme: headers
`webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256>` over
`"{id}.{timestamp}.{body}"`, keyed with the endpoint secret (`whsec_` + base64). Verification
uses a constant-time comparison and a 5-minute timestamp tolerance. `webhook-timestamp` is
the one value taken from the worker's clock (the spec requires the send time).

## Consequences
- Consumers can use existing Standard Webhooks / Svix libraries.
- Interoperability is shown, not assumed: Relay's signer and the mock consumer's
  independent verifier (no shared code) both pass the published test vector, and an
  end-to-end test sends live traffic from the real worker to the real consumer process (a
  broken verifier makes it fail).
- Secrets are stored in plaintext in this version (encryption at rest and rotation with
  dual signatures are future work).
