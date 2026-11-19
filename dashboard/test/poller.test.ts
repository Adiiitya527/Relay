import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller, type Visibility } from '../src/lib/poller.js';

/** A controllable stand-in for document.visibilityState. */
function fakeVisibility(hidden = false) {
  const listeners = new Set<() => void>();
  const v: Visibility & { set(hidden: boolean): void; listeners: Set<() => void> } = {
    listeners,
    isHidden: () => hidden,
    onChange: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(next) {
      hidden = next;
      for (const l of listeners) l();
    },
  };
  return v;
}

/** A task whose runs can be resolved by hand, to observe overlap. */
function manualTask() {
  const pending: (() => void)[] = [];
  const signals: AbortSignal[] = [];
  let active = 0;
  let maxActive = 0;
  const task = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve) =>
      pending.push(() => {
        active -= 1;
        resolve();
      }),
    );
  });
  return {
    task,
    signals,
    finishNext: async () => {
      pending.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    },
    get maxActive() {
      return maxActive;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createPoller', () => {
  it('runs at once, then every interval after the previous run finished', async () => {
    const t = manualTask();
    const poller = createPoller({ intervalMs: 3000, task: t.task });
    expect(t.task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000); // first run still in progress: no new run
    expect(t.task).toHaveBeenCalledTimes(1);

    await t.finishNext();
    await vi.advanceTimersByTimeAsync(2999);
    expect(t.task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.task).toHaveBeenCalledTimes(2);
    expect(t.maxActive).toBe(1);
    poller.dispose();
  });

  it('refresh() during a run queues exactly one follow-up run, never a parallel one', async () => {
    const t = manualTask();
    const poller = createPoller({ intervalMs: 3000, task: t.task });
    poller.refresh();
    poller.refresh();
    expect(t.task).toHaveBeenCalledTimes(1);
    await t.finishNext();
    expect(t.task).toHaveBeenCalledTimes(2); // the queued refresh
    await t.finishNext();
    expect(t.task).toHaveBeenCalledTimes(2); // back to the normal schedule
    expect(t.maxActive).toBe(1);
    poller.dispose();
  });

  it('pauses while hidden and runs at once when visible again', async () => {
    const visibility = fakeVisibility();
    const t = manualTask();
    const poller = createPoller({ intervalMs: 3000, task: t.task, visibility });
    await t.finishNext();
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.task).toHaveBeenCalledTimes(1);
    visibility.set(false);
    expect(t.task).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('a run that finishes while hidden schedules nothing', async () => {
    const visibility = fakeVisibility();
    const t = manualTask();
    const poller = createPoller({ intervalMs: 3000, task: t.task, visibility });
    visibility.set(true);
    await t.finishNext();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.task).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('keeps polling after an error and reports it', async () => {
    const onError = vi.fn();
    const task = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const poller = createPoller({ intervalMs: 1000, task, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('dispose() aborts the in-flight request, stops, and unsubscribes', async () => {
    const visibility = fakeVisibility();
    const onError = vi.fn();
    const t = manualTask();
    const poller = createPoller({ intervalMs: 1000, task: t.task, visibility, onError });
    poller.dispose();
    expect(t.signals[0]!.aborted).toBe(true);
    expect(visibility.listeners.size).toBe(0);
    await t.finishNext();
    poller.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.task).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
