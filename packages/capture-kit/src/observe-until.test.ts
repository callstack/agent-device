import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
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

const SCHEDULE = { intervalMs: 200, budgetMs: 1_000 } as const;

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

  test('fails on the first capture error', async () => {
    const clock = fakeClock();
    const failure = new AppError('COMMAND_FAILED', 'wedged');
    const observed = await observeUntil({
      capture: async () => {
        throw failure;
      },
      verdict: () => ({ kind: 'continue' }),
      schedule: SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'failed');
    assert.equal(observed.kind === 'failed' && observed.error, failure);
    assert.deepEqual(
      observed.polls.map((poll) => poll.outcome),
      ['failed'],
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
      schedule: { ...SCHEDULE, minPolls: 2 },
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

describe('observeUntil initial value', () => {
  test('sleeps the interval between an initial observation and the first poll', async () => {
    const clock = fakeClock();
    const observed = await observeUntil({
      capture: async () => 2,
      verdict: (latest, previous) =>
        previous === undefined
          ? { kind: 'continue' }
          : { kind: 'done', result: [previous, latest] },
      schedule: { ...SCHEDULE, minPolls: 2 },
      initial: 1,
      clock,
    });
    assert.deepEqual(observed.kind === 'done' && observed.result, [1, 2]);
    assert.deepEqual(clock.slept, [200]);
    assert.equal(observed.polls.length, 1);
  });
});

describe('observeUntil late capture', () => {
  /** A second capture that returns only after the remaining budget is spent. */
  function lateSecondCapture(clock: ReturnType<typeof fakeClock>) {
    let captures = 0;
    return async () => {
      captures += 1;
      clock.advance(captures === 1 ? 100 : 1_500);
      return captures;
    };
  }

  test('judges a capture that finishes past the budget and can end done', async () => {
    const clock = fakeClock();
    const observed = await observeUntil({
      capture: lateSecondCapture(clock),
      verdict: (latest) => (latest === 2 ? { kind: 'done', result: latest } : { kind: 'continue' }),
      schedule: SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'done');
    assert.deepEqual(
      observed.polls.map((poll) => poll.outcome),
      ['observed', 'observed'],
    );
  });

  test("ends expired when the late capture's verdict continues", async () => {
    const clock = fakeClock();
    const observed = await observeUntil({
      capture: lateSecondCapture(clock),
      verdict: () => ({ kind: 'continue' }),
      schedule: SCHEDULE,
      clock,
    });
    assert.equal(observed.kind, 'expired');
    assert.equal(observed.kind === 'expired' && observed.last, 2);
    assert.equal(observed.polls.length, 2);
  });
});
