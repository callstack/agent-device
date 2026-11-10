import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { snapshotSourceError } from './errors.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import {
  limits,
  target,
  bridge,
  deadline,
  isHelperCrashFailure,
  createLifecycleFixture,
} from './lifecycle.fixtures.ts';

test('a helper crash seen by the starting capture is not delivered again', async () => {
  vi.useFakeTimers();
  let connecting = true;
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager({
    ...fixture.host,
    connect: async (...args) => {
      if (connecting)
        throw snapshotSourceError('transport-failure', 'bridge-closed-before-connect');
      return fixture.host.connect(...args);
    },
  });
  try {
    const first = assert.rejects(
      manager.request({
        target,
        bridge,
        limits,
        maxDepth: 10,
        deadline: deadline(undefined, 5000),
      }),
      isHelperCrashFailure,
    );
    await vi.advanceTimersByTimeAsync(100);
    fixture.processes[0]!.crash();
    await vi.advanceTimersByTimeAsync(50);
    await first;
    connecting = false;
    const next = manager.request({
      target,
      bridge,
      limits,
      maxDepth: 10,
      deadline: deadline(undefined, 5000),
    });
    await vi.advanceTimersByTimeAsync(10);
    assert.equal((await next).generation, target.generation);
    assert.equal(fixture.processes.length, 2);
  } finally {
    await manager.close();
    vi.useRealTimers();
  }
});
