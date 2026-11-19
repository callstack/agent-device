// #4585: plain `close` owes a stop to the emulator PROCESS its own `open` launched, not to whichever
// process answers the serial now. Routed through the session command handler, so claim acquisition,
// renewal, launch-identity recording and close teardown all run against real claim files, and the
// only host fact close reads about the launched process is the `ps` of the recorded pid.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import * as hostProcess from '@agent-device/host-kit/process';
import {
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
  pinOwnProcessStartTime,
} from '@agent-device/test-kit';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../../__tests__/support/device-selection-stub.ts');
  const resolveTargetDevice = vi.fn();
  return {
    ...actual,
    resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(resolveTargetDevice)),
  };
});

// The host's answers about the emulator process `open` launched are modelled so no case signals or
// waits on a real process. `launchedEmulatorProcess()` is that model.
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const { launchedEmulatorProcessHost } =
    await import('../../../../__tests__/support/launched-emulator-process-fixture.ts');
  return launchedEmulatorProcessHost(
    await importOriginal<typeof import('@agent-device/host-kit/process')>(),
  );
});

import {
  launchedEmulatorProcess as launched,
  resetLaunchedEmulatorProcess,
} from '../../../../__tests__/support/launched-emulator-process-fixture.ts';

/** The identity `open` records for the emulator process it launched, as the model answers for it. */
const launchedEmulatorIdentity = () => ({ pid: launched.pid, startTime: launched.startTime });
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import type { CloseApplicationFinalizationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  applicationLifecycleRuntimeFixture,
  type LifecycleOperationsLoader,
} from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import {
  handleSessionCommands,
  mockEnsureReadyRuntime,
  mockShutdownTargetRuntime,
} from '../../../../__tests__/support/handlers/session-command-harness.ts';
import {
  clearDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { SessionStore } from '../../../../core/session-store.ts';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import type { DeviceInfo } from '@agent-device/kernel/device';

pinOwnProcessStartTime(hostProcess);
bindTestCommandHost();

const SESSION = 'implicit-shutdown-session';

/** The AVD as inventory lists it while stopped: addressed by its AVD name, not booted. */
const STOPPED_AVD: DeviceInfo = {
  platform: 'android',
  id: 'pixel-avd',
  name: 'Pixel_9_API_37',
  kind: 'emulator',
  booted: false,
};

/** The same emulator once it runs. An outside restart keeps this identity and serial. */
const BOOTED_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel_9_API_37',
  kind: 'emulator',
  booted: true,
};

function createRoutedSession() {
  const stateDir = mkdtempForTestSync('agent-device-session-close-launch-owner-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims'),
  };
  const sessionStore = new SessionStore(path.join(stateDir, 'sessions'), {
    env,
    cwd: process.cwd(),
  });

  async function run(command: {
    name: 'open' | 'close';
    flags?: Record<string, unknown>;
    /** Only a cold open selects a device, and that selection is what boots the stopped AVD. */
    selectsDevice?: boolean;
    deviceShutdownDenied?: boolean;
    /** A cold open whose readiness never reported the process it launched. */
    omitLaunchIdentity?: boolean;
  }) {
    if (command.selectsDevice) {
      vi.mocked(resolveTargetDevice).mockResolvedValue(STOPPED_AVD);
      mockEnsureReadyRuntime.mockImplementation(async (input) => {
        if (!command.omitLaunchIdentity)
          input.onAndroidEmulatorLaunchIdentity?.(launchedEmulatorIdentity());
        return BOOTED_EMULATOR;
      });
    }
    // Record the close finalization the daemon asks for, while keeping the fixture's own leaf
    // shutdown, so `mockShutdownTargetRuntime` still counts the stop the platform was asked to do.
    const finalizeAsks: CloseApplicationFinalizationInput[] = [];
    const loader: LifecycleOperationsLoader = async (device, signal, shutdownTarget) => {
      const operations = await applicationLifecycleRuntimeFixture(device, signal, shutdownTarget);
      const finalizeApplicationClose = operations.finalizeApplicationClose;
      return Object.freeze({
        ...operations,
        finalizeApplicationClose: async (input) => {
          finalizeAsks.push(input);
          return await finalizeApplicationClose(input);
        },
      });
    };
    const response = await handleSessionCommands({
      host: createTestHostEnvironment({ env }),
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      sessionStore,
      invoke: async () => ({ ok: true, data: {} }),
      lifecycleOperationsLoader: loader,
      ...(command.deviceShutdownDenied === undefined
        ? {}
        : { deviceShutdownDenied: command.deviceShutdownDenied }),
      req: {
        token: 't',
        command: command.name,
        session: SESSION,
        positionals: ['Demo'],
        flags: command.flags ?? {},
      },
      sessionName: SESSION,
      logPath: path.join(stateDir, 'daemon.log'),
    });
    return { response, finalizeAsks };
  }

  /** Claims on disk for this case's device, which a successful close releases with the session. */
  function sessionClaimCount() {
    return inspectDeviceClaims({ serial: BOOTED_EMULATOR.id }, env).length;
  }

  return {
    dropSessionClaim: async () => {
      const ownership = sessionStore.get(SESSION)?.deviceClaim;
      if (!ownership) throw new Error('expected the session to record its claim');
      await clearDeviceClaim(ownership, env);
    },
    run,
    sessionClaimCount,
    sessionStore,
  };
}

/**
 * Opens a stopped AVD through the cold route and leaves the emulator running on the boot this
 * session caused, with the launched process recorded as the host answers for it.
 */
