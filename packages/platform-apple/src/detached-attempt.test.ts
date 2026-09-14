import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDetachedAttempts } from './detached-attempt.ts';

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

function identity(error: unknown): unknown {
  return error;
}

/** Lets a released attempt reach the settle handler before the next read. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
