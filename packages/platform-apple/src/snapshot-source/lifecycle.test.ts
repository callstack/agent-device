import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { SnapshotSourceError } from './errors.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import { simulatorAddressFor } from '../core/simctl.ts';
import type { SnapshotSourceTarget } from './types.ts';
import {
  limits,
  simulatorDevice,
  target,
  bridge,
  deadline,
  waitForDispatch,
  settleWithin,
  waitForFixture,
  createPause,
  isClosedSourceFailure,
  isHelperCrashFailure,
  exitDiagnostics,
  createLifecycleFixture,
} from './lifecycle.fixtures.ts';

function compileTimeSnapshotTargetProof(): SnapshotSourceTarget {
  // @ts-expect-error A target names its simulator through an address minted from its DeviceInfo.
  return { udid: 'simulator-1', runtime: 'iOS 26.2', pid: 123, generation: 'generation-1' };
}
void compileTimeSnapshotTargetProof;

test('the bridge manager reuses a healthy per-device helper and stops it exactly once', async () => {
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager(fixture.host);

  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });

  assert.equal(fixture.processes.length, 1);
  assert.equal(fixture.sockets.length, 1);
  await manager.close();
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
});

test('the helper starts inside the simulator set that owns the target', async () => {
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager(fixture.host);
  const scopedTarget = {
    ...target,
    simulator: simulatorAddressFor({ ...simulatorDevice, simulatorSetPath: '/tmp/scoped-set' }),
  };

  await manager.request({
    target: scopedTarget,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(),
  });

  assert.deepEqual(fixture.startedTargets, [
    { udid: 'simulator-1', simulatorSetPath: '/tmp/scoped-set' },
  ]);
  await manager.close();
});

test('a new target generation reuses the healthy helper and carries generation per request', async () => {
  const fixture = createLifecycleFixture();
  const manager = new SnapshotBridgeManager(fixture.host);

  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await manager.request({
    target: { ...target, generation: 'generation-2' },
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(),
  });

  assert.equal(fixture.processes.length, 1);
  assert.deepEqual(fixture.processes[0]!.signals, []);
  await manager.close();
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
});

test('cancellation while queued prevents a later dispatch', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 200 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const first = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 1000),
  });
  await waitForDispatch(fixture);

  const controller = new AbortController();
  const startedAt = Date.now();
  const queued = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(controller.signal, 1000),
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    queued,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.ok(Date.now() - startedAt < 100);
  assert.equal(fixture.sockets[0]?.writes, 1);
  await first;
  assert.equal(fixture.sockets.length, 1);
  await manager.close();
});

test('cancelling a middle waiter does not release the following request early', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 120 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const first = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 1000),
  });
  await waitForDispatch(fixture);

  const controller = new AbortController();
  const middle = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(controller.signal, 1000),
  });
  const last = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 1000),
  });
  controller.abort();

  await assert.rejects(
    middle,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.equal(fixture.sockets[0]?.writes, 1);
  await first;
  await last;
  assert.equal(fixture.sockets[0]?.writes, 2);
  await manager.close();
});

test('independent managers own distinct sockets for the same Simulator', async () => {
  const fixture = createLifecycleFixture();
  const first = new SnapshotBridgeManager(fixture.host);
  const second = new SnapshotBridgeManager(fixture.host);

  await first.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await second.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });

  assert.equal(fixture.socketPaths.length, 2);
  assert.notEqual(fixture.socketPaths[0], fixture.socketPaths[1]);
  await first.close();
  assert.equal(fixture.processes[1]?.isAlive(), true);
  await second.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await second.close();
});

test('request cancellation after dispatch reaps the exact helper before recovery', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const controller = new AbortController();
  const request = manager.request({
    target,
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
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
  assert.equal(fixture.processes[0]?.alive, false);
  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  assert.equal(fixture.processes.length, 2);
  await manager.close();
  assert.deepEqual(fixture.processes[1]?.signals, ['SIGTERM']);
});

test('pre-dispatch cancellation preserves a healthy helper', async () => {
  const fixture = createLifecycleFixture({ connectDelayMs: 40 });
  const manager = new SnapshotBridgeManager(fixture.host);
  await manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 500 },
    maxDepth: 10,
    deadline: deadline(undefined, 500),
  });
  fixture.sockets[0]!.destroy();

  const controller = new AbortController();
  const request = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 500 },
    maxDepth: 10,
    deadline: deadline(controller.signal, 500),
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    request,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  assert.equal(fixture.processes.length, 1);
  assert.deepEqual(fixture.processes[0]?.signals, []);
  assert.equal(fixture.processes[0]?.alive, true);

  await manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 500 },
    maxDepth: 10,
    deadline: deadline(undefined, 500),
  });
  assert.equal(fixture.processes.length, 1);
  await manager.close();
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
});

