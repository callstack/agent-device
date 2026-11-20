// #4585: plain `close` owes a stop to the PROCESS its own `open` launched, not to whichever process
// answers the serial now. #4807: `close --shutdown` commands that stop and never asks the ownership
// question, but it confirms the recorded process left like plain close does. Routed through the
// session command handler, so claim acquisition, renewal, launch-identity recording and close
// teardown all run against real claim files. What the host says about the launched process is
// answered by the launched-process owner fixture, exactly as the composed owner answers it — the
// process reads themselves are pinned in the Android and composition lanes.
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

import {
  launchedProcessOwnerAnswers as owner,
  resetLaunchedProcessOwnerAnswers,
} from '../../../../__tests__/support/launched-process-owner-fixture.ts';

/** The identity `open` records for the emulator process it launched. */
const LAUNCH_IDENTITY = { pid: 4112, startTime: 'launch-start-time' } as const;
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
    /** Selects an emulator that is already running, so this open launches no process. */
    selectsBootedDevice?: boolean;
    deviceShutdownDenied?: boolean;
    /** A cold open whose readiness never reported the process it launched. */
    omitLaunchIdentity?: boolean;
    /** Runs while close dispatches its platform close, before the stop is asked for. */
    duringPlatformClose?: () => void;
  }) {
    if (command.selectsDevice) {
      vi.mocked(resolveTargetDevice).mockResolvedValue(STOPPED_AVD);
      mockEnsureReadyRuntime.mockImplementation(async (input) => {
        if (!command.omitLaunchIdentity) input.onAndroidEmulatorLaunchIdentity?.(LAUNCH_IDENTITY);
        return BOOTED_EMULATOR;
      });
    }
    if (command.selectsBootedDevice) {
      // Selection finds a running emulator, so the open launches no process and records no identity.
      vi.mocked(resolveTargetDevice).mockResolvedValue(BOOTED_EMULATOR);
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
        ...(command.duringPlatformClose
          ? {
              closeApplication: async (...args: Parameters<typeof operations.closeApplication>) => {
                command.duringPlatformClose?.();
                return await operations.closeApplication(...args);
              },
            }
          : {}),
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
 * session caused, with the launched process recorded as the host answered for it.
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
  expect(session?.androidLaunchIdentity).toEqual(LAUNCH_IDENTITY);
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
const STOP_UNCONFIRMED_WARNING =
  'Close asked this device to stop, but could not confirm that its emulator process exited. The device may still be running.';

beforeEach(() => {
  mockEnsureReadyRuntime.mockReset();
  mockEnsureReadyRuntime.mockResolvedValue(undefined);
  resetLaunchedProcessOwnerAnswers();
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
  // The launched process was asked about once, with the recorded identity, and confirmed as stopped,
  // so nothing was escalated; the session is retired with its claim like any successful close.
  expect(owner.checks).toEqual([{ device: BOOTED_EMULATOR, identity: LAUNCH_IDENTITY }]);
  expect(owner.confirmations).toEqual([LAUNCH_IDENTITY]);
  expect(runs.sessionStore.get(SESSION)).toBeUndefined();
  expect(runs.sessionClaimCount()).toBe(0);
}, 30_000);

test('a replacement that takes the serial during platform close is not stopped', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  let platformCloseRan = false;

  // The launched process still runs when close starts. It is replaced while close dispatches its
  // platform close, so the one ownership read, taken right before the stop, must see the change.
  const closed = await runs.run({
    name: 'close',
    duringPlatformClose: () => {
      platformCloseRan = true;
      expect(owner.checks).toEqual([]);
      owner.check = 'changed';
    },
  });

  expect(platformCloseRan).toBe(true);
  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([expect.objectContaining({ shutdownTarget: false })]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_CHANGED_WARNING]);
  expect(owner.checks).toHaveLength(1);
  expect(owner.confirmations).toEqual([]);
}, 30_000);

test('plain close warns when the stop could not be confirmed', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  owner.confirmation = 'unconfirmed';

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: true, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  // The stop was asked of the device and the owner escalated to the launched process; the caller
  // is told that the exit was not confirmed.
  expect(closeWarningMessages(closed.response!)).toEqual([STOP_UNCONFIRMED_WARNING]);
  expect(owner.confirmations).toEqual([LAUNCH_IDENTITY]);
});

