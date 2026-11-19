// #4585: plain `close` owes a stop to the boot its own `open` caused, not to whichever boot the
// device is running now. Routed through the session command handler, so claim acquisition, renewal,
// boot stamping and close teardown all run against real claim files.
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

import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import {
  handleSessionCommands,
  mockEnsureReadyRuntime,
  mockShutdownTargetRuntime,
} from '../../../../__tests__/support/handlers/session-command-harness.ts';
import {
  applicationLifecycleRuntimeFixture,
  type LifecycleOperationsLoader,
} from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import {
  acquireDeviceClaim,
  clearDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import type { DaemonPlatformServices } from '../../../../core/platform-services.ts';
import { SessionStore } from '../../../../core/session-store.ts';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import type { DeviceInfo } from '@agent-device/kernel/device';

pinOwnProcessStartTime(hostProcess);
bindTestCommandHost();

/** The clock every case runs on, so a boot epoch is a named instant rather than an elapsed guess. */
const CLOCK_START_MS = Date.UTC(2026, 0, 15, 10, 0, 0);
/** How far after the cold open a case places the emulator's next boot, and how long it has been up. */
const LATER_BOOT_DELAY_MS = 60_000;
const LATER_BOOT_UPTIME_MS = 45_000;
/** How long before a case's own boot a prior session's claim was taken. */
const PRIOR_CLAIM_GAP_MS = 30 * 60_000;

const SESSION = 'implicit-shutdown-session';
const OWN_GENERATION = { pid: 1234, startTime: 'original' };
const NEXT_GENERATION = { pid: 1234, startTime: 'replacement' };

/** The boot epoch of an emulator restarted outside the session: past, and later than the open's. */
const LATER_BOOT_MS = CLOCK_START_MS + LATER_BOOT_DELAY_MS - LATER_BOOT_UPTIME_MS;
const REBOOTED: DeviceBootObservation = { observed: true, bootedAtMs: LATER_BOOT_MS };

/** The AVD as inventory lists it while stopped: addressed by its AVD name, not booted. */
const STOPPED_AVD: DeviceInfo = {
  platform: 'android',
  id: 'pixel-avd',
  name: 'Pixel_9_API_35',
  kind: 'emulator',
  booted: false,
};

/** The same emulator once it runs. An outside reboot keeps this identity and serial. */
const BOOTED_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel_9_API_35',
  kind: 'emulator',
  booted: true,
};

