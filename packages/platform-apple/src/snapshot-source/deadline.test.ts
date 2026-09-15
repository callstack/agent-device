import { getEventListeners } from 'node:events';
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

test('a delay called with no stop, the way every lifecycle site sends it, leaves no listener behind', async () => {
  vi.useFakeTimers();
  try {
    const caller = new AbortController();
    const deadline = createSnapshotSourceDeadline(60_000, caller.signal);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const waiting = waitForSnapshotSourceDelay(deadline, 1_000, WAIT_CODE);
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
    }

    expect(getEventListeners(caller.signal, 'abort').length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
