import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import { withKeyedLock } from './keyed-lock.ts';

test('canceled queued work returns before its owner and never runs or admits a competing task early', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const controller = new AbortController();
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const owner = withKeyedLock(locks, 'session', async () => {
    markStarted();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await started;
  const expiredTask = vi.fn(async () => {});
  const queued = withKeyedLock(locks, 'session', expiredTask, controller.signal);
  const reason = new Error('deadline');
  controller.abort(reason);
  await assert.rejects(queued, (error) => error === reason);
  const competingTask = vi.fn(async () => {});
  const competing = withKeyedLock(locks, 'session', competingTask);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(competingTask.mock.calls.length, 0);
  release();
  await Promise.all([owner, competing]);
  assert.equal(expiredTask.mock.calls.length, 0);
  assert.equal(competingTask.mock.calls.length, 1);
  assert.equal(locks.size, 0);
});

test('an abort after lock admission waits for the running task to settle', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const controller = new AbortController();
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let settled = false;
  const running = withKeyedLock(
    locks,
    'session',
    async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    controller.signal,
  ).finally(() => {
    settled = true;
  });
  await started;
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await running;
});

test('withKeyedLock serializes work per key', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;

  await Promise.all([
    withKeyedLock(locks, 'device-a', async () => {
      order.push('start-1');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      order.push('end-1');
    }),
    withKeyedLock(locks, 'device-a', async () => {
      order.push('start-2');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      order.push('end-2');
    }),
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('withKeyedLock allows reentrant work for the same key while holding the outer lock', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const order: string[] = [];
  let releaseOuter: (() => void) | undefined;
  const outerGate = new Promise<void>((resolve) => {
    releaseOuter = resolve;
  });

  const outer = withKeyedLock(locks, 'device-a', async () => {
    order.push('outer-start');
    await withKeyedLock(locks, 'device-a', async () => {
      order.push('inner');
    });
    await outerGate;
    order.push('outer-end');
  });

  await vi.waitFor(() => {
    expect(order).toEqual(['outer-start', 'inner']);
  });

  const competing = withKeyedLock(locks, 'device-a', async () => {
    order.push('competing');
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(order, ['outer-start', 'inner']);

  releaseOuter?.();
  await Promise.all([outer, competing]);

  assert.deepEqual(order, ['outer-start', 'inner', 'outer-end', 'competing']);
});

test('a deferred descendant of a released lock queues behind its current owner', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const order: string[] = [];
  let timerAttempted!: () => void;
  const attempted = new Promise<void>((resolve) => {
    timerAttempted = resolve;
  });
  let descendant!: Promise<void>;
  await withKeyedLock(locks, 'device-a', async () => {
    descendant = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        timerAttempted();
        withKeyedLock(locks, 'device-a', async () => {
          order.push('descendant');
        }).then(resolve, reject);
      }, 0);
    });
  });
  let releaseOwner!: () => void;
  const ownerGate = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  let ownerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    ownerStarted = resolve;
  });
  const owner = withKeyedLock(locks, 'device-a', async () => {
    order.push('owner');
    ownerStarted();
    await ownerGate;
    order.push('released');
  });
  await started;
  await attempted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['owner']);
  releaseOwner();
  await Promise.all([owner, descendant]);
  assert.deepEqual(order, ['owner', 'released', 'descendant']);
});

test.each([false, true])(
  'reentrant descendants settle before the next owner (reject=%s)',
  async (reject) => {
    const locks = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let descendant!: Promise<void>;
    const owner = withKeyedLock(locks, 'device-a', async () => {
      queueMicrotask(() => {
        descendant = withKeyedLock(locks, 'device-a', async () => {
          order.push('descendant');
          markStarted();
          await gate;
          order.push('finished');
          void withKeyedLock(locks, 'device-a', async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            order.push('nested');
          });
          if (reject) throw new Error('descendant failed');
        });
        void descendant.catch(() => {});
      });
    });
    const competing = withKeyedLock(locks, 'device-a', async () => {
      order.push('competing');
    });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeRelease = [...order];
    release();
    const [, outcome] = await Promise.all([
      owner,
      descendant.catch((error: Error) => error),
      competing,
    ]);
    assert.equal(outcome instanceof Error, reject);
    assert.deepEqual(beforeRelease, ['descendant']);
    assert.deepEqual(order, ['descendant', 'finished', 'nested', 'competing']);
  },
);
