import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import { withKeyedLock } from './keyed-lock.ts';

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
