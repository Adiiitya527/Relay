# Day 2 Plan — Delivery engine

Produced in Plan Mode and approved on 2026-11-17. Work from this file one step at a time
(per-step process: CLAUDE.md and `docs/plans/day1.md` §7).

## Context
Day 1 left Relay able to accept and store events: publish writes a message and its `pending`
deliveries in one transaction. Nothing sends them yet. Day 2 builds the worker that turns
`pending` rows into signed HTTP requests:
- claim (T1);
- deliver through an SSRF-safe client;
- record the result with fencing (T2/T3);
- recover crashed attempts (sweeper, T4).

It also covers the pure pieces it needs: backoff, Standard Webhooks signing, IP classification.

The transition SQL (T1–T4) was already approved in `docs/plans/day1.md` §3 and is reused
as-is. The one exception is the claim's `RETURNING` list (D45 below).

**Out of scope (Day 3):** circuit-breaker writes and half-open, replay, the deliveries API, the mock consumer.
- On Day 2 nothing writes `circuit_state`, so every endpoint stays `closed`.
- The claim still filters on circuit state as approved.

**No migration is needed:** schema 001 already has every column and index used here.

**Answers given during planning:**
- Ports: any destination port is allowed.
- HTTPS is tested with a committed self-signed test certificate.

## New decisions (recorded in PROGRESS.md in step 9)
| # | Decision | Why |
|---|---|---|
| D41 | Any destination port is allowed; replaces "default ports unless configured" in ARCHITECTURE §5 | IP blocking is the protection; real consumers use :8443 etc. |
| D42 | A hostname is blocked if **any** resolved address is blocked (no filtering) | A mixed answer is an attack signal; filtering invites games with ordering and family |
| D43 | IP-literal hosts (`https://127.0.0.1`, `[::1]`) are checked **before** the request | Node's `net.connect` skips `lookup` entirely for IP literals, so a lookup-only check would miss them |
| D44 | IPv4 uses a block list of special ranges. IPv6 is an allow list: only `2000::/3` global unicast, minus documentation, 6to4 and Teredo. IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses are judged by the IPv4 inside them | Allow-listing v6 is simpler and safer than enumerating every special range |
| D45 | The claim's `RETURNING` also returns `m.payload::text AS body, e.url, e.secret` (joined in `UPDATE … FROM`) | One round trip per claim; the body is serialised once and is exactly what gets signed (D21) |
| D46 | The response excerpt is decoded as UTF-8, `\u0000` is stripped, and it is cut to 1024 **characters** | Postgres `text` rejects NUL (22P05). An unsanitised excerpt would make every record fail, so the lease expires and the message is redelivered forever |
| D47 | The outcome is decided by the status code as soon as headers arrive. Reading the 1 KB excerpt is best-effort within the same total deadline, and the socket is then destroyed | A slow or huge body can't change or delay the outcome |
| D48 | Each request uses `agent: false` (no socket reuse) | No connection state is shared across deliveries or endpoints; every connection goes through the validating lookup |
| D49 | Logs carry `delivery_id / message_id / endpoint_id`, never the URL or the secret | Webhook URLs often embed tokens (`?token=…`) |
| D50 | Backoff caps the base delay, then applies ±20 % jitter, so the maximum real delay is 1.2 × `RETRY_CAP_MS` | Clamping after jitter would make everything at the cap fire in sync, defeating the jitter |

## Files
- `server/src/delivery/`
  - `backoff.ts`, `signing.ts`, `ip-policy.ts`: pure.
  - `excerpt.ts`: pure.
  - `http-client.ts`: the **only** code that calls customer URLs (invariant 8).
- `server/src/worker/`
  - `queue.ts`: SQL for claim, record and sweep.
  - `deliver.ts`: sign, send, classify.
  - `worker.ts`: the loop.
  - `start.ts`: `startWorker()`.
  - `index.ts`: entry point.
- `server/test/unit/*`, `server/test/delivery/*`, `server/test/worker/*`
- Test fixtures: `server/test/fixtures/tls/localhost.{key,crt}` and `server/test/helpers/servers.ts`. The helpers module provides local HTTP/HTTPS receivers that record requests, plus `waitFor()`.

Reused from Day 1:
- `withTransaction()` (`src/db/tx.ts`)
- `createPool()` (`src/db/pool.ts`)
- `loadConfig()` (`src/config.ts`): every worker/retry/security setting already exists.
- Test helpers `useTestDb` / `insertApp` / `insertEndpoint` (`test/helpers/db.ts`) and `buildTestApp` (`test/helpers/app.ts`).
- The structure of `src/api/start.ts` and `src/server.ts`, mirrored for the worker.

No new dependencies.

## Steps (one commit each, per-step process unchanged)