async function openBootedByThisSession(runs: ReturnType<typeof createRoutedSession>) {
  const opened = await runs.run({
    name: 'open',
    flags: { platform: 'android' },
    selectsDevice: true,
  });
  expect(opened.response?.ok).toBe(true);
  const session = runs.sessionStore.get(SESSION);
  // The boot fact and the identity of the process that caused it are written together, and that
  // pair is the only thing close may act on.
  expect(session?.bootedByOpen).toBe(true);
  expect(session?.androidLaunchIdentity).toEqual(launchedEmulatorIdentity());
}

function closeWarningMessages(response: { ok?: unknown; data?: unknown }): unknown {
  if (!response.ok) throw new Error('expected a successful close');
  return (response.data as { warnings?: string[] }).warnings;
}

const PROCESS_CHANGED_WARNING =
  "This session's open booted this device, but its emulator process has changed, so close did not request a stop. The device is still running.";
const PROCESS_UNVERIFIED_WARNING =
  "This session's open booted this device, but close could not verify its emulator process identity, so it did not request a stop and left the device as it found it.";
const NO_LAUNCH_IDENTITY_WARNING =
  "This session's open booted this device, but open recorded no emulator process identity, so close did not request a stop and left the device as it found it.";

beforeEach(() => {
  mockEnsureReadyRuntime.mockReset();
  mockEnsureReadyRuntime.mockResolvedValue(undefined);
  resetLaunchedEmulatorProcess();
});

afterEach(() => {
  vi.useRealTimers();
});

test('plain close stops the emulator this session booted while it still runs that boot', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: true, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
  if (closed.response?.ok)
    expect(closed.response.data).toMatchObject({ shutdown: { success: true } });
  // The launched process took the shutdown it was asked for, so nothing was ever signalled by pid,
  // and the session is retired with its claim like any successful close.
  expect(launched.signalAttempts).toEqual([]);
  expect(runs.sessionStore.get(SESSION)).toBeUndefined();
  expect(runs.sessionClaimCount()).toBe(0);
}, 30_000);

test('plain close stops the launched process itself when it ignores the emulator console kill', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  launched.exitsOnKill = false;

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
  // The escalation aims only at the process this session launched, with the identity open recorded,
  // which is what host-kit requires before it signals anything.
  expect(launched.signalAttempts).toEqual([{ pid: launched.pid, startTime: launched.startTime }]);
});

test('plain close leaves an emulator rebooted outside the session running and says why', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  // Somebody else's actor kills this emulator and boots the same AVD; the recorded process is gone,
  // and the serial is answered by a process this session never launched.
  launched.alive = false;
  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_CHANGED_WARNING]);
  if (closed.response?.ok) expect(closed.response.data).not.toHaveProperty('shutdown');
  // Close reads the launched process once, and only as its own decision.
  expect(launched.factReads).toBe(1);
}, 30_000);

test('Quick Boot retains the replacement with the same serial and restored guest uptime', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  // The default quick-boot restore keeps the guest clock and the serial, and the new emulator
  // process happens to reuse the pid. Only the start time separates the two lifetimes.
  launched.liveStartTime = 'replacement-start-time';
  const closed = await runs.run({ name: 'close' });

  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_CHANGED_WARNING]);
});

test('plain close leaves the emulator running when a zombie answers the recorded pid', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  launched.zombie = true;

  const closed = await runs.run({ name: 'close' });

  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_CHANGED_WARNING]);
});

test('plain close retains the emulator when the host will not answer for the recorded pid', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  launched.unreadable = true;

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_UNVERIFIED_WARNING]);
  expect(launched.signalAttempts).toEqual([]);
}, 30_000);

test('missing launch identity does not acquire ownership from a later process read', async () => {
  const runs = createRoutedSession();
  const opened = await runs.run({
    name: 'open',
    flags: { platform: 'android' },
    selectsDevice: true,
    omitLaunchIdentity: true,
  });
  expect(opened.response?.ok).toBe(true);

  const closed = await runs.run({ name: 'close' });

  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  // Nothing was recorded, so close has no pid to read and asks the host nothing.
  expect(launched.factReads).toBe(0);
  expect(closeWarningMessages(closed.response!)).toEqual([NO_LAUNCH_IDENTITY_WARNING]);
});

test('close --shutdown stops the device and never signals the launched process', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  launched.alive = false;
  launched.exitsOnKill = false;

  const closed = await runs.run({ name: 'close', flags: { shutdown: true } });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: true, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
  expect(launched.signalAttempts).toEqual([]);
}, 30_000);

test('a policy refusal stays the reported reason and reads no process', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  const closed = await runs.run({ name: 'close', deviceShutdownDenied: true });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([
    "This session's open booted this device and close would stop it, but this daemon's policy denies device-shutdown. The device is still running.",
  ]);
  expect(launched.factReads).toBe(0);
}, 30_000);

test('a lost claim stays the reported reason and reads no process', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  await runs.dropSessionClaim();

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([
    "This session's open booted this device, but close could not verify its device claim and did not request a stop.",
  ]);
  expect(launched.factReads).toBe(0);
}, 30_000);

test('changing the device serial clears launch ownership', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  const ref = runs.sessionStore.lookup(SESSION)!;
  runs.sessionStore.updateOpenDevice(ref, { ...BOOTED_EMULATOR, id: 'emulator-5556' }, false);
  expect(runs.sessionStore.get(SESSION)?.androidLaunchIdentity).toBeUndefined();
  expect(runs.sessionStore.get(SESSION)?.bootedByOpen).toBeUndefined();
});
