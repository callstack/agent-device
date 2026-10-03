import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import { observeUntil, type ObservationClock } from './observe-until.ts';

/** A clock that advances only when the loop sleeps or a capture declares its own cost. */
function fakeClock(): ObservationClock & { advance(ms: number): void; slept: number[] } {
  let nowMs = 1_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
    sleep: async (ms) => {
      slept.push(ms);
      nowMs += ms;
    },
  };
}

/** No per-capture deadline: the engine default. */
const UNBOUNDED_SCHEDULE = { intervalMs: 200, budgetMs: 1_000 } as const;
const SCHEDULE = { ...UNBOUNDED_SCHEDULE, captureDeadline: 'cancel' } as const;

/** The Android helper's content verdict: the capture ran but held no readable app content. */
function unreadableContent(): AppError {
  return new AppError('COMMAND_FAILED', 'no readable content', {
    androidSnapshotHelperFailureReason: 'system-window-only',
  });
}

describe('observeUntil', () => {
  test('answers done on the poll whose verdict accepts, with the timeline', async () => {
    const clock = fakeClock();
    let captures = 0;
    const observed = await observeUntil({
      capture: async () => {
        captures += 1;
        clock.advance(50);
        return captures;
      },
      verdict: (latest) =>
        latest >= 3 ? { kind: 'done', result: `seen ${latest}` } : { kind: 'continue' },
      schedule: SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'done');
    assert.equal(observed.kind === 'done' && observed.result, 'seen 3');
    assert.equal(observed.polls.length, 3);
    assert.deepEqual(clock.slept, [200, 200]);
    assert.equal(observed.waitedMs, 550);
  });

  test('expires when the budget runs out while the verdict still continues, keeping the last value', async () => {
    const clock = fakeClock();
    let captures = 0;
    const observed = await observeUntil({
      capture: async () => {
        captures += 1;
        return captures;
      },
      verdict: () => ({ kind: 'continue' }),
      schedule: SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'expired');
    assert.equal(observed.kind === 'expired' && observed.last, 6);
    assert.equal(observed.polls.length, 6);
    assert.equal(observed.waitedMs, 1_000);
  });

  test('rides out only the errors the caller classifies, and keeps polling', async () => {
    const clock = fakeClock();
    let captures = 0;
    const observed = await observeUntil({
      capture: async () => {
        captures += 1;
        if (captures === 1) throw unreadableContent();
        return captures;
      },
      verdict: (latest) => ({ kind: 'done', result: latest }),
      schedule: SCHEDULE,
      rideOut: isUnreadableCaptureContentError,
      clock,
    });
    assert.equal(observed.kind, 'done');
    assert.deepEqual(
      observed.polls.map((poll) => poll.outcome),
      ['rode-out', 'observed'],
    );
  });

  test('fails on the first error the caller does not ride out', async () => {
    const clock = fakeClock();
    const failure = new AppError('COMMAND_FAILED', 'wedged');
    const observed = await observeUntil({
      capture: async () => {
        throw failure;
      },
      verdict: () => ({ kind: 'continue' }),
      schedule: SCHEDULE,
      rideOut: isUnreadableCaptureContentError,
      clock,
    });
    assert.equal(observed.kind, 'failed');
    assert.equal(observed.kind === 'failed' && observed.error, failure);
    assert.deepEqual(
      observed.polls.map((poll) => poll.outcome),
      ['failed'],
    );
  });

  test('reports the last ridden-out error when every poll was ridden out', async () => {
    const clock = fakeClock();
    const failures: AppError[] = [];
    const observed = await observeUntil<number, number>({
      capture: async () => {
        const failure = unreadableContent();
        failures.push(failure);
        throw failure;
      },
      verdict: (latest) => ({ kind: 'done', result: latest }),
      schedule: SCHEDULE,
      rideOut: isUnreadableCaptureContentError,
      clock,
    });
    assert.equal(observed.kind, 'expired');
    assert.equal(observed.kind === 'expired' && observed.last, undefined);
    assert.equal(observed.kind === 'expired' && observed.lastError, failures.at(-1));
    assert.ok(observed.polls.every((poll) => poll.outcome === 'rode-out'));
  });

  test('cancels and joins a capture still in flight at the deadline', async () => {
    let aborted = false;
    const observed = await observeUntil({
      capture: (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            setTimeout(() => resolve(1), 5);
          });
        }),
      verdict: () => ({ kind: 'done', result: true }),
      schedule: { intervalMs: 5, budgetMs: 20, captureDeadline: 'cancel' },
    });
    assert.equal(observed.kind, 'stalled');
    assert.equal(aborted, true);
    assert.deepEqual(
      observed.polls.map((poll) => poll.outcome),
      ['stalled'],
    );
  });

  test('always completes minPolls even past the budget, so a quiet pair can form', async () => {
    const clock = fakeClock();
    let captures = 0;
    const observed = await observeUntil({
      capture: async () => {
        captures += 1;
        clock.advance(1_000);
        return captures;
      },
      verdict: (latest, previous) =>
        previous !== undefined
          ? { kind: 'done', result: [previous, latest] }
          : { kind: 'continue' },
      schedule: { ...UNBOUNDED_SCHEDULE, minPolls: 2 },
      clock,
    });
    assert.equal(observed.kind, 'done');
    assert.deepEqual(observed.kind === 'done' && observed.result, [1, 2]);
  });

  test('a verdict can raise the budget but never lower it', async () => {
    const clock = fakeClock();
    let captures = 0;
    const observed = await observeUntil({
      capture: async () => {
        captures += 1;
        return captures;
      },
      verdict: (latest) =>
        latest === 1 ? { kind: 'continue', budgetMs: 2_000 } : { kind: 'continue', budgetMs: 100 },
      schedule: SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'expired');
    assert.equal(observed.waitedMs, 2_000);
  });

  test('judges an initial value before spending a poll', async () => {
    const clock = fakeClock();
    let captures = 0;
    const observed = await observeUntil({
      capture: async () => {
        captures += 1;
        return captures;
      },
      verdict: (latest) => ({ kind: 'done', result: latest }),
      schedule: SCHEDULE,
      initial: 42,
      clock,
    });
    assert.equal(observed.kind === 'done' && observed.value, 42);
    assert.equal(captures, 0);
    assert.equal(observed.polls.length, 0);
  });
});

