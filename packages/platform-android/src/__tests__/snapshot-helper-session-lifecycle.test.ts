import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import {
  resetAndroidSnapshotHelperSessions,
  stopAndroidSnapshotHelperSession,
} from '../snapshot-helper-session-lifecycle.ts';
import { recoverAndroidSnapshotHelperRetirement } from '../snapshot-helper-retirement.ts';
import {
  createSessionProvider,
  FakeAndroidProcess,
  type SessionProviderOptions,
} from './snapshot-helper-session.fixtures.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from '../adb-executor.ts';

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

test('returns undefined when persistent sessions are disabled', async () => {
  process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION = '0';
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
  });

  assert.equal(output, undefined);
  assert.deepEqual(calls, []);
});

test('returns undefined when the adb provider cannot spawn a helper process', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const output = await captureAndroidSnapshotWithHelperSession({ adb });

  assert.equal(output, undefined);
  assert.deepEqual(calls, []);
});

test('disables repeated persistent session attempts after startup failure', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    spawn: (args) => {
      spawnArgs.push(args);
      const process = new FakeAndroidProcess();
      queueMicrotask(() => process.emitExit(0, null));
      return process;
    },
  };

  const first = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  const second = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(spawnArgs.length, 1);
  assert.equal(readSessionArgument(spawnArgs[0]!, 'timeoutMs'), '2000');
  assert.equal(calls.filter((args) => args[0] === 'forward').length, 2);
});

test('a start that failed for a transient reason is retried instead of ending the persistent path', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const calls: string[][] = [];
    const spawnArgs: string[][] = [];
    const provider = createSessionProvider({ calls, spawnArgs });
    let transportHealthy = false;
    const adb: AndroidAdbExecutor = async (args, options) => {
      if (args[0] === 'forward' && !transportHealthy) throw new Error('adb server is restarting');
      return await provider.exec!(args, options);
    };
    const capture = () =>
      captureAndroidSnapshotWithHelperSession({
        adb,
        adbProvider: { ...provider, exec: adb },
        deviceKey: 'android:emulator-5554',
      });

    assert.equal(await capture(), undefined);
    assert.equal(await capture(), undefined);
    assert.equal(spawnArgs.length, 0, 'the failed start is not retried inside its cooldown');

    vi.advanceTimersByTime(61_000);
    transportHealthy = true;
    assert.match((await capture())?.xml ?? '', /snapshot 1/);
    assert.equal(spawnArgs.length, 1);
  } finally {
    vi.useRealTimers();
  }
});

test('starts and reuses a persistent Android snapshot helper session', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const provider = createSessionProvider({ calls, spawnArgs });

  const first = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    helperVersion: '0.16.2',
    helperVersionCode: 16002,
  });
  const second = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    helperVersion: '0.16.2',
    helperVersionCode: 16002,
  });

  assert.match(first?.xml ?? '', /snapshot 1/);
  assert.equal(first?.metadata.transport, 'persistent-session');
  assert.equal(first?.metadata.sessionReused, false);
  assert.equal(first?.metadata.elapsedMs, 7);
  assert.match(second?.xml ?? '', /snapshot 2/);
  assert.equal(second?.metadata.transport, 'persistent-session');
  assert.equal(second?.metadata.sessionReused, true);
  assert.equal(spawnArgs.length, 1);
  assert.equal(
    calls.filter((args) => args[0] === 'forward' && args[1]?.startsWith('tcp:')).length,
    1,
  );
});

test('restarts the helper session when capture options change', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const provider = createSessionProvider({ calls, spawnArgs });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    waitForIdleTimeoutMs: 25,
  });
  const restarted = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    waitForIdleTimeoutMs: 50,
  });

  assert.equal(restarted?.metadata.sessionReused, false);
  assert.equal(spawnArgs.length, 2);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('a quit acknowledged and followed by process exit skips the force-stop round trip', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, quitExitDelayMs: 25 });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  await resetAndroidSnapshotHelperSessions();

  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.killed, false);
  // Acknowledged quit plus an observed exit IS the release evidence, so the extra adb round trip
  // buys nothing.
  assert.equal(calls.some(isHelperRuntimeForceStop), false);
});

test('a quit acknowledged by a helper the host then killed still force-stops the runtime', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({
    calls,
    processes,
    quitExit: { code: null, signal: 'SIGKILL' },
  });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  await resetAndroidSnapshotHelperSessions();

  // The ack alone only says the helper heard us. A host process that ended on a signal says the
  // transport died, not that the instrumentation finished releasing UiAutomation — so the second
  // half of the release evidence is missing and the device-side stop must still run.
  assert.equal(calls.some(isHelperRuntimeForceStop), true);
});

test('a quit acknowledged after the host process already died still force-stops the runtime', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  // The host `am instrument` child is gone before the teardown starts, yet the device-side helper
  // answers `quit` through the still-open forward: positive evidence that it OUTLIVED its host.
  processes[0]?.emitExit(0, null);
  await resetAndroidSnapshotHelperSessions();

  assert.equal(calls.some(isHelperRuntimeForceStop), true);
});

test('force terminates the helper when quit is not acknowledged', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, quitResponseMode: 'malformed' });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  await resetAndroidSnapshotHelperSessions();

  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.killed, true);
  // Nothing proved the helper released UiAutomation, so the device-side stop must still run.
  assert.equal(calls.some(isHelperRuntimeForceStop), true);
});

test('keeps the device-side stop when the transport cannot prove the device exit status', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, shellProtocolV2: false });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  await resetAndroidSnapshotHelperSessions();

  // Same host-side evidence as the skip above — acknowledged quit, host child exited 0 — but this
  // transport has no shell protocol v2, so adb reports 0 for instrumentation that never finished.
  // That 0 is not release evidence, and the device-side stop stays.
  assert.equal(calls.some(isHelperRuntimeForceStop), true);
});

test('keeps the device-side stop when the transport capability is unknown', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, featureProbeFailure: true });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  await resetAndroidSnapshotHelperSessions();

  // An adb that cannot answer the probe never proved anything either.
  assert.equal(calls.some(isHelperRuntimeForceStop), true);
});

test('probes the adb transport once per device instead of once per teardown', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls });
  const deviceKey = 'android:emulator-5554';

  for (let teardown = 0; teardown < 2; teardown += 1) {
    await captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey,
    });
    await stopAndroidSnapshotHelperSession(deviceKey);
  }

  assert.equal(calls.filter((args) => args[0] === 'features').length, 1);
  assert.equal(calls.some(isHelperRuntimeForceStop), false);
});

test('whole-module reset clears a release the last teardown left pending', async () => {
  const options: SessionProviderOptions = {
    calls: [],
    quitResponseMode: 'malformed',
    runtimeRelease: 'occupied',
  };
  const provider = createSessionProvider(options);
  const deviceKey = 'android:emulator-5554';

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey,
  });
  await resetAndroidSnapshotHelperSessions();
  const forceStopsAfterReset = countForceStops(options);

  await recoverAndroidSnapshotHelperRetirement({
    deviceKey,
    adb: provider.exec,
  });

  assert.ok(forceStopsAfterReset > 0, 'the teardown stopped the runtime');
  assert.equal(countForceStops(options), forceStopsAfterReset);
});

function countForceStops(options: SessionProviderOptions): number {
  return options.calls.filter((args) => isHelperRuntimeForceStop(args)).length;
}

function isHelperRuntimeForceStop(args: string[]): boolean {
  return args.join(' ') === 'shell am force-stop com.callstack.agentdevice.snapshothelper';
}

function readSessionArgument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
