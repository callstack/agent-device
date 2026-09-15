import { expect, test, vi } from 'vitest';
import { createSnapshotSourceDeadline, waitForSnapshotSourceDelay } from './deadline.ts';
import { SnapshotSourceError } from './errors.ts';

const WAIT_CODE = 'bridge-preparation-pending';

test('a stopped delay returns without spending the rest of the deadline', async () => {
  vi.useFakeTimers();
  try {
    const stop = new AbortController();
    const deadline = createSnapshotSourceDeadline(60_000, undefined);
    let settled = false;
    const waiting = waitForSnapshotSourceDelay(deadline, 60_000, WAIT_CODE, stop.signal).then(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    stop.abort();
    await waiting;

    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('an aborted caller signal stays typed cancellation next to a stop', async () => {
  vi.useFakeTimers();
  try {
    const caller = new AbortController();
    const stop = new AbortController();
    const deadline = createSnapshotSourceDeadline(60_000, caller.signal);
    const waiting = waitForSnapshotSourceDelay(deadline, 60_000, WAIT_CODE, stop.signal);

    caller.abort();
    await expect(waiting).rejects.toBeInstanceOf(SnapshotSourceError);
    await expect(waiting).rejects.toMatchObject({
      failureKind: 'cancelled',
      failureCode: 'abort-signal',
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