describe('observeUntil cancellation', () => {
  test('a signal aborted during the sleep ends the loop canceled before another capture', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    let captures = 0;
    await assert.rejects(
      observeUntil({
        capture: async () => {
          captures += 1;
          return captures;
        },
        verdict: () => ({ kind: 'continue' }),
        schedule: UNBOUNDED_SCHEDULE,
        signal: controller.signal,
        clock: {
          now: clock.now,
          sleep: async (ms) => {
            await clock.sleep(ms);
            controller.abort();
          },
        },
      }),
      (error) => error instanceof AppError && error.details?.reason === 'request_canceled',
    );
    assert.equal(captures, 1);
  });
});

describe('observeUntil budgetFrom first-capture', () => {
  test('never bounds the first capture and spends the budget only on retries', async () => {
    const clock = fakeClock();
    let captures = 0;
    const observed = await observeUntil({
      capture: async () => {
        captures += 1;
        if (captures === 1) clock.advance(5_000);
        return captures;
      },
      verdict: (latest) => (latest === 3 ? { kind: 'done', result: latest } : { kind: 'continue' }),
      schedule: {
        intervalMs: 200,
        budgetMs: 1_000,
        budgetFrom: 'first-capture',
        captureDeadline: 'cancel',
      },
      clock,
    });
    assert.equal(observed.kind, 'done');
    assert.equal(observed.polls.length, 3);
    assert.equal(observed.polls[0]?.durationMs, 5_000);
    assert.equal(observed.waitedMs, 5_400);
  });

  test('sleeps the interval between an initial observation and the first poll', async () => {
    const clock = fakeClock();
    const observed = await observeUntil({
      capture: async () => 2,
      verdict: (latest, previous) =>
        previous === undefined
          ? { kind: 'continue' }
          : { kind: 'done', result: [previous, latest] },
      schedule: { intervalMs: 200, budgetMs: 1_000, minPolls: 2, captureDeadline: 'cancel' },
      initial: 1,
      clock,
    });
    assert.deepEqual(observed.kind === 'done' && observed.result, [1, 2]);
    assert.deepEqual(clock.slept, [200]);
    assert.equal(observed.polls.length, 1);
  });
});

describe('observeUntil captureDeadline', () => {
  /** A second capture that returns only after the remaining budget is spent, ignoring its signal. */
  function lateSecondCapture(clock: ReturnType<typeof fakeClock>) {
    let captures = 0;
    return async () => {
      captures += 1;
      clock.advance(captures === 1 ? 100 : 1_500);
      return captures;
    };
  }

  test('by default judges a capture that finishes past the budget and can end done', async () => {
    const clock = fakeClock();
    const observed = await observeUntil({
      capture: lateSecondCapture(clock),
      verdict: (latest) => (latest === 2 ? { kind: 'done', result: latest } : { kind: 'continue' }),
      schedule: UNBOUNDED_SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'done');
    assert.deepEqual(
      observed.polls.map((poll) => poll.outcome),
      ['observed', 'observed'],
    );
  });

  test("by default ends expired, never stalled, when the late capture's verdict continues", async () => {
    const clock = fakeClock();
    const observed = await observeUntil({
      capture: lateSecondCapture(clock),
      verdict: () => ({ kind: 'continue' }),
      schedule: UNBOUNDED_SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'expired');
    assert.equal(observed.kind === 'expired' && observed.last, 2);
    assert.equal(observed.polls.length, 2);
  });

  test("'cancel' ends stalled on a capture that finishes past its deadline", async () => {
    const clock = fakeClock();
    const observed = await observeUntil({
      capture: lateSecondCapture(clock),
      verdict: (latest) => (latest === 2 ? { kind: 'done', result: latest } : { kind: 'continue' }),
      schedule: SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'stalled');
    assert.equal(observed.kind === 'stalled' && observed.last, 1);
    assert.deepEqual(
      observed.polls.map((poll) => poll.outcome),
      ['observed', 'stalled'],
    );
  });
});