function createRoutedSession(
  observeBootTimeMs?: (device: DeviceInfo) => Promise<DeviceBootObservation>,
) {
  const stateDir = mkdtempForTestSync('agent-device-session-close-reboot-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims'),
  };
  // The platform port supplies the emulator's observed boot time.
  const boot: { current: DeviceBootObservation } = {
    current: { observed: false, reason: 'unobserved' },
  };
  let bootAsks = 0;
  const generation: { current: typeof OWN_GENERATION | undefined } = { current: OWN_GENERATION };
  let generationAsks = 0;
  const platformServices = daemonPlatformServicesFixture({
    deviceBootObservation: {
      assessShutdownGeneration: async (_device, expected) => {
        if (!expected) return 'unobserved';
        generationAsks += 1;
        if (observeBootTimeMs) throw new Error('unavailable');
        const current = boot.current === REBOOTED ? NEXT_GENERATION : generation.current;
        return !current
          ? 'unobserved'
          : current.pid === expected.pid && current.startTime === expected.startTime
            ? 'same'
            : 'changed';
      },
      observeBootTimeMs: async (device: DeviceInfo): Promise<DeviceBootObservation> => {
        bootAsks += 1;
        return (await observeBootTimeMs?.(device)) ?? boot.current;
      },
    },
  }) as unknown as DaemonPlatformServices;
  const sessionStore = new SessionStore(path.join(stateDir, 'sessions'), {
    env,
    cwd: process.cwd(),
  });

  async function run(command: {
    name: 'open' | 'close';
    flags?: Record<string, unknown>;
    /** Only a cold open selects a device, and that selection is what boots the stopped AVD. */
    selectsDevice?: boolean;
    beforeAppOpen?(): void;
    deviceShutdownDenied?: boolean;
    omitLaunchIdentity?: boolean;
    beforeFinalization?(): void;
  }) {
    if (command.selectsDevice) {
      vi.mocked(resolveTargetDevice).mockResolvedValue(STOPPED_AVD);
      mockEnsureReadyRuntime.mockImplementation(async (input) => {
        if (!command.omitLaunchIdentity) input.onAndroidEmulatorLaunchIdentity?.(OWN_GENERATION);
        return BOOTED_EMULATOR;
      });
    }
    // Plain close is recorded at the lifecycle port the close dispatches, and the leaf
    // `shutdownTarget` stays the harness's own, so `mockShutdownTargetRuntime` counts the stop the
    // platform was actually asked to perform.
    const finalizeAsks: Array<Readonly<{ shutdownTarget: boolean; retainRunner: boolean }>> = [];
    const loader: LifecycleOperationsLoader = async (device, signal, shutdownTarget) => {
      const operations = await applicationLifecycleRuntimeFixture(device, signal, shutdownTarget);
      const finalizeApplicationClose = operations.finalizeApplicationClose;
      return Object.freeze({
        ...operations,
        openApplication: async (input) => {
          command.beforeAppOpen?.();
          return await operations.openApplication(input);
        },
        finalizeApplicationClose: async (input) => {
          finalizeAsks.push({
            shutdownTarget: input.shutdownTarget === true,
            retainRunner: input.retainRunner === true,
          });
          command.beforeFinalization?.();
          if (input.verifyAndroidShutdown) {
            const result = await input.verifyAndroidShutdown();
            if (result !== 'same') return { androidShutdownRetained: result };
          }
          return await finalizeApplicationClose(input);
        },
      });
    };
    const response = await handleSessionCommands({
      host: createTestHostEnvironment({ env }),
      createCommandSurface: fakeCreateCommandSurface,
      platformServices,
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

  function sessionClaim() {
    const claim = inspectDeviceClaims({ serial: BOOTED_EMULATOR.id }, env)[0]?.claim;
    if (!claim) throw new Error('expected the session to hold its claim');
    return claim;
  }

  /** Claims on disk for this case's device, which a successful close releases with the session. */
  function sessionClaimCount() {
    return inspectDeviceClaims({ serial: BOOTED_EMULATOR.id }, env).length;
  }

  /**
   * Leaves a claim on disk for this device, taken by the same session name, workspace and daemon.
   * That is the shape a session inherits when a previous one ended without clearing its claim, and
   * the acquisition that follows renews that claim rather than taking a new one.
   */
  async function plantPriorClaim() {
    const acquired = await acquireDeviceClaim({
      device: BOOTED_EMULATOR,
      session: SESSION,
      workspace: process.cwd(),
      stateDir: sessionStore.resolveDaemonStateDir(),
      env,
      reconcileOrphanedDeviceClaim: async () => ({ status: 'reconciled' as const }),
    });
    if (acquired.status !== 'acquired') throw new Error('expected to plant a prior claim');
  }

  return {
    boot,
    generation,
    generationAsks: () => generationAsks,
    /** Asks the boot-observation service answered, so a case can prove the device was not probed. */
    bootAsks: () => bootAsks,
    dropSessionClaim: async () => {
      const ownership = sessionStore.get(SESSION)?.deviceClaim;
      if (!ownership) throw new Error('expected the session to record its claim');
      await clearDeviceClaim(ownership, env);
    },
    plantPriorClaim,
    run,
    sessionClaim,
    sessionClaimCount,
    sessionStore,
  };
}

/**
 * Opens a stopped AVD through the cold route and leaves the emulator running on the boot this
 * session caused. The clock stays fake so a case can name a later boot instead of waiting one out.
 */
async function openBootedByThisSession(
  runs: ReturnType<typeof createRoutedSession>,
  beforeAppOpen?: () => void,
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CLOCK_START_MS);
  const opened = await runs.run({
    name: 'open',
    flags: { platform: 'android' },
    selectsDevice: true,
    beforeAppOpen,
  });
  expect(opened.response?.ok).toBe(true);
  const session = runs.sessionStore.get(SESSION);
  // The boot fact and the launch identity of the boot it describes are written together, and that
  // pair is the only thing close may compare against the running emulator.
  expect(session?.bootedByOpen).toBe(true);
  expect(session?.androidLaunchIdentity).toEqual(OWN_GENERATION);
  return CLOCK_START_MS;
}

function closeWarningMessages(response: { ok?: unknown; data?: unknown }): unknown {
  if (!response.ok) throw new Error('expected a successful close');
  return (response.data as { warnings?: string[] }).warnings;
}

beforeEach(() => {
  mockEnsureReadyRuntime.mockReset();
  mockEnsureReadyRuntime.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

test('plain close leaves an emulator rebooted outside the session running and says why', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  // An outside actor restarts the emulator between two session commands. A reopen then proves the
  // session cannot recover the boot fact from what it owns: the reopen boots nothing, and its own
  // claim renewal vouches for the running device, so only the observed boot separates the boots.
  vi.advanceTimersByTime(LATER_BOOT_DELAY_MS);
  runs.boot.current = REBOOTED;
  const ref = runs.sessionStore.lookup(SESSION);
  expect(ref).toBeDefined();
  runs.sessionStore.updateOpenDevice(ref!, { ...BOOTED_EMULATOR, booted: false }, false);
  const reopened = await runs.run({ name: 'open', flags: { platform: 'android' } });
  expect(reopened.response?.ok).toBe(true);
  expect(mockEnsureReadyRuntime).toHaveBeenCalledTimes(1);
  expect(runs.sessionClaim().updatedAtMs).toBeGreaterThanOrEqual(LATER_BOOT_MS);
  // The reopen claims the running device as its own, yet keeps the launch identity of the boot it
  // caused. That is what separates this session's boot from the outside one, and no claim timestamp
  // can do it: renewal restamps `updatedAtMs` to vouch for the reboot, and `createdAtMs` can
  // predate either.
  expect(runs.sessionStore.get(SESSION)?.androidLaunchIdentity).toEqual(OWN_GENERATION);
  // Open and reopen settle their claims from the record alone, so neither has probed the device.
  expect(runs.bootAsks()).toBe(0);

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: false, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([
    "This session's open booted this device, but its emulator process has changed, so close did not request a stop. The device is still running.",
  ]);
  if (closed.response?.ok) expect(closed.response.data).not.toHaveProperty('shutdown');
  // Close asks the device once, and only once: the implicit stop's own decision.
  expect(runs.generationAsks()).toBe(1);
}, 30_000);

test('plain close leaves an emulator rebooted outside the session running without any reopen', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  runs.boot.current = REBOOTED;
  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: false, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toHaveLength(1);
}, 30_000);

test('plain close keeps a reboot that raced the first application launch', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs, () => {
    vi.advanceTimersByTime(LATER_BOOT_DELAY_MS);
    runs.boot.current = REBOOTED;
  });

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks[0]?.shutdownTarget).toBe(false);
  expect(closeWarningMessages(closed.response!)).toHaveLength(1);
});

