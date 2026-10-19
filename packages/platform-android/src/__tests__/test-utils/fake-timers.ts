import { vi } from 'vitest';

/**
 * Runs `run` with its sleeps advanced instead of waited out. The clock moves in slices shorter than
 * a poll interval, so a helper session's own timers never fire ahead of its replies.
 */
export async function underFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    let done = false;
    const outcome = run().finally(() => {
      done = true;
    });
    outcome.catch(() => {});
    while (!done) await vi.advanceTimersByTimeAsync(10);
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}