test('one absolute deadline covers helper connect and response read', async () => {
  const fixture = createLifecycleFixture({ connectDelayMs: 70, responseDelayMs: 70 });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({
      target,
      bridge,
      limits: { ...limits, maxDurationMs: 100 },
      maxDepth: 10,
      deadline: deadline(undefined, 100),
    }),
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'timeout',
  );
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
  await manager.close();
});

test('a crashed helper is removed and the next request starts a fresh helper', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await waitForDispatch(fixture);
  fixture.processes[0]!.crash();

  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureKind === 'process-crash',
  );
  assert.equal(fixture.processes[0]?.signals.length, 0);

  await manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  assert.equal(fixture.processes.length, 2);
  await manager.close();
});

test('a crashed helper emits its bounded log once and keeps exit facts typed', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() });
  await waitForDispatch(fixture);
  fixture.processes[0]!.crash();
  let failure: SnapshotSourceError | undefined;

  await assert.rejects(request, (error: unknown) => {
    failure = error instanceof SnapshotSourceError ? error : undefined;
    return failure?.failureKind === 'process-crash';
  });
  assert.equal(failure?.details?.pid, 700);
  assert.equal(failure?.details?.exitCode, 1);
  assert.equal(failure?.details?.log, undefined);
  const processDiagnostics = fixture.diagnostics.filter(
    (event) => event.phase === 'ios.snapshot-source.bridge-process-exit',
  );
  assert.equal(processDiagnostics.length, 1);
  assert.equal(processDiagnostics[0]?.data?.pid, 700);
  assert.equal(processDiagnostics[0]?.data?.stderr, 'fixture log');
  await manager.close();
});

test('the manager rejects a response for a different target process as stale', async () => {
  const fixture = createLifecycleFixture({ responsePid: target.pid + 1 });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureKind === 'stale-target',
  );
  await manager.close();
});

test('the manager rejects a response carrying a previous target generation as stale', async () => {
  const fixture = createLifecycleFixture({ responseGeneration: 'generation-0' });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'stale-target' &&
      error.failureCode === 'bridge-generation-mismatch',
  );
  await manager.close();
});

test('the manager rejects a cached target replaced before acquisition begins', async () => {
  const fixture = createLifecycleFixture({
    targetStartTimes: ['replacement-start', 'replacement-start'],
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
      error.failureKind === 'stale-target' &&
      error.failureCode === 'target-process-changed',
  );
  await manager.close();
});

test('a close during the bridge directory setup leaves no bridge and refuses the capture', async () => {
  const paused = createPause();
  const fixture = createLifecycleFixture({ pauseAtDirectorySetup: paused.wait });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 2000),
  });
  await waitForFixture(
    () => fixture.directorySetups.length === 1,
    'fixture never reached the bridge directory setup',
  );

  const closing = manager.close();
  paused.release();

  await assert.rejects(request, isClosedSourceFailure);
  await closing;
  // The creation was refused before it started its helper: nothing was left to reap.
  assert.equal(fixture.processes.length, 0);
  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline(undefined, 2000) }),
    isClosedSourceFailure,
  );
  assert.equal(fixture.processes.length, 0);
});

test('a close while the bridge is connecting stops the helper it started and refuses the capture', async () => {
  const paused = createPause();
  const fixture = createLifecycleFixture({ pauseAtConnect: paused.wait });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 2000),
  });
  await waitForFixture(() => fixture.connects.length === 1, 'fixture never reached the connect');

  const closing = manager.close();
  paused.release();

  await assert.rejects(request, isClosedSourceFailure);
  await closing;
  // The helper and its connection were already started, so the refused creation had to stop both.
  assert.equal(fixture.processes.length, 1);
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
  assert.equal(fixture.processes[0]!.alive, false);
  assert.equal(fixture.sockets.length, 1);
  assert.equal(fixture.sockets[0]!.destroyed, true);
  await manager.close();
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
});

