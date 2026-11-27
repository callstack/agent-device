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
  waitForDispatch,
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

  assert.deepEqual(fixture.identityReads, [{ pid: target.pid, requestsSent: 1 }]);
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
    assert.deepEqual(fixture.identityReads, [{ pid: target.pid, requestsSent: 1 }]);
    await manager.close();
  },
);

test('a failed exchange keeps its own failure when the identity read after it fails', async () => {
  const fixture = createLifecycleFixture({ responseErrorKind: 'unsupported' });
  let identityReads = 0;
  const manager = new SnapshotBridgeManager({
    ...fixture.host,
    readTargetProcessStartTime: async () => {
      identityReads += 1;
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
  assert.equal(identityReads, 1);
  await manager.close();
});

test('a close during the exchange of a verified target keeps the close failure and reads no identity', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({
    target: { ...target, processStartTime: 'original-start' },
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(),
  });
  await waitForDispatch(fixture);
  const closed = manager.close();

  // The close stops the helper under the exchange, exactly as it does for an unverified target.
  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'process-crash' &&
      error.failureCode === 'bridge-exited',
  );
  await closed;
  assert.deepEqual(fixture.identityReads, []);
});

test('a cancellation during the exchange of a verified target stays a cancellation', async () => {
  const fixture = createLifecycleFixture({
    responseDelayMs: 80,
    targetStartTimes: ['replacement-start'],
  });
  const manager = new SnapshotBridgeManager(fixture.host);
  const controller = new AbortController();
  const request = manager.request({
    target: { ...target, processStartTime: 'original-start' },
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(controller.signal),
  });
  await waitForDispatch(fixture);
  controller.abort();

  await assert.rejects(
    request,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.deepEqual(fixture.identityReads, []);
  await manager.close();
});
