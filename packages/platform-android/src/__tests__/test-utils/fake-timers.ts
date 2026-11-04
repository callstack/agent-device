import { vi } from 'vitest';

/**
 * How far the clock moves per step. One step awaits a real event-loop turn, so every turn a session
 * reply still needs burns this much of the clock. A reply crossing a real loopback socket takes
 * several turns: at 10 ms the polling helper's own interval fired ahead of the reply it was waiting
 * for, and the deadline was reached a sample or two early.
 */
const CLOCK_STEP_MS = 1;

/**
 * Runs `run` with its sleeps advanced instead of waited out. The clock moves in slices much shorter
 * than a poll interval, so a helper session's own timers never fire ahead of its replies.
 */
export async function underFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    let done = false;
    const outcome = run().finally(() => {
      done = true;
    });
    outcome.catch(() => {});
    while (!done) await vi.advanceTimersByTimeAsync(CLOCK_STEP_MS);
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}
