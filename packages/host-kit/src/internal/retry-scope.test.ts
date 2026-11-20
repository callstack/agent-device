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

describe('child limits', () => {
  test('a child takes the earlier of its own cutoff and its parent deadline', () => {
    const clock = createTestClock(1_000);
    const parent = openScope(
      undefined,
      { maxMs: 100, expired: () => new Error('parent') },
      clock.now,
    );

    const shorter = parent.child({ maxMs: 40, expired: () => new Error('shorter') });
    const longer = parent.child({ maxMs: 400, expired: () => new Error('longer') });
    const inherited = parent.child();

    assert.equal(shorter.deadline, 1_040);
    assert.equal(longer.deadline, 1_100);
    assert.equal(inherited.deadline, 1_100);
  });

  test('a child opened after its parent lost time still inherits the parent deadline', () => {
    const clock = createTestClock(0);
    const parent = openScope(
      undefined,
      { maxMs: 50, expired: () => new Error('parent') },
      clock.now,
    );
    clock.advance(10);

    const child = parent.child({ maxMs: 400, expired: () => new Error('child') });

    assert.equal(child.deadline, 50);
  });

  test('a narrowed limit owns the armed duration it reported', () => {
    const clock = createTestClock(0);
    const parentLimit = recordedLimit(100, 'parent');
    const narrowedLimit = recordedLimit(40, 'narrower');
    const parent = openScope(undefined, parentLimit, clock.now);
    const narrowed = parent.child(narrowedLimit);
    clock.advance(40);

    assert.throws(() => narrowed.commit(() => 'late'), /narrower expired after 40ms/);
    assert.deepEqual(narrowedLimit.armed, [40]);
    assert.deepEqual(parentLimit.armed, []);
  });

  test('an inherited parent limit keeps its own armed duration through the child', () => {
    const clock = createTestClock(0);
    const parentLimit = recordedLimit(20, 'parent');
    const widerLimit = recordedLimit(500, 'wider');
    const parent = openScope(undefined, parentLimit, clock.now);
    const wider = parent.child(widerLimit);
    clock.advance(20);

    assert.throws(() => wider.commit(() => 'late'), /parent expired after 20ms/);
    assert.deepEqual(parentLimit.armed, [20]);
    assert.deepEqual(widerLimit.armed, []);
  });

  test('an unbounded parent gives its child the child limit as the armed duration', () => {
    const clock = createTestClock(0);
    const parent = openScope(undefined, undefined, clock.now);
    const childLimit = recordedLimit(25, 'child');
    const child = parent.child(childLimit);
    clock.advance(25);

    assert.throws(() => child.commit(() => 'late'), /child expired after 25ms/);
    assert.deepEqual(childLimit.armed, [25]);
  });
});

describe('commit', () => {
  test('publishes while the deadline has not passed', () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, recordedLimit(100), clock.now);
    clock.advance(99);

    assert.equal(
      scope.commit(() => 'capture'),
      'capture',
    );
  });

  test('throws the limit error once the clock passes the deadline, with no timer callback run', () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, recordedLimit(10), clock.now);
    // Reading the signal arms the timer, and nothing advances real time, so its callback never runs.
    const signal = scope.signal;
    clock.advance(10);

    assert.equal(signal.aborted, false);
    assert.throws(() => scope.commit(() => 'late capture'), /expired after 10ms/);
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as Error).message, 'limit expired after 10ms');
  });

  test('refuses a result that reached its caller after the cutoff', async () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, recordedLimit(10), clock.now);
    const signal = scope.signal;
    // A task that answers after the cutoff reaches `commit` with a value, and the scope is what
    // refuses it: the caller sees a thrown timeout, never the value.
    clock.advance(50);
    const publishLate = async () => scope.commit(() => 'late capture');

    await assert.rejects(publishLate(), /expired after 10ms/);
    assert.equal(signal.aborted, true);
  });

  test('throws the parent cancellation reason ahead of its own expiry', () => {
    const clock = createTestClock(0);
    const parent = new AbortController();
    const scope = openScope(parent.signal, recordedLimit(10), clock.now);
    const reason = new Error('runtime canceled');

    parent.abort(reason);
    clock.advance(50);
    assert.throws(
      () => scope.commit(() => 'late'),
      (error: unknown) => error === reason,
    );
  });

  test('keeps a parent reason that arrived after the cutoff as the scope reason', () => {
    const clock = createTestClock(0);
    const parent = new AbortController();
    const scope = openScope(parent.signal, recordedLimit(10), clock.now);
    const reason = new Error('request canceled');

    clock.advance(20);
    parent.abort(reason);
    assert.throws(
      () => scope.commit(() => 'late'),
      (error: unknown) => error === reason,
    );
    assert.equal(scope.signal.reason, reason);
  });

  test('aborts the signal it handed the work when the timer reaches the deadline', async () => {
    vi.useFakeTimers();
    const scope = openScope(undefined, recordedLimit(10));
    const signal = scope.signal;

    await vi.advanceTimersByTimeAsync(10);

    assert.equal(signal.aborted, true);
    assert.match((signal.reason as Error).message, /expired after 10ms/);
  });

  test('wakes work blocked on a child signal when the parent deadline expires', async () => {
    vi.useFakeTimers();
    const parent = openScope(undefined, recordedLimit(10));
    // Only the child's signal was ever read, so the child carries the wake-up for the parent budget.
    const childSignal = parent.child().signal;

    await vi.advanceTimersByTimeAsync(10);

    assert.equal(childSignal.aborted, true);
    assert.match((childSignal.reason as Error).message, /expired after 10ms/);
  });

  test('never expires without a limit', () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, undefined, clock.now);
    clock.advance(10_000);

    assert.equal(
      scope.commit(() => 'value'),
      'value',
    );
    assert.equal(scope.signal.aborted, false);
    assert.equal(scope.deadline, Number.POSITIVE_INFINITY);
  });
});

