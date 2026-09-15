import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import {
  resetAndroidSnapshotHelperSessions,
  resolveAndroidSnapshotHelperStartBudgetMs,
  stopAndroidSnapshotHelperSession,
} from '../snapshot-helper-session-lifecycle.ts';
import { recoverAndroidSnapshotHelperRetirement } from '../snapshot-helper-retirement.ts';
import {
  createSessionProvider,
  FakeAndroidProcess,
  isAndroidHelperRuntimeForceStop,
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

test('a helper that never starts is not spawned again on every command', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const provider = createSessionProvider({ calls });
  // The spawned instrumentation never announces readiness, so every start spends the caller's whole
  // command budget failing before the one-shot transport answers. Paying for that on every command
  // is what made the commands of #2553 take roughly twice as long.
  const adbProvider: AndroidAdbProvider = {
    ...provider,
    spawn: (args) => {
      spawnArgs.push(args);
      return new FakeAndroidProcess();
    },
  };

  for (let command = 0; command < 3; command += 1) {
    const output = await captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider,
      deviceKey: 'android:emulator-5554',
      commandTimeoutMs: 50,
    });
    assert.equal(output, undefined, 'the one-shot transport answers every command');
  }

  assert.equal(spawnArgs.length, 1, 'a failed start earns a backoff, not another spawn');
  assert.equal(
    calls.filter((args) => args[0] === 'forward' && args[1]?.startsWith('tcp:')).length,
    1,
  );

  // The backoff belongs to one helper build under one set of budgets, not to the device forever.
  const otherBuild = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider,
    deviceKey: 'android:emulator-5554',
    commandTimeoutMs: 50,
    waitForIdleTimeoutMs: 40,
  });

  assert.equal(otherBuild, undefined);
  assert.equal(spawnArgs.length, 2, 'a different capture identity is not covered by the backoff');
});

test('a session start waits only as long as the caller budgeted for one helper command', async () => {
  const spawnArgs: string[][] = [];
  const provider = createSessionProvider({ calls: [], spawnArgs });
  const startedAtMs = Date.now();

  // The spawned instrumentation never announces readiness, so only the caller's own command budget
  // ends the wait. A fixed floor above it would starve the one-shot transport this call falls back to.
  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: {
      ...provider,
      spawn: (args) => {
        spawnArgs.push(args);
        return new FakeAndroidProcess();
      },
    },
    deviceKey: 'android:emulator-5554',
    commandTimeoutMs: 50,
  });

  assert.equal(output, undefined);
  assert.equal(spawnArgs.length, 1);
  assert.ok(
    Date.now() - startedAtMs < 3_000,
    'the start obeys the caller budget, not a fixed floor',
  );
});

test('a generous caller budget buys a slow start, and never more than the caller allowed', () => {
  // A capture-sized guess is what pushed the slow hosts of #2553 off the persistent path even when
  // `--timeout` left plenty of room for the same start in the one-shot transport.
  assert.equal(resolveAndroidSnapshotHelperStartBudgetMs(60_000), 30_000);
  assert.equal(resolveAndroidSnapshotHelperStartBudgetMs(30_000), 15_000);
  // A short budget buys nothing extra, and a tiny one is not answered with a longer wait.
  assert.equal(resolveAndroidSnapshotHelperStartBudgetMs(6_000), 5_000);
  assert.equal(resolveAndroidSnapshotHelperStartBudgetMs(1_000), 1_000);
});

test('a session that reaches ready settles a release the device could not confirm', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  // The device answers every process read with an adb error no classifier lists, and the first
  // command's session stalls, so that command's teardown records a release nothing could prove.
  const provider = createSessionProvider({
    calls,
    spawnArgs,
    stalledSnapshots: 1,
    runtimeRelease: 'closed',
  });

  const stalled = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    commandTimeoutMs: 400,
  });
  assert.equal(stalled, undefined);

  const started = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    commandTimeoutMs: 400,
  });
  assert.equal(started?.metadata.sessionReused, false);
  const forceStopsWhilePending = calls.filter(isAndroidHelperRuntimeForceStop).length;

  // `am instrument` force-stops whatever is already instrumenting the helper package, so the helper
  // that just reported itself ready is the only one the device has, and the pending release went
  // away with the process that owed it.
  const reused = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    commandTimeoutMs: 400,
  });

  assert.equal(reused?.metadata.sessionReused, true);
  assert.equal(
    calls.filter(isAndroidHelperRuntimeForceStop).length,
    forceStopsWhilePending,
    'a live session is not force-stopped for a release its own readiness settled',
  );
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

test('a session whose helper process died is not written to again', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, spawnArgs, processes });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  processes[0]!.emitExit(137, null);

  const restarted = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
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
