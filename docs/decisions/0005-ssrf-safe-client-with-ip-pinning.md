# 0005 — An SSRF-safe HTTP client with validated, pinned IPs

- Status: accepted (Day 2, 2026-11-18)
- Related: PROGRESS D8, D41–D44, D46–D48, D52; ARCHITECTURE §5; invariant 8

## Context
Customers choose the URLs Relay calls. Without care, `https://internal.example/` or a DNS
name that resolves to `169.254.169.254` turns Relay into a proxy into its own network.
Checking the hostname and then connecting is not enough: DNS can answer differently the
second time (rebinding).

## Decision
All requests to customer URLs go through one client (`server/src/delivery/http-client.ts`)
built on `node:http(s)`:
- A custom `lookup` resolves all addresses and blocks the request if **any** is
  disallowed; the socket connects only to the validated addresses (pinning).
- IP-literal URLs are classified **before** connecting, because Node never calls `lookup`
  for literals (found by a test, D43).
- IPv4 uses a block list of special ranges. IPv6 is an allow list (global unicast only),
  and IPv4-mapped / NAT64 addresses are judged by the embedded IPv4.
- No redirects; one total deadline (DNS + connect + TLS + response); `agent: false`; at most
  1 KB of the response is read and stored, sanitised so it is always storable.
- `RELAY_ALLOW_PRIVATE_NETWORKS` and `ALLOW_HTTP_ENDPOINTS` exist for local development and
  default to `false`.

## Consequences
- No dependency; every rule is unit-tested (about 40 address cases) and the client is
  tested against local servers, including "the server receives zero requests".
- Any destination port is allowed (D41): address blocking is the protection.
- The Docker demo must enable the development flags, because its consumer is a private
  container; this is documented as development-only.