describe('close', () => {
  test('refuses publication after it ran', async () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, recordedLimit(100), clock.now);

    await scope.close();
    assert.throws(() => scope.commit(() => 'late'), /Request scope is closed/);
  });

  test('refuses publication on a child after its parent closed', async () => {
    const clock = createTestClock(0);
    const parent = openScope(undefined, recordedLimit(100), clock.now);
    const child = parent.child(recordedLimit(10));

    await parent.close();
    assert.throws(() => child.commit(() => 'late'), /Request scope is closed/);
  });

  test('leaves the parent able to publish when a child closed', async () => {
    const clock = createTestClock(0);
    const parent = openScope(undefined, recordedLimit(100), clock.now);
    const child = parent.child(recordedLimit(10));

    await child.close();
    assert.equal(
      parent.commit(() => 'value'),
      'value',
    );
  });

  test('runs each release once in reverse order and runs none again', async () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, recordedLimit(100), clock.now);
    const order: string[] = [];
    scope.defer(() => {
      order.push('first');
    });
    scope.defer(() => {
      order.push('second');
    });

    await scope.close();
    await scope.close();

    assert.deepEqual(order, ['second', 'first']);
  });

  test('runs the remaining releases after one fails and reports the first failure', async () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, recordedLimit(100), clock.now);
    const order: string[] = [];
    const newestFailure = new Error('newest release failed');
    scope.defer(() => {
      order.push('oldest');
    });
    scope.defer(() => {
      order.push('middle');
      throw new Error('middle release failed');
    });
    scope.defer(() => {
      order.push('newest');
      throw newestFailure;
    });

    // Releases run newest first, so that is the first failure; the older ones still run.
    await assert.rejects(scope.close(), (error: unknown) => error === newestFailure);
    assert.deepEqual(order, ['newest', 'middle', 'oldest']);
  });

  test('waits for an async release', async () => {
    const clock = createTestClock(0);
    const scope = openScope(undefined, recordedLimit(100), clock.now);
    let released = false;
    scope.defer(async () => {
      await Promise.resolve();
      released = true;
    });

    await scope.close();
    assert.equal(released, true);
  });

  test('stops the deadline timer so it cannot expire a closed scope', async () => {
    vi.useFakeTimers();
    const scope = openScope(undefined, recordedLimit(10));
    const signal = scope.signal;

    await scope.close();
    await vi.advanceTimersByTimeAsync(10);

    assert.equal(signal.aborted, false);
  });

  test('leaves a sibling work to its own deadline while releasing its own', async () => {
    vi.useFakeTimers();
    const parent = openScope(undefined, recordedLimit(10));
    const workingSignal = parent.child().signal;

    await parent.child().close();
    await vi.advanceTimersByTimeAsync(10);

    assert.equal(workingSignal.aborted, true);
  });
});
