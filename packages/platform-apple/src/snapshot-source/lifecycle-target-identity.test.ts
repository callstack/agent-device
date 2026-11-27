import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotSourceError } from '@agent-device/capture-kit/snapshot-source-channel';
import { SnapshotBridgeManager } from './lifecycle.ts';
import {
  bridge,
  createLifecycleFixture,
  deadline,
  installTimerOrderedTime,
  limits,
  target,
} from './lifecycle.fixtures.ts';

installTimerOrderedTime();

// A target its resolver verified carries the process start time it read, so the manager reads the
// identity only after the exchange, and again only to explain a failed one.
test('a target its resolver verified is read once, after the exchange', async () => {
  const fixture = createLifecycleFixture({ targetStartTimes: ['original-start'] });
  const manager = new SnapshotBridgeManager(fixture.host);

  await manager.request({
    target: { ...target, processStartTime: 'original-start' },
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(),
  });

  assert.deepEqual(fixture.identityReads, [target.pid]);
  await manager.close();
});

test.each([
  {
    observed: 'replacement-start',
    failureKind: 'stale-target',
    failureCode: 'target-process-changed',
  },
  { observed: null, failureKind: 'stale-target', failureCode: 'target-process-unavailable' },
  { observed: 'original-start', failureKind: 'unsupported', failureCode: 'fixture-error' },
] as const)(
  'a failed exchange of a verified target reads $observed and fails as $failureCode',
  async ({ observed, failureKind, failureCode }) => {
    const fixture = createLifecycleFixture({
      responseErrorKind: 'unsupported',
      targetStartTimes: [observed],
    });
    const manager = new SnapshotBridgeManager(fixture.host);

    await assert.rejects(
      manager.request({
        target: { ...target, processStartTime: 'original-start' },
        bridge,
        limits,
        maxDepth: 10,
        deadline: deadline(),
      }),
      (error: unknown) =>
        error instanceof SnapshotSourceError &&
        error.failureKind === failureKind &&
        error.failureCode === failureCode,
    );
    assert.deepEqual(fixture.identityReads, [target.pid]);
    await manager.close();
  },
);

test('a failed exchange keeps its own failure when the identity read after it fails', async () => {
  const fixture = createLifecycleFixture({ responseErrorKind: 'unsupported' });
  const manager = new SnapshotBridgeManager({
    ...fixture.host,
    readTargetProcessStartTime: async () => {
      throw new Error('ps unavailable');
    },
  });

  await assert.rejects(
    manager.request({
      target: { ...target, processStartTime: 'original-start' },
      bridge,
      limits,
      maxDepth: 10,
      deadline: deadline(),
    }),
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'unsupported' &&
      error.failureCode === 'fixture-error',
  );
  await manager.close();
});