test('a close refuses a queued capture instead of letting it wait for a stopped bridge', async () => {
  const paused = createPause();
  const fixture = createLifecycleFixture({ pauseAtConnect: paused.wait });
  const manager = new SnapshotBridgeManager(fixture.host);
  const creating = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 2000 },
    maxDepth: 10,
    deadline: deadline(undefined, 2000),
  });
  await waitForFixture(() => fixture.connects.length === 1, 'fixture never reached the connect');
  const queued = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 2000 },
    maxDepth: 10,
    deadline: deadline(undefined, 2000),
  });
  const closing = manager.close();

  // The queued capture is refused by the close itself, while the creation is still held at the connect:
  // if the refusal ever waited for that creation, this await would never settle and the test would time
  // out, so the order is a causal proof and needs no clock bound.
  await assert.rejects(queued, isClosedSourceFailure);
  assert.equal(fixture.connects.length, 1);
  assert.equal(fixture.sockets.length, 0);
  paused.release();

  await assert.rejects(creating, isClosedSourceFailure);
  await closing;
  assert.equal(fixture.processes.length, 1);
  assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
});

test('a close while the helper exit status stays unread ends the capture instead of waiting for it', async () => {
  const fixture = createLifecycleFixture({ helperGoneAtConnect: true });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 2000 },
    maxDepth: 10,
    deadline: deadline(undefined, 2000),
  });
  await waitForFixture(
    () => (fixture.processes[0]?.exitStatusReads ?? 0) >= 1,
    'the manager never asked for the helper exit status',
  );

  // Settled before the close: this capture is work the close has to wait for.
  const outcome = request.then(
    () => ({ refused: false as const }),
    (error: unknown) => ({ refused: true as const, error }),
  );

  const closed = await settleWithin(manager.close(), 500);

  assert.equal(closed, 'settled', 'close waited for an exit status that never arrived');
  const settled = await outcome;
  assert.equal(settled.refused, true);
  assert.ok(settled.refused && isClosedSourceFailure(settled.error));
  // The helper was already gone, so the refused creation had nothing to stop, and its refusal names
  // the close rather than a crash whose outcome the manager never learned.
  assert.deepEqual(fixture.processes[0]!.signals, []);
  assert.equal(fixture.connects.length, 1);
  assert.equal(fixture.sockets.length, 0);
  assert.equal(
    fixture.diagnostics.some((event) => event.phase === 'ios.snapshot-source.bridge-process-exit'),
    false,
  );
});

test('an exit status that answers before the close still reports the helper crash', async () => {
  const fixture = createLifecycleFixture({ helperGoneAtConnect: true });
  const helper = () => fixture.processes[0]!;
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 2000 },
    maxDepth: 10,
    deadline: deadline(undefined, 2000),
  });
  await waitForFixture(
    () => helper()?.exitStatusReads >= 1,
    'the manager never asked for the helper exit status',
  );

  helper().crash();
  const closing = manager.close();

  await assert.rejects(request, isHelperCrashFailure);
  await closing;
  assert.deepEqual(helper().signals, []);
  const exitDiagnostic = fixture.diagnostics.filter(
    (event) => event.phase === 'ios.snapshot-source.bridge-process-exit',
  );
  assert.equal(exitDiagnostic.length, 1);
  assert.equal(exitDiagnostic[0]?.data?.exitCode, 1);
});

test('a status read that fails before the close still reports the helper crash', async () => {
  const fixture = createLifecycleFixture({ helperGoneAtConnect: true });
  const helper = () => fixture.processes[0]!;
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 2000 },
    maxDepth: 10,
    deadline: deadline(undefined, 2000),
  });
  await waitForFixture(
    () => helper()?.exitStatusReads >= 1,
    'the manager never asked for the helper exit status',
  );

  helper().exitWithFailedStatus();
  const closing = manager.close();

  await assert.rejects(request, isHelperCrashFailure);
  await closing;
  assert.deepEqual(helper().signals, []);
});

