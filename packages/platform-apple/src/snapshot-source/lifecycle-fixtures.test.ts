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
      manager.request({
        target,
        bridge,
        limits,
        maxDepth: 10,
        deadline: deadline(undefined, 5000),
      }),
      (error: unknown) =>
        error instanceof SnapshotSourceError &&
        error.failureKind === 'stale-target' &&
        error.failureCode === 'target-process-unavailable',
    );
  } finally {
    await manager.close();
  }
});

test.each([
  { responseErrorKind: undefined, failureKind: 'stale-target', failureCode: 'bridge-pid-mismatch' },
  {
    responseErrorKind: 'application_not_responding',
    failureKind: 'timeout',
    failureCode: 'fixture-error',
  },
])(
  'an explicit zero fixture response pid with guest error $responseErrorKind fails as $failureCode',
  async ({ responseErrorKind, failureKind, failureCode }) => {
    const fixture = createLifecycleFixture({ responsePid: 0, responseErrorKind });
    const manager = new SnapshotBridgeManager(fixture.host);
    try {
      await assert.rejects(
        manager.request({
          target,
          bridge,
          limits,
          maxDepth: 10,
          deadline: deadline(undefined, 5000),
        }),
        (error: unknown) =>
          error instanceof SnapshotSourceError &&
          error.failureKind === failureKind &&
          error.failureCode === failureCode,
      );
    } finally {
      await manager.close();
    }
  },
);
