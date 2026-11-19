// Polling without overlap, paused while the tab is hidden.
//
//   - The task runs at once, then `intervalMs` after the previous run FINISHED (setTimeout
//     chain, not setInterval), so a slow API never gets a pile of concurrent requests.
//   - While the page is hidden nothing is scheduled; becoming visible runs the task at once.
//   - refresh() runs it now (after a user action, e.g. replay); if a run is in progress, one
//     more run follows it instead of starting a second request in parallel.
//   - dispose() aborts the in-flight request (its AbortSignal) and stops for good. The
//     caller checks `signal.aborted` before using a result, so a response that arrives after
//     the view changed is ignored.

export interface Visibility {
  isHidden(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}

export interface PollerOptions {
  intervalMs: number;
  task: (signal: AbortSignal) => Promise<void>;
  onError?: (err: unknown) => void;
  visibility?: Visibility;
}

export interface Poller {
  refresh(): void;
  dispose(): void;
}

export function createPoller({ intervalMs, task, onError, visibility }: PollerOptions): Poller {
  let disposed = false;
  let running = false;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const hidden = () => visibility?.isHidden() ?? false;

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || hidden()) return;
    timer = setTimeout(run, intervalMs);
  }

  async function run() {
    clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    controller = new AbortController();
    try {
      await task(controller.signal);
    } catch (err) {
      if (!disposed) onError?.(err);
    } finally {
      running = false;
    }
    if (rerun && !disposed) {
      rerun = false;
      void run();
    } else {
      schedule();
    }
  }

  const unsubscribe = visibility?.onChange(() => {
    if (disposed) return;
    if (hidden()) {
      clearTimeout(timer);
      timer = undefined;
    } else if (!running && timer === undefined) {
      void run();
    }
  });

  void run();

  return {
    refresh() {
      void run();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      unsubscribe?.();
    },
  };
}