test('plain close stops the emulator this session booted while it still runs that boot', async () => {
  const runs = createRoutedSession();
  const ownBootMs = await openBootedByThisSession(runs);
  expect(ownBootMs).toBe(CLOCK_START_MS);

  // Same case except the boot the device reports: the one this session caused.
  runs.boot.current = { observed: true, bootedAtMs: ownBootMs };
  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: true, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
}, 30_000);

test('plain close retains the emulator when its host generation is unavailable', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);

  runs.generation.current = undefined;
  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: false, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toHaveLength(1);
}, 30_000);

test('plain close stops the emulator its own open booted even when the claim long predates that boot', async () => {
  const runs = createRoutedSession();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CLOCK_START_MS);
  // A previous session of this same name, workspace and daemon left its claim behind, so this
  // session's open renews that claim instead of taking a new one. Its creation time belongs to the
  // earlier session and describes nothing about the boot about to happen.
  await runs.plantPriorClaim();
  vi.advanceTimersByTime(PRIOR_CLAIM_GAP_MS);

  const ownBootMs = CLOCK_START_MS + PRIOR_CLAIM_GAP_MS;
  const opened = await runs.run({
    name: 'open',
    flags: { platform: 'android' },
    selectsDevice: true,
  });
  expect(opened.response?.ok).toBe(true);
  expect(runs.sessionStore.get(SESSION)?.bootedByOpen).toBe(true);
  expect(runs.sessionClaim().createdAtMs).toBe(CLOCK_START_MS);

  // The emulator reports the boot THIS open caused, which is what an uptime probe answers.
  runs.boot.current = { observed: true, bootedAtMs: ownBootMs };
  const closed = await runs.run({ name: 'close' });

  // The session still owns the boot the device is running, so it still owes the stop.
  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: true, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
}, 30_000);

test('close --shutdown stops a rebooted emulator and asks the device nothing', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  runs.boot.current = REBOOTED;
  const asksAfterOpen = runs.generationAsks();

  const closed = await runs.run({ name: 'close', flags: { shutdown: true } });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: true, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(runs.generationAsks()).toBe(asksAfterOpen);
  expect(closeWarningMessages(closed.response!)).toBeUndefined();
}, 30_000);

