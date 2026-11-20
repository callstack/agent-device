import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { settleWithin } from './settle-within.ts';

test('settleWithin settles with the work value and clears its deadline timer', async () => {
  vi.useFakeTimers();
  try {
    const outcome = settleWithin(async () => 'done', 10_000);
    assert.deepEqual(await outcome, { kind: 'settled', value: 'done' });
    assert.equal(vi.getTimerCount(), 0, 'the deadline timer is cleared once the work settles');
  } finally {
    vi.useRealTimers();
  }
});

test('settleWithin reports the deadline without canceling the work and without leaking its timer', async () => {
  vi.useFakeTimers();
  try {
    let workFinished = false;
    const outcome = settleWithin(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      workFinished = true;
      return 'late';
    }, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(await outcome, { kind: 'deadline' });
    assert.equal(
      vi.getTimerCount(),
      1,
      'only the work’s own timer remains; the deadline timer was cleared',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(workFinished, true, 'the work runs to its own end');
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test('settleWithin propagates a rejection that beats the deadline and clears its timer', async () => {
  vi.useFakeTimers();
  try {
    const outcome = settleWithin(async () => {
      throw new Error('boom');
    }, 10_000);
    await assert.rejects(outcome, /boom/);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test('settleWithin treats a spent budget as an immediate deadline', async () => {
  const outcome = await settleWithin(() => new Promise<string>(() => {}), 0);
  assert.deepEqual(outcome, { kind: 'deadline' });
});

test('settleWithin unrefs the deadline timer only when keepAlive is false', async () => {
  vi.useFakeTimers();
  try {
    const unrefCalls: unknown[] = [];
    const original = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
      ...args: unknown[]
    ) => {
      const timer = original(handler, timeout, ...args) as unknown as NodeJS.Timeout;
      const unref = timer.unref.bind(timer);
      timer.unref = () => {
        unrefCalls.push(timer);
        return unref();
      };
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await settleWithin(async () => 'done', 10_000, { keepAlive: false });
    assert.equal(unrefCalls.length, 1, 'keepAlive: false unrefs the deadline timer');

    await settleWithin(async () => 'done', 10_000);
    assert.equal(unrefCalls.length, 1, 'the default keeps the deadline timer ref’d');

    spy.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});