test('plain close leaves an emulator rebooted outside the session running and says why', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  // Somebody else's actor kills this emulator and boots the same AVD; the recorded process is gone,
  // and the serial is answered by a process this session never launched.
  owner.check = 'changed';
  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_CHANGED_WARNING]);
  if (closed.response?.ok) expect(closed.response.data).not.toHaveProperty('shutdown');
  // Close asks about the launched process once, and only as its own decision.
  expect(owner.checks).toHaveLength(1);
  expect(owner.confirmations).toEqual([]);
}, 30_000);

test('Quick Boot retains the replacement with the same serial and restored guest uptime', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  // The default quick-boot restore keeps the guest clock and the serial, and the new emulator
  // process happens to reuse the pid. Only the process identity separates the two lifetimes, and
  // the owner is the one that reads it.
  owner.check = 'changed';
  const closed = await runs.run({ name: 'close' });

  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_CHANGED_WARNING]);
});

test('plain close retains the emulator when the host will not answer for the recorded process', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  owner.check = 'unverified';

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: false, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([PROCESS_UNVERIFIED_WARNING]);
  expect(owner.confirmations).toEqual([]);
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
  // Nothing was recorded, so close asks about a process it cannot name, and a stop is never
  // confirmed against an identity that does not exist.
  expect(owner.checks).toEqual([{ device: BOOTED_EMULATOR, identity: undefined }]);
  expect(owner.confirmations).toEqual([]);
  expect(closeWarningMessages(closed.response!)).toEqual([NO_LAUNCH_IDENTITY_WARNING]);
});

test('close --shutdown stops the device without asking whether it still owns the launched process', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  owner.check = 'changed';
  owner.confirmation = 'stopped';

  const closed = await runs.run({ name: 'close', flags: { shutdown: true } });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: true, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
  // #4807: an explicit --shutdown is the user's own command for the device, so the ownership CHECK
  // cannot gate it — the answer above says the recorded process is gone and the stop goes ahead
  // anyway. The recorded process is still confirmed once the stop was asked for.
  expect(owner.checks).toEqual([]);
  expect(owner.confirmations).toEqual([LAUNCH_IDENTITY]);
}, 30_000);

test('close --shutdown warns when the stop could not be confirmed', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  owner.confirmation = 'unconfirmed';

  const closed = await runs.run({ name: 'close', flags: { shutdown: true } });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: true, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(owner.confirmations).toEqual([LAUNCH_IDENTITY]);
  expect(closeWarningMessages(closed.response!)).toEqual([STOP_UNCONFIRMED_WARNING]);
}, 30_000);

test('close --shutdown on a prebooted emulator asks for no process confirmation', async () => {
  const runs = createRoutedSession();
  // A prebooted device: `open` selected a running emulator, so nothing was launched and no process
  // identity was recorded. There is no process this session can confirm, and close does not go looking
  // for one by serial.
  const opened = await runs.run({
    name: 'open',
    flags: { platform: 'android' },
    selectsBootedDevice: true,
  });
  expect(opened.response?.ok).toBe(true);
  expect(runs.sessionStore.get(SESSION)?.androidLaunchIdentity).toBeUndefined();

  const closed = await runs.run({ name: 'close', flags: { shutdown: true } });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([
    expect.objectContaining({ shutdownTarget: true, retainRunner: false }),
  ]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(owner.checks).toEqual([]);
  expect(owner.confirmations).toEqual([]);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
}, 30_000);

test('a policy refusal stays the reported reason and asks nothing of the process owner', async () => {
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
  expect(owner.checks).toEqual([]);
}, 30_000);

test('a lost claim stays the reported reason and asks nothing of the process owner', async () => {
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
  expect(owner.checks).toEqual([]);
}, 30_000);

test('changing the device serial clears launch ownership', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  const ref = runs.sessionStore.lookup(SESSION)!;
  runs.sessionStore.updateOpenDevice(ref, { ...BOOTED_EMULATOR, id: 'emulator-5556' }, false);
  expect(runs.sessionStore.get(SESSION)?.androidLaunchIdentity).toBeUndefined();
  expect(runs.sessionStore.get(SESSION)?.bootedByOpen).toBeUndefined();
});
