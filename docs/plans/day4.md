# Day 4 Plan — Dashboard

Short plan (Days 3–5 rule). One session (S5), one commit per step; suite + typecheck green
before every commit. Testing approach agreed 2026-11-19: **pure-logic tests only** — views stay
thin; the API client, auth, routing, polling and formatting live in plain TypeScript modules
tested with vitest (node environment). No DOM test libraries. The UI is checked by
`tsc` plus a production build (`npm run build -w dashboard`, part of every step's gate)
and by a manual browser walkthrough.

## Dependencies (all from the CLAUDE.md stack; shown before installing)
- runtime: `react`, `react-dom`
- dev: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@types/react`,
  `@types/react-dom`, `vitest` (same test runner as `server/`)
- No router, state-management or data-fetching library: a ~40-line hash router and a polling
  hook are enough for six views (ARCHITECTURE §7: "no library unless justified").
- Vite 8 needs Node ≥ 22.12, so the dashboard workspace declares `engines.node >= 22.12`
  (the dev machine has 26.13; server and mock consumer keep ≥ 22.9).

## Design
- **Dev proxy:** Vite forwards `/v1`, `/healthz`, `/metrics` to `DASHBOARD_API_URL`
  (default `http://127.0.0.1:3000`), so the browser sees one origin and the API needs no CORS.
  Production serving (same-origin reverse proxy / static files) is Day 5 Docker work.
- **Auth:** the operator pastes an API key; it is checked with `GET /v1/endpoints` and kept in
  `sessionStorage` (gone when the tab closes; never in `localStorage`, never in a URL, never
  logged). Any 401 clears it and returns to the login screen.
- **API client:** one `request()` wrapping `fetch` (injectable for tests). Sends
  `Content-Type: application/json` **only with a body** (D62), parses the
  `{ error: { code, message } }` shape into a typed `ApiError`, maps network failures to a
  friendly message.
- **Polling:** every 3 s, paused while the tab is hidden, no overlapping requests, stale
  responses ignored after the view changes.
- **Rendering safety:** response excerpts, payloads and URLs are rendered as text by React;
  no `dangerouslySetInnerHTML` anywhere.

## Views
1. **Login** — API key field; error shown for 401 / API unreachable.
2. **Endpoints** — list with circuit badge (closed / open / half_open + "until" time),
   disabled toggle, create form (url, description, event types); the new secret is shown once
   with a copy button; "Reveal secret" calls `/secret`; "Replay dead" per endpoint.
3. **Messages** — newest first, "Load more" with the cursor; "Send test event" form (event
   type + JSON payload) for demos.
4. **Message detail** — payload (pretty JSON) and its deliveries per endpoint.
5. **Deliveries** — status tabs (all / pending / in_flight / succeeded / dead) and endpoint
   filter; `dead` is the dead-letter queue view with per-row Replay and bulk "Replay all dead
   for this endpoint".
6. **Delivery detail** — fields + attempt timeline (attempt, time, status / error kind,
   duration, excerpt); Replay button when dead / succeeded.

## Steps
- **Step 0** `docs: add Day 4 plan`.
- **Step 1** `chore(dashboard): scaffold Vite, React, TypeScript and Tailwind` — config, dev
  proxy, scripts (`dev`, `build`, `typecheck`, `test`), app shell. Test: proxy target config.
- **Step 2** `feat(dashboard): add API client, auth, router and polling` — tests: headers and
  content-type rule, error parsing, 401 → logout, key storage, route parse/format round trip,
  poller (pauses when hidden, no overlap, stops on dispose) with fake timers.
- **Step 3** `feat(dashboard): add endpoints view` — tests: circuit badge / time formatting,
  event-type input parsing.
- **Step 4** `feat(dashboard): add messages list, detail and test-event form` — tests: payload
  JSON validation, cursor paging merge (no duplicates).
- **Step 5** `feat(dashboard): add deliveries, dead-letter queue and attempt timeline` — tests:
  status filter → query string, attempt outcome summary, replay eligibility.
- **Step 6** `docs: record Day 4 progress, decisions and commands`.

## Verification
Per step: `npm test -w server`, `npm test -w mock-consumer`, `npm test -w dashboard`,
`npm run typecheck`, `npm run build -w dashboard`. At the end, walkthrough for you: run API +
worker + mock consumer + `npm run dev -w dashboard`, log in with a `create-app` key, run the
demo script and watch it in the browser (circuit badge flips, DLQ fills, replay drains it).
