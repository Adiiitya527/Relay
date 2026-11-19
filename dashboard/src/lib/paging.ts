// Combining a polled first page with "Load more" pages of a newest-first, keyset-paginated
// list (messages, deliveries).
//
// Rules:
//   - Rows are ordered like the API: created_at DESC, id DESC.
//   - A fetched page is AUTHORITATIVE for the range it covers: every row we hold inside
//     that range but missing from the page is dropped. This matters when a row leaves a
//     filter (a dead delivery that was replayed is no longer in ?status=dead) and when rows
//     shift between pages as new ones arrive. A page with no next_cursor covers everything
//     older than its first row too, so it is authoritative to the end.
//   - Rows fetched by "Load more" stay (they are older than the head page) until a later
//     fetch covers their range again.
//   - The cursor for the next "Load more" comes from the head page until the user loads
//     more, then from the last loaded page.

export interface Row {
  id: string;
  created_at: string;
}

export interface ListState<T extends Row> {
  rows: T[];
  nextCursor: string | null;
  loadedMore: boolean;
}

export function emptyList<T extends Row>(): ListState<T> {
  return { rows: [], nextCursor: null, loadedMore: false };
}

/** -1 if a sorts before b (a is newer), like ORDER BY created_at DESC, id DESC. */
export function compareRows(a: Row, b: Row): number {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

export function applyPage<T extends Row>(
  state: ListState<T>,
  page: { data: T[]; next_cursor: string | null },
  kind: 'head' | 'more',
): ListState<T> {
  const fetched = new Map(page.data.map((r) => [r.id, r]));
  const first = page.data[0];
  const last = page.data.at(-1);

  // The range this page is authoritative for. A head page starts at "newest" whatever its
  // first row is; a page without next_cursor extends to the end.
  const covers = (r: Row): boolean => {
    if (page.data.length === 0) return kind === 'head' ? true : false;
    const fromTop = kind === 'head' || (first !== undefined && compareRows(r, first) >= 0);
    const toEnd = page.next_cursor === null || (last !== undefined && compareRows(r, last) <= 0);
    return fromTop && toEnd;
  };

  const kept = state.rows.filter((r) => !fetched.has(r.id) && !covers(r));
  const rows = [...kept, ...fetched.values()].sort(compareRows);

  if (kind === 'more') return { rows, nextCursor: page.next_cursor, loadedMore: true };
  // An empty or short head page that covers everything also resets "load more".
  if (page.next_cursor === null) return { rows, nextCursor: null, loadedMore: false };
  return { rows, nextCursor: state.loadedMore ? state.nextCursor : page.next_cursor, loadedMore: state.loadedMore };
}

/** The payload field of the "send test event" form: must be a JSON object, like the API. */
export function parsePayloadInput(text: string): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `Not valid JSON: ${(err as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'The payload must be a JSON object, e.g. {"order": 42}' };
  }
  return { ok: true, payload: value as Record<string, unknown> };
}
