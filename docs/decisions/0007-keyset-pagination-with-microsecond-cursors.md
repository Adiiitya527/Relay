# 0007 — Keyset pagination with microsecond cursors

- Status: accepted (Day 1, 2026-11-17)
- Related: PROGRESS D33, D59, D67; ARCHITECTURE §6, §7

## Context
Message and delivery lists grow without bound and change while they are read. `OFFSET`
gets slower with depth and skips or repeats rows when new ones are inserted.

## Decision
- Order by `(created_at DESC, id DESC)`; the next page is `(created_at, id) < (cursor)`,
  an index range scan.
- The cursor is opaque base64url of `<created_at in epoch microseconds>|<id>`, computed in
  SQL. A JavaScript `Date` keeps only milliseconds, and a millisecond cursor silently skips
  rows created in the same millisecond (shown by a test).
- Optional filters are one static statement with `($n IS NULL OR column = $n)`; node-postgres
  sends unnamed statements, so Postgres plans with the real values and the unused branches
  fold away (checked with `EXPLAIN` on 50 000 rows).
- The dashboard merges a polled first page with "Load more" pages by treating every page as
  authoritative for the range it covers (D67).

## Consequences
- Pages cost O(limit) at any depth and never skip or repeat rows.
- The cursor is not signed: tampering only moves the caller within their own tenant's list.
- A row whose transaction commits late can appear "behind" a page already read; acceptable
  for an operator view.
