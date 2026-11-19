import { describe, expect, it } from 'vitest';
import { applyPage, compareRows, emptyList, parsePayloadInput, type ListState } from '../src/lib/paging.js';

interface R {
  id: string;
  created_at: string;
  status?: string;
}

/** Row n: higher n = newer. Two rows can share a timestamp (same transaction). */
const row = (n: number, status = 'dead', sameTimeAs?: number): R => ({
  id: `id-${String(n).padStart(3, '0')}`,
  created_at: new Date(Date.UTC(2026, 10, 19, 12, 0, sameTimeAs ?? n)).toISOString(),
  status,
});
const ids = (s: ListState<R>) => s.rows.map((r) => r.id);
const page = (rows: R[], next: string | null) => ({ data: rows, next_cursor: next });

describe('compareRows', () => {
  it('orders newest first, ties by id descending, like the API', () => {
    const rows = [row(1), row(3), row(2), { id: 'id-zzz', created_at: row(2).created_at }];
    expect(rows.sort(compareRows).map((r) => r.id)).toEqual(['id-003', 'id-zzz', 'id-002', 'id-001']);
  });
});

describe('applyPage', () => {
  it('head page then load more: rows appended, cursor taken from the last loaded page', () => {
    let s = applyPage(emptyList<R>(), page([row(10), row(9), row(8)], 'c1'), 'head');
    expect(s).toMatchObject({ nextCursor: 'c1', loadedMore: false });
    s = applyPage(s, page([row(7), row(6), row(5)], 'c2'), 'more');
    expect(ids(s)).toEqual(['id-010', 'id-009', 'id-008', 'id-007', 'id-006', 'id-005']);
    expect(s).toMatchObject({ nextCursor: 'c2', loadedMore: true });
  });

  it('a later head poll does not reset the load-more cursor or drop older loaded rows', () => {
    let s = applyPage(emptyList<R>(), page([row(10), row(9), row(8)], 'c1'), 'head');
    s = applyPage(s, page([row(7), row(6), row(5)], 'c2'), 'more');
    // Two new rows arrive; the head page now ends at row 9, so row 8 is outside its range.
    s = applyPage(s, page([row(12), row(11), row(10)], 'c3'), 'head');
    expect(ids(s)).toEqual(['id-012', 'id-011', 'id-010', 'id-009', 'id-008', 'id-007', 'id-006', 'id-005']);
    expect(s.nextCursor).toBe('c2');
  });

  it('a row that left the filter disappears when a page covering it arrives (replayed dead delivery)', () => {
    let s = applyPage(emptyList<R>(), page([row(10), row(9), row(8)], null), 'head');
    // row 9 was replayed: no longer in ?status=dead
    s = applyPage(s, page([row(10), row(8)], null), 'head');
    expect(ids(s)).toEqual(['id-010', 'id-008']);
  });

  it('a full head page only drops missing rows inside its own range', () => {
    let s = applyPage(emptyList<R>(), page([row(10), row(9)], 'c1'), 'head');
    s = applyPage(s, page([row(8), row(7)], 'c2'), 'more');
    // row 9 left the filter; the head page now reaches down to row 8
    s = applyPage(s, page([row(10), row(8)], 'c3'), 'head');
    expect(ids(s)).toEqual(['id-010', 'id-008', 'id-007']);
  });

  it('an empty head page clears everything (e.g. the DLQ after "replay all")', () => {
    let s = applyPage(emptyList<R>(), page([row(10), row(9)], 'c1'), 'head');
    s = applyPage(s, page([row(8)], null), 'more');
    s = applyPage(s, page([], null), 'head');
    expect(s).toEqual({ rows: [], nextCursor: null, loadedMore: false });
  });

  it('the newest version of a row wins (status changed between polls)', () => {
    let s = applyPage(emptyList<R>(), page([row(2, 'pending'), row(1, 'pending')], null), 'head');
    s = applyPage(s, page([row(2, 'succeeded'), row(1, 'pending')], null), 'head');
    expect(s.rows.map((r) => r.status)).toEqual(['succeeded', 'pending']);
  });

  it('a load-more page only replaces rows within its own range', () => {
    let s = applyPage(emptyList<R>(), page([row(10), row(9)], 'c1'), 'head');
    s = applyPage(s, page([row(8), row(6)], 'c2'), 'more');
    s = applyPage(s, page([row(5)], null), 'more');
    expect(ids(s)).toEqual(['id-010', 'id-009', 'id-008', 'id-006', 'id-005']);
    expect(s.nextCursor).toBeNull();
  });

  it('never duplicates a row that moved between pages', () => {
    let s = applyPage(emptyList<R>(), page([row(5), row(4)], 'c1'), 'head');
    s = applyPage(s, page([row(4), row(3)], 'c2'), 'more'); // row 4 again (rows shifted)
    expect(ids(s)).toEqual(['id-005', 'id-004', 'id-003']);
  });
});

describe('parsePayloadInput', () => {
  it('accepts a JSON object', () => {
    expect(parsePayloadInput('{"order": 42, "nested": {"a": [1]}}')).toEqual({ ok: true, payload: { order: 42, nested: { a: [1] } } });
  });
  it.each(['[1,2]', 'null', '42', '"text"', '{bad json', ''])('rejects %j', (text) => {
    expect(parsePayloadInput(text).ok).toBe(false);
  });
});
