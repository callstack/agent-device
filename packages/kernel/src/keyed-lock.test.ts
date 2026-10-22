import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  heldKeyedLockKeys,
  withKeyedLock,
  withKeyedLockHolder,
  type KeyedLockHolder,
} from './keyed-lock.ts';

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

test('a lock a holder takes partway through is held by later sibling scopes until the holder ends', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const order: string[] = [];
  let markHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let finishHolder: () => void = () => {};
  const holderMayFinish = new Promise<void>((resolve) => {
    finishHolder = resolve;
  });

  const holderRun = withKeyedLockHolder(async (holder) => {
    // A first nested scope takes the hold, as a replay action retains its device.
    await withKeyedLock(locks, 'session', async () => {
      await holder.hold(locks, 'device:app');
    });
    markHeld();
    // A later sibling scope re-enters the hold instead of queueing behind it.
    await withKeyedLock(locks, 'device:app', async () => {
      order.push('sibling re-entered');
      expect(heldKeyedLockKeys(locks)).toEqual(['device:app']);
    });
    await holderMayFinish;
    order.push('holder done');
  });
  await held;
  // Another context queues behind the live hold.
  let waiterEntered = false;
  const waiter = withKeyedLock(locks, 'device:app', async () => {
    waiterEntered = true;
    order.push('waiter entered');
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(waiterEntered).toBe(false);
  finishHolder();

  await Promise.all([holderRun, waiter]);
  expect(order).toEqual(['sibling re-entered', 'holder done', 'waiter entered']);
  expect(locks.size).toBe(0);
});

test('a hold cancelled while queued rejects with the signal reason and leaves nothing held', async () => {
  const locks = new Map<string, Promise<unknown>>();
  let releaseOwner: () => void = () => {};
  const owner = withKeyedLock(
    locks,
    'device:app',
    async () =>
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      }),
  );
  const controller = new AbortController();
  const reason = new Error('request canceled');

  await withKeyedLockHolder(async (holder) => {
    const pending = holder.hold(locks, 'device:app', controller.signal);
    // A key the holder is still taking already reads as held, so no second same-host wait starts.
    expect(heldKeyedLockKeys(locks)).toEqual(['device:app']);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(heldKeyedLockKeys(locks)).toEqual([]);
  });
  releaseOwner();
  await owner;
  expect(locks.size).toBe(0);
});

test('a holder refuses a lock once it has ended', async () => {
  const locks = new Map<string, Promise<unknown>>();
  let late: KeyedLockHolder | undefined;
  await withKeyedLockHolder(async (holder) => {
    late = holder;
  });
  await expect(late!.hold(locks, 'device:app')).rejects.toThrow(/after it ends/);
  expect(locks.size).toBe(0);
});

test('heldKeyedLockKeys lists only the locks of the map held by the current context', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const other = new Map<string, Promise<unknown>>();
  await withKeyedLock(other, 'other', async () => {
    await withKeyedLock(locks, 'host', async () => {
      await withKeyedLock(locks, 'host:app:one', async () => {
        expect(heldKeyedLockKeys(locks).sort()).toEqual(['host', 'host:app:one']);
      });
      expect(heldKeyedLockKeys(locks)).toEqual(['host']);
    });
  });
});

test('a scope wanting a key its enclosing holder is still taking re-enters it once taken', async () => {
  const locks = new Map<string, Promise<unknown>>();
  let releaseOwner: () => void = () => {};
  const owner = withKeyedLock(
    locks,
    'device:app',
    async () =>
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      }),
  );

  const outcome = withKeyedLockHolder(async (holder) => {
    const taking = holder.hold(locks, 'device:app');
    // A nested step asks for the same key while the hold still waits for the owner.
    const step = withKeyedLock(locks, 'device:app', async () => 'step re-entered');
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseOwner();
    await taking;
    return await step;
  });

  await expect(outcome).resolves.toBe('step re-entered');
  await owner;
  expect(locks.size).toBe(0);
});

test('taking or holding a free key queues it synchronously, so a check just before stays true', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const taken = withKeyedLock(locks, 'device:a', async () => {});
  expect(locks.has('device:a')).toBe(true);
  await taken;

  await withKeyedLockHolder(async (holder) => {
    const hold = holder.hold(locks, 'device:b');
    expect(locks.has('device:b')).toBe(true);
    await hold;
  });
  expect(locks.size).toBe(0);
});

test('a scope waiting on its holder for a key fails with the hold when the hold is cancelled', async () => {
  const locks = new Map<string, Promise<unknown>>();
  let releaseOwner: () => void = () => {};
  const owner = withKeyedLock(
    locks,
    'device:app',
    async () =>
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      }),
  );
  const controller = new AbortController();
  const reason = new Error('request canceled');

  await withKeyedLockHolder(async (holder) => {
    const taking = holder.hold(locks, 'device:app', controller.signal);
    const step = withKeyedLock(locks, 'device:app', async () => 'ran');
    controller.abort(reason);
    await expect(taking).rejects.toBe(reason);
    await expect(step).rejects.toBe(reason);
  });
  releaseOwner();
  await owner;
  expect(locks.size).toBe(0);
});