test('a capture whose exit status stays unread ends at its own deadline without a close', async () => {
  const fixture = createLifecycleFixture({ helperGoneAtConnect: true });
  const helper = () => fixture.processes[0]!;
  const manager = new SnapshotBridgeManager(fixture.host);

  const failure = await manager
    .request({
      target,
      bridge,
      limits: { ...limits, maxDurationMs: 2000 },
      maxDepth: 10,
      deadline: deadline(undefined, 120),
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  assert.ok(
    failure instanceof SnapshotSourceError &&
      failure.failureKind === 'timeout' &&
      failure.failureCode === 'bridge-exit-deadline',
    'the exit wait did not answer the request budget it was given',
  );
  assert.equal(helper().exitStatusReads >= 1, true);
  assert.equal(exitDiagnostics(fixture).length, 0);
  await manager.close();
});

test.each(['close', 'cancel'] as const)(
  'a %s that ends the exit wait still diagnoses a late exit',
  async (ending) => {
    const fixture = createLifecycleFixture({ helperGoneAtConnect: true });
    const helper = () => fixture.processes[0]!;
    const manager = new SnapshotBridgeManager(fixture.host);
    const cancellation = new AbortController();
    const request = manager.request({
      target,
      bridge,
      limits: { ...limits, maxDurationMs: 2000 },
      maxDepth: 10,
      deadline: deadline(cancellation.signal, 2000),
    });
    await waitForFixture(
      () => helper()?.exitStatusReads >= 1,
      'the manager never asked for the helper exit status',
    );
    if (ending === 'close') {
      assert.equal(await settleWithin(manager.close(), 500), 'settled');
      await assert.rejects(request, isClosedSourceFailure);
    } else {
      cancellation.abort();
      await assert.rejects(
        request,
        (error: unknown) =>
          error instanceof SnapshotSourceError &&
          error.failureKind === 'cancelled' &&
          error.failureCode === 'abort-signal',
      );
    }
    assert.equal(exitDiagnostics(fixture).length, 0);
    helper().crash();
    await waitForFixture(
      () => exitDiagnostics(fixture).length === 1,
      `the status read left behind by the ${ending} never diagnosed the exit`,
    );
    assert.equal(exitDiagnostics(fixture)[0]?.data?.exitCode, 1);
    assert.equal(exitDiagnostics(fixture)[0]?.data?.stderr, 'fixture log');
    await manager.close();
  },
);

test('a close during a dispatched capture waits only for the capture deadline the helper died on', async () => {
  const fixture = createLifecycleFixture({ responseDelayMs: 2000 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const request = manager.request({
    target,
    bridge,
    limits: { ...limits, maxDurationMs: 2000 },
    maxDepth: 10,
    deadline: deadline(undefined, 150),
  });
  await waitForDispatch(fixture);
  fixture.processes[0]!.exitWithoutStatus();

  const closing = manager.close();
  assert.equal(
    await settleWithin(closing, 800),
    'settled',
    'close waited past the deadline of the capture it adopted',
  );
  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'timeout' &&
      error.failureCode === 'bridge-request-deadline',
  );
  assert.deepEqual(fixture.processes[0]!.signals, []);
  assert.equal(exitDiagnostics(fixture).length, 0);
});

test('the manager rejects a tree when the target process changes during acquisition', async () => {
  const fixture = createLifecycleFixture({ targetStartTimes: ['start-1', 'start-2'] });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) =>
      error instanceof SnapshotSourceError &&
      error.failureKind === 'stale-target' &&
      error.failureCode === 'target-process-changed',
  );
  await manager.close();
});

test('typed guest failures retain their kind after target validation', async () => {
  const fixture = createLifecycleFixture({ responseErrorKind: 'application_not_responding' });
  const manager = new SnapshotBridgeManager(fixture.host);

  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'timeout',
  );
  await manager.close();
});

