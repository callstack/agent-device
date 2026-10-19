import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAndroidHelperRuntimeState } from '../adb-host.ts';
import { recoverAndroidSnapshotHelperRetirement } from '../snapshot-helper-retirement.ts';
import {
  resetAndroidSnapshotHelperSessions,
  stopAndroidSnapshotHelperSession,
} from '../snapshot-helper-session-lifecycle.ts';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import {
  createSessionProvider,
  type SessionProviderOptions,
} from './snapshot-helper-session.fixtures.ts';

// Two daemon runtimes in one process each own their helper sessions, failed starts and pending
// retirements; closing one stops its helpers and leaves the other's warm.

function runtimeOnDevice(deviceKey: string, options: Partial<SessionProviderOptions> = {}) {
  const calls: (readonly string[])[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const provider = createSessionProvider({ calls, spawnArgs, ...options });
  const state = createAndroidHelperRuntimeState();
  return {
    calls,
    spawnArgs,
    provider,
    state,
    capture: async () =>
      await state.run(
        async () =>
          await captureAndroidSnapshotWithHelperSession({
            adb: provider.exec,
            adbProvider: provider,
            deviceKey,
          }),
      ),
  };
}

test("closing one runtime's helpers leaves another runtime's warm session in use", async () => {
  const a = runtimeOnDevice('android:emulator-5554');
  const b = runtimeOnDevice('android:emulator-5556');
  await a.capture();
  await b.capture();

  await a.state.run(async () => await resetAndroidSnapshotHelperSessions());

  const survivor = await b.capture();
  assert.equal(survivor?.metadata.sessionReused, true, "B's helper session was not stopped");
  assert.equal(b.spawnArgs.length, 1, 'B did not have to start another helper');
  const restarted = await a.capture();
  assert.equal(restarted?.metadata.sessionReused, false, "A's own session was stopped");
  assert.equal(a.spawnArgs.length, 2);
});

test("a runtime's pending retirement survives another runtime's close", async () => {
  const deviceKey = 'android:emulator-5554';
  const a = runtimeOnDevice(deviceKey, {
    quitResponseMode: 'malformed',
    runtimeRelease: 'occupied',
  });
  const b = runtimeOnDevice('android:emulator-5556');
  await a.capture();
  // A stops one device's helper and the device cannot confirm the release, so A holds a retirement.
  await a.state.run(async () => await stopAndroidSnapshotHelperSession(deviceKey));
  const stopsBefore = forceStops(a.calls);

  // The other runtime closing must not clear what A holds pending for its device.
  await b.state.run(async () => await resetAndroidSnapshotHelperSessions());
  await assert.rejects(
    a.state.run(
      async () => await recoverAndroidSnapshotHelperRetirement({ deviceKey, adb: a.provider.exec }),
    ),
    /still holding device automation ownership/,
  );

  assert.ok(forceStops(a.calls) > stopsBefore, 'A still settles the release it left pending');
});

function forceStops(calls: readonly (readonly string[])[]): number {
  return calls.filter(
    (args) => args.join(' ') === 'shell am force-stop com.callstack.agentdevice.snapshothelper',
  ).length;
}