test('a failed generation probe keeps the emulator running', async () => {
  const runs = createRoutedSession((device) =>
    Promise.reject(new Error(`adb is gone: ${device.id}`)),
  );
  await openBootedByThisSession(runs);

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: false, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toHaveLength(1);
}, 30_000);

test('close reaches no device or session step when it asks the boot observation', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  runs.boot.current = REBOOTED;

  const closed = await runs.run({ name: 'close' });

  // The probe is the close's first step and the only one it adds: the lifecycle ask sees the
  // decision it produced, and the session is retired as any successful close retires it.
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: false, retainRunner: false }]);
  expect(runs.generationAsks()).toBe(1);
  expect(runs.sessionStore.get(SESSION)).toBeUndefined();
  expect(runs.sessionClaimCount()).toBe(0);
}, 30_000);

test('a policy refusal stays the reported reason when the emulator was rebooted as well', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  runs.boot.current = REBOOTED;
  const asksBeforeClose = runs.generationAsks();

  const closed = await runs.run({ name: 'close', deviceShutdownDenied: true });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: false, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([
    "This session's open booted this device and close would stop it, but this daemon's policy denies device-shutdown. The device is still running.",
  ]);
  expect(runs.generationAsks()).toBe(asksBeforeClose);
}, 30_000);

test('a lost claim stays the reported reason when the emulator was rebooted as well', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  runs.boot.current = REBOOTED;
  await runs.dropSessionClaim();
  const asksBeforeClose = runs.generationAsks();

  const closed = await runs.run({ name: 'close' });

  expect(closed.response?.ok).toBe(true);
  expect(closed.finalizeAsks).toEqual([{ shutdownTarget: false, retainRunner: false }]);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toEqual([
    "This session's open booted this device, but close could not verify its device claim and did not request a stop.",
  ]);
  // Losing the claim settles the stop without reaching the device, so the reboot adds nothing.
  expect(runs.generationAsks()).toBe(asksBeforeClose);
}, 30_000);

test('Quick Boot retains the replacement with the same serial and restored guest uptime', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  runs.boot.current = { observed: true, bootedAtMs: CLOCK_START_MS - 80_000 };
  runs.generation.current = NEXT_GENERATION;
  const closed = await runs.run({ name: 'close' });
  expect(closed.finalizeAsks[0]?.shutdownTarget).toBe(false);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(closeWarningMessages(closed.response!)).toHaveLength(1);
});

test('missing launch identity does not acquire ownership from a later observation', async () => {
  const runs = createRoutedSession();
  const opened = await runs.run({
    name: 'open',
    flags: { platform: 'android' },
    selectsDevice: true,
    omitLaunchIdentity: true,
  });
  expect(opened.response?.ok).toBe(true);
  const closed = await runs.run({ name: 'close' });
  expect(closed.finalizeAsks[0]?.shutdownTarget).toBe(false);
  expect(runs.generationAsks()).toBe(0);
  expect(closeWarningMessages(closed.response!)).toEqual([
    "This session's open booted this device, but open recorded no emulator process identity, so close did not request a stop and left the device as it found it.",
  ]);
});

test('changing the device serial clears launch ownership', async () => {
  const runs = createRoutedSession();
  await openBootedByThisSession(runs);
  const ref = runs.sessionStore.lookup(SESSION)!;
  runs.sessionStore.updateOpenDevice(ref, { ...BOOTED_EMULATOR, id: 'emulator-5556' }, false);
  expect(runs.sessionStore.get(SESSION)?.androidLaunchIdentity).toBeUndefined();
  expect(runs.sessionStore.get(SESSION)?.bootedByOpen).toBeUndefined();
});

test.each(['changed', 'unobserved'] as const)(
  'close reports %s when generation changes during cleanup',
  async (outcome) => {
    const runs = createRoutedSession();
    await openBootedByThisSession(runs);
    const closed = await runs.run({
      name: 'close',
      beforeFinalization: () => {
        runs.generation.current = outcome === 'changed' ? NEXT_GENERATION : undefined;
      },
    });
    expect(closed.response?.ok).toBe(true);
    expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
    expect(closeWarningMessages(closed.response!)).toEqual([
      outcome === 'changed'
        ? "This session's open booted this device, but its emulator process has changed, so close did not request a stop. The device is still running."
        : "This session's open booted this device, but close could not verify its emulator process identity, so it did not request a stop and left the device as it found it.",
    ]);
    if (closed.response?.ok) expect(closed.response.data).not.toHaveProperty('shutdown');
  },
);
