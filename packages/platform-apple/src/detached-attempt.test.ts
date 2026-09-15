import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test, vi } from 'vitest';
import { createDetachedAttempts, waitForDetachedAttempt } from './detached-attempt.ts';

const PENDING = new Error('still-running');

/** A wait whose slice is instantly spent, which is how a caller reports "still running". */
const spentWait = (calls: { count: number }) => async () => {
  calls.count += 1;
};

test('one attempt answers every caller that arrives while it runs', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20 });
  let release = () => {};
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  const waitCalls = { count: 0 };
  const params = {
    start: async () => {
      starts += 1;
      await running;
      return 7;
    },
    wait: spentWait(waitCalls),
    pending: () => PENDING,
  };

  const first = await attempts.value('key', params).then(() => undefined, identity);
  const second = await attempts.value('key', params).then(() => undefined, identity);

  assert.equal(first, PENDING);
  assert.equal(second, PENDING);
  assert.equal(starts, 1);

  release();
  await settle();
  assert.equal(await attempts.value('key', params), 7);
});

test('the first-caller grant spends the wait budget once per attempt', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20, waitGrant: 'first-caller' });
  let release = () => {};
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitCalls = { count: 0 };
  const params = {
    start: async () => {
      await running;
      return 7;
    },
    wait: spentWait(waitCalls),
    pending: () => PENDING,
  };

  await assert.rejects(attempts.value('key', params), (error) => error === PENDING);
  await assert.rejects(attempts.value('key', params), (error) => error === PENDING);
  assert.equal(waitCalls.count, 1);

  release();
  await settle();
  assert.equal(await attempts.value('key', params), 7);
});

test('the every-caller grant lets each capture wait for the same attempt', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20 });
  let release = () => {};
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitCalls = { count: 0 };
  const params = {
    start: async () => {
      await running;
      return 7;
    },
    wait: spentWait(waitCalls),
    pending: () => PENDING,
  };

  await assert.rejects(attempts.value('key', params), (error) => error === PENDING);
  await assert.rejects(attempts.value('key', params), (error) => error === PENDING);
  assert.equal(waitCalls.count, 2);
  release();
});

test('a caller that waits while the attempt settles is served the value', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20 });
  let release = () => {};
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = attempts.value('key', {
    start: async () => {
      await running;
      return 7;
    },
    wait: async () => {
      await running;
    },
    pending: () => PENDING,
  });

  release();
  assert.equal(await started, 7);
});

test('the retry window is measured from the failure, not from the start of the attempt', async () => {
  let clockMs = 0;
  const attempts = createDetachedAttempts<number>({
    waitMs: 20,
    retryAfterMs: 60_000,
    now: () => clockMs,
  });
  let starts = 0;
  const params = {
    start: async () => {
      starts += 1;
      // A cold host can spend the whole window building before it fails at all.
      clockMs += 90_000;
      throw new Error('build-failed');
    },
    wait: async () => {},
    pending: () => PENDING,
  };

  await assert.rejects(attempts.value('key', params), /build-failed/);
  assert.equal(starts, 1);
  await assert.rejects(attempts.value('key', params), /build-failed/);
  assert.equal(starts, 1);

  clockMs += 60_001;
  await assert.rejects(attempts.value('key', params), /build-failed/);
  assert.equal(starts, 2);
});

test('without a retry window the next caller starts a fresh attempt', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20 });
  let starts = 0;
  const params = {
    start: async () => {
      starts += 1;
      throw new Error('probe-failed');
    },
    wait: async () => {},
    pending: () => PENDING,
  };

  await assert.rejects(attempts.value('key', params), /probe-failed/);
  await assert.rejects(attempts.value('key', params), /probe-failed/);
  assert.equal(starts, 2);
});

test('close aborts a running attempt and the next caller starts its own', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20 });
  let release = () => {};
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: AbortSignal[] = [];
  const params = {
    start: async (signal: AbortSignal) => {
      seen.push(signal);
      await running;
      return 7;
    },
    wait: async () => {},
    pending: () => PENDING,
  };

  await assert.rejects(attempts.value('key', params), (error) => error === PENDING);
  assert.equal(seen[0]?.aborted, false);

  attempts.close();
  assert.equal(seen[0]?.aborted, true);

  await assert.rejects(attempts.value('key', params), (error) => error === PENDING);
  assert.equal(seen.length, 2);
  release();
});

test('a wait that rejects with the caller own cancellation stays that cancellation', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20 });
  const cancelled = new Error('cancelled-by-request');

  await assert.rejects(
    attempts.value('key', {
      start: async () => 7,
      wait: () => Promise.reject(cancelled),
      pending: () => PENDING,
    }),
    (error) => error === cancelled,
  );
});

test('an attempt that throws before awaiting is reported as its own failure', async () => {
  const attempts = createDetachedAttempts<number>({ waitMs: 20 });

  await assert.rejects(
    attempts.value('key', {
      start: () => {
        throw new Error('source-missing');
      },
      wait: async () => {},
      pending: () => PENDING,
    }),
    /source-missing/,
  );
});

test('a caller answered by the attempt stops the wait it left running', async () => {
  const attempts = createDetachedAttempts<string>({ waitMs: 60_000 });
  let releaseBuild: (value: string) => void = () => {};
  const building = new Promise<string>((resolve) => {
    releaseBuild = resolve;
  });
  let stopSignal: AbortSignal | undefined;
  let waitState: 'pending' | 'resolved' = 'pending';

  const caller = attempts.value('bridge', {
    start: () => building,
    // Deliberately has no timer of its own: only the stop can end it, so a wait that is never
    // stopped stays observable as `pending` instead of quietly expiring.
    wait: (_waitMs, stop) => {
      stopSignal = stop;
      return new Promise<void>((resolve) => {
        stop.addEventListener(
          'abort',
          () => {
            waitState = 'resolved';
            resolve();
          },
          { once: true },
        );
      });
    },
    pending: () => PENDING,
  });

  await settle();
  assert.equal(waitState, 'pending');
  releaseBuild('binary');
  assert.equal(await caller, 'binary');
  await settle();

  assert.ok(stopSignal?.aborted, 'the losing wait is stopped once the attempt settles');
  assert.equal(waitState, 'resolved');
});

test('a wait that settles by its own timeout releases the stop listener it added', async () => {
  vi.useFakeTimers();
  try {
    const stop = new AbortController();
    const waiting = waitForDetachedAttempt({
      waitMs: 20,
      signal: undefined,
      stop: stop.signal,
      cancelled: () => new Error('unreachable'),
    });

    await vi.advanceTimersByTimeAsync(20);
    await waiting;

    assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  } finally {
    vi.useRealTimers();
  }
});

test('a caller signal already aborted rejects at once, without spending waitMs', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const stop = new AbortController();
    const reason = new Error('already-cancelled');
    controller.abort(reason);

    const waiting = waitForDetachedAttempt({
      waitMs: 60_000,
      signal: controller.signal,
      stop: stop.signal,
      cancelled: () => reason,
    });

    await assert.rejects(waiting, (error) => error === reason);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  } finally {
    vi.useRealTimers();
  }
});

test('a stop already aborted resolves at once, without spending waitMs', async () => {
  vi.useFakeTimers();
  try {
    const stop = new AbortController();
    stop.abort();

    const waiting = waitForDetachedAttempt({
      waitMs: 60_000,
      signal: undefined,
      stop: stop.signal,
      cancelled: () => new Error('unreachable'),
    });

    await waiting;
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  } finally {
    vi.useRealTimers();
  }
});

function identity(error: unknown): unknown {
  return error;
}

/** Lets a released attempt reach the settle handler before the next read. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