### Step 0 — `docs: add approved Day 2 plan`
Save this plan as `docs/plans/day2.md`. In PROGRESS.md, tick "Day 2 plan approved".

### Step 1 — `feat(delivery): add exponential backoff with jitter`
`computeBackoffMs(attempt, { baseMs, capMs }, random = Math.random)`:
- base = `min(cap, base · 2^(attempt−1))`, then × `(0.8 + 0.4·random())`, rounded to an integer.
- `random` is injected so tests are deterministic.

Tests:
- the schedule for attempts 1–8;
- the cap is reached;
- the jitter bounds at `random` = 0 and ≈1;
- attempt 100 doesn't overflow;
- invalid input (attempt < 1) throws.

### Step 2 — `feat(delivery): add Standard Webhooks signing and verification`
- `signPayload({ secret, msgId, timestamp, body: Buffer })` returns `v1,<base64 HMAC-SHA256(key, "{id}.{ts}." + body)>`. The key is the base64 decode of the secret after the `whsec_` prefix.
- `verifySignature({ secret, headers, body, toleranceSec = 300, nowSec })`:
  - rejects a timestamp outside the tolerance;
  - accepts any of the space-separated `v1,` signatures;
  - compares with `timingSafeEqual` (constant time);
  - returns a reason, never throws on bad input.

Tests:
- **the published Standard Webhooks/Svix test vector.** If it doesn't match, I stop and investigate; the expected value is never changed.
- Round trip with a generated secret.
- Tampered body, id or timestamp.
- Old or future timestamp.
- Several signatures, one of them valid.
- A malformed header.

### Step 3 — `feat(delivery): add IP classification for SSRF protection`
`isBlockedAddress(ip): { blocked: boolean, reason }`, using `node:net` `isIP` plus `BlockList`.

IPv4 ranges blocked:
- 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12
- 192.0.0/24, 192.0.2/24, 192.168/16
- 198.18/15, 198.51.100/24, 203.0.113/24
- 224/4, 240/4, 255.255.255.255

IPv6 follows D44.

Table tests (around 40 cases):
- each range's edges, e.g. `172.15.255.255` allowed, `172.16.0.0` blocked;
- `::1`, `fe80::1`, `fc00::1`, `ff02::1`;
- `::ffff:127.0.0.1` and its hex form `::ffff:7f00:1` (the URL parser produces the latter);
- `64:ff9b::a9fe:a9fe`;
- public v4 and v6 allowed;
- garbage input is blocked.

### Step 4 — `feat(delivery): add SSRF-safe HTTP client`
`createSafeHttpClient({ allowPrivateNetworks, allowHttp, timeoutMs, resolve? })` returns `{ post(url, headers, body) }`.

`post()` resolves to one of:
- `{ ok: true, status, excerpt, durationMs }`
- `{ ok: false, errorKind, errorMessage, status?, excerpt?, durationMs }`

It never rejects.

How it works:
1. Parse the URL and re-check its scheme. Reject an IP literal straight away if it is blocked (D43).
2. Call `node:http(s).request` with:
   - a custom `lookup`: resolve all addresses (injectable `resolve`, default `dns.lookup` with `all: true`), block if any is blocked (D42), and answer in the shape Node asked for (`options.all` → array, else one address). The socket connects to exactly the addresses that were validated, which defeats DNS rebinding.
   - `agent: false` (D48) and `servername` left as default, so TLS still verifies the certificate against the hostname.
3. One total deadline (`HTTP_TIMEOUT_MS`) covers DNS, connect, TLS, headers and body; when it fires the request is destroyed.
4. Never follow redirects: a 3xx is `http_status`.
5. Read at most 1024 bytes of the body, then destroy the socket (D47). Sanitise the excerpt with `excerpt.ts` (D46).
6. `classifyError(err)` (pure) maps each error to one `error_kind`:
   - `SsrfBlockedError` → `ssrf_blocked`
   - our deadline → `timeout`
   - `ENOTFOUND` / `EAI_AGAIN` → `dns`
   - `ERR_TLS_*` / `CERT_*` / `*_SELF_SIGNED_*` / `UNABLE_TO_VERIFY_*` → `tls`
   - anything else (`ECONNREFUSED`, `ECONNRESET`, …) → `connection`
   - non-2xx → `http_status`

`error_message` is at most 1024 characters and never contains headers.

