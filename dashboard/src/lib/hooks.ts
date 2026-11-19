import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isAbortError } from './api.js';
import { createPoller, type Poller, type Visibility } from './poller.js';
import { formatHash, parseHash, type Route } from './router.js';
import { applyPage, emptyList, type ListState, type Row } from './paging.js';
import type { Page } from './types.js';

export const POLL_INTERVAL_MS = 3000;

const documentVisibility: Visibility = {
  isHidden: () => document.visibilityState === 'hidden',
  onChange(listener) {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

export interface Polled<T> {
  data: T | undefined;
  error: unknown;
  /** True until the first response (success or error) for the current key. */
  loading: boolean;
  refresh: () => void;
}

/**
 * Load `load()` now and every 3 s while the tab is visible (see poller.ts). When `key`
 * changes (another id, another filter) the old poller is disposed: its request is aborted
 * and a late answer is dropped, so a slow response for the previous view can never
 * overwrite the current one. `key` is a string so the dependency is explicit and stable.
 */
export function usePolled<T>(load: (signal: AbortSignal) => Promise<T>, key: string): Polled<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const poller = useRef<Poller | undefined>(undefined);
  // The latest load function, without restarting the poller on every render.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    setState({ data: undefined, error: undefined, loading: true });
    const p = createPoller({
      intervalMs: POLL_INTERVAL_MS,
      visibility: documentVisibility,
      task: async (signal) => {
        try {
          const data = await loadRef.current(signal);
          if (!signal.aborted) setState({ data, error: undefined, loading: false });
        } catch (err) {
          if (signal.aborted || isAbortError(err)) return;
          // Keep the last good data on screen; show the error next to it.
          setState((s) => ({ data: s.data, error: err, loading: false }));
        }
      },
    });
    poller.current = p;
    return () => p.dispose();
  }, [key]);

  const refresh = useCallback(() => poller.current?.refresh(), []);
  return { ...state, refresh };
}

/** Re-renders every `ms` so relative times ("12 s ago") stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// --- routing ---------------------------------------------------------------------------

function subscribeHash(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return parseHash(hash);
}

export function navigate(route: Route): void {
  window.location.hash = formatHash(route);
}

// --- paged lists -------------------------------------------------------------------------

export interface PagedList<T extends Row> {
  rows: T[];
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

/**
 * A newest-first list: the first page is polled every 3 s; "Load more" appends older pages.
 * How the pages are merged (and why rows never vanish or linger) is in paging.ts. When `key`
 * (the filter) changes the list starts over, and answers for the old key are dropped.
 */
export function usePagedList<T extends Row>(
  fetchPage: (cursor: string | undefined, signal?: AbortSignal) => Promise<Page<T>>,
  key: string,
): PagedList<T> {
  const [list, setList] = useState<{ key: string; state: ListState<T> }>({ key, state: emptyList<T>() });
  const [more, setMore] = useState<{ loading: boolean; error: unknown }>({ loading: false, error: undefined });
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
    setMore({ loading: false, error: undefined });
  }, [key]);

  const head = usePolled(async (signal) => {
    const page = await fetchPage(undefined, signal);
    if (!signal.aborted) {
      setList((l) => ({ key, state: applyPage(l.key === key ? l.state : emptyList<T>(), page, 'head') }));
    }
    return true;
  }, key);

  const current = list.key === key ? list.state : emptyList<T>();
  const cursor = current.nextCursor;

  const loadMore = useCallback(() => {
    if (!cursor) return;
    const requestedFor = keyRef.current;
    setMore({ loading: true, error: undefined });
    fetchPage(cursor)
      .then((page) => {
        if (keyRef.current !== requestedFor) return;
        setList((l) => (l.key === requestedFor ? { key: l.key, state: applyPage(l.state, page, 'more') } : l));
        setMore({ loading: false, error: undefined });
      })
      .catch((err: unknown) => {
        if (keyRef.current === requestedFor) setMore({ loading: false, error: err });
      });
  }, [cursor, fetchPage]);

  return {
    rows: current.rows,
    loading: head.loading,
    error: head.error ?? more.error,
    hasMore: cursor !== null,
    loadingMore: more.loading,
    loadMore,
    refresh: head.refresh,
  };
}
