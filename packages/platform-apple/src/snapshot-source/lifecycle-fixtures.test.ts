import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotSourceError } from './errors.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import { bridge, createLifecycleFixture, deadline, limits, target } from './lifecycle.fixtures.ts';

test('an explicit null fixture start time reaches the manager as an unavailable target', async () => {
  const fixture = createLifecycleFixture({ targetStartTimes: [null] });
  const manager = new SnapshotBridgeManager(fixture.host);
  try {
    await assert.rejects(
      manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
      (error: unknown) =>
        error instanceof SnapshotSourceError &&
        error.failureKind === 'stale-target' &&
        error.failureCode === 'target-process-unavailable',
    );
  } finally {
    await manager.close();
  }
});

test.each([undefined, 'application_not_responding'])(
  'an explicit zero fixture response pid reaches identity validation with guest error %s',
  async (responseErrorKind) => {
    const fixture = createLifecycleFixture({ responsePid: 0, responseErrorKind });
    const manager = new SnapshotBridgeManager(fixture.host);
    try {
      await assert.rejects(
        manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
        (error: unknown) =>
          error instanceof SnapshotSourceError &&
          error.failureKind === 'stale-target' &&
          error.failureCode === 'bridge-pid-mismatch',
      );
    } finally {
      await manager.close();
    }
  },
);