Tests (local servers on 127.0.0.1 with port 0):
- 2xx; 500 is `http_status`; 302 to an internal address is not followed (the receiver gets 0 follow-up requests).
- A blocked loopback literal: **the server receives zero requests**.
- `[::1]`, `[::ffff:127.0.0.1]`.
- An injected resolver maps `evil.test` → 127.0.0.1 and is blocked; a mixed public + private answer is blocked.
- `allowPrivateNetworks: true` lets 127.0.0.1 through.
- `http:` is rejected unless `allowHttp` is set.
- A server that never responds gives `timeout` within roughly `timeoutMs`.
- A 10 MB body: excerpt ≤ 1024 and returns promptly. A body with NUL bytes is sanitised.
- `ECONNREFUSED` → `connection`.
- HTTPS with the test cert:
  - an untrusted cert → `tls`;
  - a trusted cert (passing `ca` through a test-only option) → ok, with the hostname checked against the pinned IP.

Excerpt unit tests: UTF-8 split across the 1024-byte cut, NUL stripping, character limit.

The test certificate is generated once with `openssl req -x509 … -subj /CN=localhost -addext subjectAltName=DNS:localhost`. I'll show the command before running it.

### Step 5 — `feat(worker): add delivery claim with SKIP LOCKED and leases`
`claimDeliveries(db, { limit, leaseMs, workerId })` runs T1 exactly as in day1.md §3, with `RETURNING … m.payload::text AS body, e.url, e.secret` (D45). The rows are joined with `UPDATE deliveries d … FROM due, messages m, endpoints e WHERE d.id = due.id AND m.id = d.message_id AND e.id = d.endpoint_id`.

A `limit` of 0 returns `[]` without a query.

Tests:
- **No double claim:** 200 pending rows, 8 concurrent claim loops with limit 7 on a pool of max 20. The union covers all 200; no row appears twice.
- Claimed rows have a lease, a fresh token, `locked_by`, and `attempt_count + 1`.
- Not claimed:
  - rows with a future `next_attempt_at`;
  - disabled endpoints;
  - a circuit `open` before `circuit_open_until`;
  - non-pending rows.
- The row is due again once `circuit_open_until` has passed.
- Oldest-due first.
- `limit` is respected.
- **The worker clock is ignored:** `vi.useFakeTimers({ toFake: ['Date'] })` with +1 h; rows due in 10 min are still not claimed.
- The body is exactly `payload::text`.

