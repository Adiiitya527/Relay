# 0008 — A dashboard without router, state or data-fetching libraries

- Status: accepted (Day 4, 2026-11-19)
- Related: PROGRESS D9, D62–D68; ARCHITECTURE §7

## Context
The operator dashboard has six views and needs live-ish data (circuit state, the
dead-letter queue filling and draining). Common choices would add a router, a
data-fetching/cache library and possibly WebSockets.

## Decision
- React + Vite + Tailwind only. A small hash router, a poller and a paged-list hook live in
  plain TypeScript modules.
- Poll every 3 s instead of pushing over WebSockets. Requests never overlap, polling pauses
  while the tab is hidden, and a view change aborts the request and drops late answers.
- Same origin everywhere: the Vite dev proxy in development, nginx in Docker. The API needs
  no CORS.
- The API key lives in `sessionStorage` (memory fallback), is checked before it is stored,
  and any 401 logs out.
- Tests cover the logic modules only, with no DOM test libraries. A contract test in
  `server/` runs the dashboard's real API client against the real API.

## Consequences
- Few concepts and a small bundle; every piece of logic that can break has unit tests.
- A 3 s delay is acceptable for an operator view; no extra failure modes from long-lived
  connections.
- Views are not component-tested; they are checked by the type checker, the production
  build and a manual walkthrough.
