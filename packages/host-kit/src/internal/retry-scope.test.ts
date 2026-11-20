import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';

import { openScope, type Limit } from './retry.ts';

/**
 * A scope measures its deadline on the caller's clock, so these tests move that clock by hand. The
 * point they hold the scope to: `commit` decides publication on the clock, and the timer only wakes
 * work that blocked on the signal.
 */
function createTestClock(startedMs = 0) {
  let currentMs = startedMs;
  return {
    now: () => currentMs,
    advance(ms: number) {
      currentMs += ms;
    },
  };
}

/** A limit that records the armed duration each expiry was asked to report. */
function recordedLimit(maxMs: number, tag = 'limit') {
  const armed: number[] = [];
  const limit: Limit & { armed: number[] } = {
    maxMs,
    armed,
    expired: (armedMs: number) => {
      armed.push(armedMs);
      return new Error(`${tag} expired after ${armedMs}ms`);
    },
  };
  return limit;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('commit', () => {
  test('publishes while the deadline has not passed', () => {
    const clock = createTestClock();
    const scope = openScope(undefined, recordedLimit(100), clock.now);
    clock.advance(99);
    assert.equal(
      scope.commit(() => 'value'),
      'value',
    );
  });

  test('throws the limit error once the clock passes the deadline, with no timer callback run', () => {
    const clock = createTestClock();
    const limit = recordedLimit(100);
    const scope = openScope(undefined, limit, clock.now);
    clock.advance(100);
    assert.throws(() => scope.commit(() => 'late'), /limit expired after 100ms/);
    assert.deepEqual(limit.armed, [100]);
    assert.equal(scope.signal.aborted, true);
  });

  test('keeps an inherited cancellation as the reason ahead of its own expiry', () => {
    const clock = createTestClock();
    const parent = new AbortController();
    const limit = recordedLimit(100);
    const scope = openScope(parent.signal, limit, clock.now);
    parent.abort(new Error('caller canceled'));
    clock.advance(500);
    assert.throws(() => scope.commit(() => 'value'), /caller canceled/);
    assert.deepEqual(limit.armed, []);
  });

  test('aborts the signal it handed the work when the timer reaches the deadline', async () => {
    vi.useFakeTimers();
    const limit = recordedLimit(50);
    const scope = openScope(undefined, limit, () => vi.getMockedSystemTime()?.valueOf() ?? 0);
    const signal = scope.signal;
    await vi.advanceTimersByTimeAsync(50);
    assert.equal(signal.aborted, true);
    assert.deepEqual(limit.armed, [50]);
  });
});

describe('close', () => {
  test('refuses publication after it ran', () => {
    const scope = openScope(undefined, recordedLimit(100), createTestClock().now);
    scope.close();
    assert.throws(() => scope.commit(() => 'value'), /closed/);
  });

  test('stops the deadline timer so it cannot expire a closed scope', async () => {
    vi.useFakeTimers();
    const limit = recordedLimit(50);
    const scope = openScope(undefined, limit, () => vi.getMockedSystemTime()?.valueOf() ?? 0);
    const signal = scope.signal;
    scope.close();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(signal.aborted, false);
    assert.deepEqual(limit.armed, []);
  });
});