### Step 6 — `feat(worker): record delivery results with lease-token fencing`
`recordResult(pool, claim, outcome, { maxAttempts, backoffMs, workerId })` runs inside `withTransaction`:
1. The T2 (success) or T3 (failure, with the `CASE` on `attempt_count >= maxAttempts`) `UPDATE … WHERE id AND lease_token AND status='in_flight'`.
2. Only if it matched a row, insert the `delivery_attempts` row (`lease_token` = the claim's token, `attempt_number` = the claimed `attempt_count`).

It returns `'recorded' | 'lease_lost'`. On `lease_lost` it logs a warning with `delivery_id` and `lease_token` and inserts nothing. `last_error` is a short summary, e.g. `HTTP 503` or `timeout: …`.

Tests:
- success → `succeeded`, `completed_at` set, lease fields cleared, one attempt row;
- failure with attempts left → `pending`, `next_attempt_at ≈ now() + backoff` (DB clock);
- the last attempt → `dead` (**exhaustion**);
- **fencing:** a wrong token or a row no longer `in_flight` → `lease_lost`, the row is unchanged, no attempt row;
- a token whose lease expired but wasn't swept is still accepted (the fence is the token, not the clock);
- every `error_kind` passes the attempts `CHECK`s.

### Step 7 — `feat(worker): add lease sweeper for crashed attempts`
`sweepExpiredLeases(db, { maxAttempts })` runs T4 exactly as in day1.md §3 (batches of 100, looping while a batch is full) and returns the count.

Tests:
- **lease recovery:** setting `locked_until = now() − 1s` returns the row to `pending` with a `lease_expired` attempt carrying the old token and `locked_by`;
- exhausted → `dead`;
- unexpired leases are untouched;
- two concurrent sweepers write exactly one attempt row;
- **stale worker:** claim A → expire → sweep → claim B (new token) → A's `recordResult` returns `lease_lost`, and B's record succeeds;
- worker and sweeper racing on the same row never produce two attempt rows (`lease_token UNIQUE`).

### Step 8 — `feat(worker): add worker loop, signed delivery and graceful shutdown`
**`deliver.ts`, `deliverOne(claim, deps)`:**
- `Buffer.from(body)` once;
- headers: `content-type: application/json`, `webhook-id` = message id, `webhook-timestamp` = worker seconds (the invariant 7 exception), `webhook-signature`, `user-agent: Relay/0.1`;
- calls `client.post`;
- on failure, `backoffMs = computeBackoffMs(attempt_count)`;
- `durationMs` comes from `performance.now()` (D25);
- then `recordResult`.

**`worker.ts`, `createWorker({ config, pool, logger, client? })`, returns `{ start, stop }`:**
- Loop: `free = concurrency − inFlight`. If `free > 0`, call `claimDeliveries(limit: free)` and start a `deliverOne` for each row without awaiting it.
- If the claim came back full, loop again at once. Otherwise sleep `pollIntervalMs`, waking early when a slot frees up (an interruptible sleep built from a Promise, no libraries).
- A claim error (DB down) is logged at warn; the loop backs off by doubling up to 5 s and resets on success.
- The sweeper runs on its own `setTimeout` chain every `SWEEP_INTERVAL_MS`, never overlapping itself.
- `stop()`:
  1. stop claiming and sweeping;
  2. wait for in-flight deliveries for up to `httpTimeoutMs + 5 s` (each is bounded by the HTTP deadline);
  3. resolve, and the caller then ends the pool.

  Anything still unfinished is recovered by lease expiry.

**`start.ts`, `startWorker(config, logger)`:**
- pool with `application_name 'relay-worker'`, max = `min(concurrency, 18) + 2` (the extra two are for the claim and the sweeper);
- returns an idempotent `stop()`.

**`index.ts`:** mirrors `server.ts` (pino with redaction, SIGINT/SIGTERM handled once, a force-exit timer that is unref'd).

Add the `dev:worker` script: `node --env-file-if-exists=../.env --import tsx src/worker/index.ts`.

End-to-end tests (publish through `buildTestApp` → real worker → local receiver; config has `allowPrivateNetworks` and `allowHttp` on, a short lease and short retries):
- the receiver verifies the signature with `verifySignature` and gets the exact body, with `webhook-id` = message id;
- fan-out to 2 endpoints;
- a receiver that returns 500 twice then 200 → `succeeded` after 3 attempt rows;
- always 500 → `dead` after `MAX_ATTEMPTS`;
- **redelivery after a lost result reuses `webhook-id`:** claim and send without recording, expire, sweep, and the worker sends again with the same `webhook-id`;
- `pg_terminate_backend` on the worker's connections → the next message is still delivered;
- `stop()` waits for a slow in-flight request, and its result is recorded;
- concurrency is never exceeded (the receiver counts its peak of open requests).

### Step 9 — `docs: record Day 2 progress, decisions and commands`
- PROGRESS.md: tick Day 2, add D41–D50, limitations, session log.
- ARCHITECTURE.md:
  - §5 ports (D41) and the IP rules (D42–D44);
  - §4 claim `RETURNING`, excerpt, loop and shutdown.
- CLAUDE.md: `dev:worker` is no longer "not yet".
- day2.md: a departures section.

## Verification
- After every step: `npm test -w server` and `npm run typecheck` pass. Results are shown each time.
- Negative controls (temporary, then restored and reported) for the core guarantees:
  - remove `SKIP LOCKED` → the double-claim test fails;
  - remove the `lease_token` condition → the fencing test fails;
  - drop the IP-literal pre-check → the loopback test fails.
- Manual run after step 8:
  1. In your `.env` (you edit it; I don't touch it), set `ALLOW_HTTP_ENDPOINTS=true` and `RELAY_ALLOW_PRIVATE_NETWORKS=true`.
  2. Start `npm run dev:api -w server` and `npm run dev:worker -w server`.
  3. Start a one-line `node:http` receiver on port 4000 that prints the headers.
  4. Create an endpoint at `http://localhost:4000/hook` and publish with curl.
  5. `GET /v1/messages/:id` shows `succeeded`. Stop the receiver and publish again to watch the retries and then `dead`.

### Where implementation departed from this plan (all recorded in PROGRESS.md)
- Process: from step 2 on, several steps per session with Claude committing each step and one
  checkpoint report per session (agreed 2026-11-18). One commit per step was kept.
- Step 3: IP classification uses integer arithmetic instead of `node:net` `BlockList`
  (clearer; IPv6 needs its own parsing anyway to extract embedded IPv4) (D44).
- Step 4: a response status outside 100–599 is treated as a failure without a stored status
  (D52). The "public address passes" test was dropped: it would have made a real outbound
  connection; pass-through is covered by the IP-pinning test and the classification tests.
- Step 5: the planned negative control ("remove `SKIP LOCKED` → double-claim test fails") was
  wrong: `FOR UPDATE` alone still prevents double claims (it waits and re-checks). The row lock
  is pinned by the double-claim test, and `SKIP LOCKED` by a new no-wait test (D51).
- Step 6: `recordResult` returns the outcome and `deliverOne` logs it, instead of logging
  inside the SQL module (D53). An atomicity test (attempt INSERT fails → state change rolled
  back) was added.
- Step 8: added `test/worker/start.test.ts` (idempotent stop, fail-fast on an unreachable DB).
- Manual check: the dev database needs `npm run migrate -w server` first (only `relay_test` is
  migrated by the test setup).