test('slow helper readiness detaches from a capture and later uses the same process', async () => {
  vi.useFakeTimers();
  const fixture = createLifecycleFixture({ connectDelayMs: 3000 });
  fixture.host = { ...fixture.host, ensureDirectory: async () => {}, remove: async () => {} };
  const manager = new SnapshotBridgeManager(fixture.host);
  try {
    const first = manager.request({
      target,
      bridge,
      limits,
      maxDepth: 10,
      deadline: deadline(undefined, 5000),
    });
    const rejected = assert.rejects(
      first,
      (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'preparing',
    );
    const concurrent = assert.rejects(
      manager.request({
        target,
        bridge,
        limits,
        maxDepth: 10,
        deadline: deadline(undefined, 5000),
      }),
      (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'preparing',
    );
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.all([rejected, concurrent]);
    assert.equal(fixture.processes.length, 1);
    assert.equal(fixture.sockets.length, 0);
    await vi.advanceTimersByTimeAsync(1000);
    const later = manager.request({
      target,
      bridge,
      limits,
      maxDepth: 10,
      deadline: deadline(undefined, 5000),
    });
    await vi.advanceTimersByTimeAsync(10);
    await later;
    assert.equal(fixture.processes.length, 1);
    assert.equal(fixture.sockets[0]?.writes, 1);
  } finally {
    await manager.close();
    vi.useRealTimers();
  }
});

test('owned startup expiry remains a timeout for a later uncancelled capture', async () => {
  vi.useFakeTimers();
  const fixture = createLifecycleFixture({ connectDelayMs: 20000 });
  fixture.host = { ...fixture.host, ensureDirectory: async () => {}, remove: async () => {} };
  const manager = new SnapshotBridgeManager(fixture.host);
  const caller = new AbortController();
  try {
    const first = assert.rejects(
      manager.request({
        target,
        bridge,
        limits,
        maxDepth: 10,
        deadline: deadline(undefined, 5000),
      }),
      (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'preparing',
    );
    await vi.advanceTimersByTimeAsync(2001);
    await first;
    await vi.advanceTimersByTimeAsync(8000);
    await assert.rejects(
      manager.request({
        target,
        bridge,
        limits,
        maxDepth: 10,
        deadline: deadline(caller.signal, 5000),
      }),
      (error: unknown) =>
        error instanceof SnapshotSourceError &&
        error.failureKind === 'timeout' &&
        error.failureCode === 'bridge-startup-deadline',
    );
    assert.equal(caller.signal.aborted, false);
    assert.equal(fixture.processes.length, 1);
    assert.deepEqual(fixture.processes[0]!.signals, ['SIGTERM']);
    assert.equal(fixture.sockets.length, 0);
  } finally {
    await manager.close();
    vi.useRealTimers();
  }
});

test('close adopts paused startup, awaits cleanup and refuses future requests', async () => {
  const fixture = createLifecycleFixture();
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = new SnapshotBridgeManager({
    ...fixture.host,
    ensureDirectory: async () => {
      entered();
      await paused;
    },
  });
  const pending = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 5000),
  });
  const refused = assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureCode === 'source-closed',
  );
  await reached;
  let finished = false;
  const closing = manager.close().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await closing;
  await refused;
  assert.equal(fixture.processes.length, 0);
  await assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline() }),
    /source-closed/,
  );
});

test('caller abort cancels only the wait for shared helper readiness', async () => {
  const fixture = createLifecycleFixture({ connectDelayMs: 80 });
  const manager = new SnapshotBridgeManager(fixture.host);
  const controller = new AbortController();
  const pending = manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(controller.signal, 1000),
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'cancelled',
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await manager.request({
    target,
    bridge,
    limits,
    maxDepth: 10,
    deadline: deadline(undefined, 1000),
  });
  assert.equal(fixture.processes.length, 1);
  assert.deepEqual(fixture.processes[0]?.signals, []);
  await manager.close();
});

test('binary time and helper startup consume one readiness allowance', async () => {
  vi.useFakeTimers();
  const fixture = createLifecycleFixture({ connectDelayMs: 1500 });
  fixture.host = { ...fixture.host, ensureDirectory: async () => {}, remove: async () => {} };
  const manager = new SnapshotBridgeManager(fixture.host);
  try {
    const captureDeadline = deadline(undefined, 5000);
    const readinessDeadline = deadline(undefined, 2000);
    await vi.advanceTimersByTimeAsync(1500);
    const pending = manager.request({
      target,
      bridge,
      limits,
      maxDepth: 10,
      deadline: captureDeadline,
      readinessDeadline,
    });
    const rejected = assert.rejects(
      pending,
      (error: unknown) => error instanceof SnapshotSourceError && error.failureKind === 'preparing',
    );
    await vi.advanceTimersByTimeAsync(501);
    await rejected;
    assert.equal(fixture.sockets.length, 0);
    await vi.advanceTimersByTimeAsync(1000);
    const callers = [1, 2].map(() =>
      manager.request({
        target,
        bridge,
        limits,
        maxDepth: 10,
        deadline: deadline(undefined, 5000),
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(callers);
    assert.equal(fixture.processes.length, 1);
    assert.equal(fixture.sockets[0]?.writes, 2);
  } finally {
    await manager.close();
    vi.useRealTimers();
  }
});

test('close cleans a late connection without publishing it', async () => {
  const fixture = createLifecycleFixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = new SnapshotBridgeManager({
    ...fixture.host,
    connect: async (...args) => {
      entered();
      await gate;
      return await fixture.host.connect(...args);
    },
  });
  const refused = assert.rejects(
    manager.request({ target, bridge, limits, maxDepth: 10, deadline: deadline(undefined, 5000) }),
    (error: unknown) =>
      error instanceof SnapshotSourceError && error.failureCode === 'source-closed',
  );
  await reached;
  const closing = manager.close();
  release();
  await closing;
  await refused;
  assert.equal(fixture.sockets[0]?.destroyed, true);
  assert.deepEqual(fixture.processes[0]?.signals, ['SIGTERM']);
});
