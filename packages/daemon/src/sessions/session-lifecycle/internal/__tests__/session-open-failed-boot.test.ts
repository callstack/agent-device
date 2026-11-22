// #4764: an `open` that boots a stopped AVD and then ends with no published session must not leave
// the emulator it launched running — no later `close` can ever learn this open booted it. Routed
// through the session command handler, so selection, readiness, claim acquisition and session
// publication all run for real. What the host says about the launched process is answered by the
// launched-process owner fixture, exactly as the composed owner answers it; the process reads behind
// each answer are pinned in the Android and composition lanes.
import { beforeEach, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as hostProcess from '@agent-device/host-kit/process';
import { acquireProcessLock, inspectProcessLock } from '@agent-device/host-kit/file';
import { Deadline, pollUntilSettled } from '@agent-device/host-kit/retry';
import type { ProcessLockInspection } from '@agent-device/host-kit/file';
import {
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
  pinOwnProcessStartTime,
  publishDaemonRegistration,
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

const { emitDiagnostic } = vi.hoisted(() => ({ emitDiagnostic: vi.fn() }));
vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic };
});

import {
  launchedProcessOwnerAnswers as owner,
  resetLaunchedProcessOwnerAnswers,
} from '../../../../__tests__/support/launched-process-owner-fixture.ts';

import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import type { OpenApplicationOutcome } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  handleSessionCommands,
  mockEnsureReadyRuntime,
} from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { SessionStore } from '../../../../core/session-store.ts';
import {
  openSeesDeviceHeldByOtherUnderClaimLock,
  withFailedOpenLaunchCleanup,
} from '../session-open-launch-cleanup.ts';
import { makeSession } from '../../../../__tests__/support/session-factories.ts';
import { canonicalLocalDeviceKey } from '@agent-device/daemon-contracts/device-claims';
import { deviceIdentity } from '@agent-device/kernel/device';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';

pinOwnProcessStartTime(hostProcess);
bindTestCommandHost();

const SESSION = 'failed-open-session';

/** The identity readiness reports for the emulator process this open launched. */
const LAUNCH_IDENTITY = { pid: 4112, startTime: 'launch-start-time' } as const;

/** The AVD as inventory lists it while stopped: addressed by its AVD name, not booted. */
const STOPPED_AVD: DeviceInfo = {
  platform: 'android',
  id: 'pixel-avd',
  name: 'Pixel_9_API_37',
  kind: 'emulator',
  booted: false,
};

/** The same emulator once it runs. */
const BOOTED_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel_9_API_37',
  kind: 'emulator',
  booted: true,
};

const REQUEST_ID = 'failed-open-request';

/**
 * Opens the stopped AVD through the cold route, with the launch reported as the host answered for
 * it, and lets the caller decide what the open's own steps do. `omitLaunchIdentity` stands for a
 * launch whose start time could not be read; `prebooted` stands for a device readiness found running,
 * which reports no launch at all.
 */
async function runColdOpen(params: {
  sessionStore: SessionStore;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  /** How the open's own steps end once the boot is done. */
  afterBoot?: () => Promise<OpenApplicationOutcome>;
  /** The lifecycle hook that runs after the session is published but before it is dispatched. */
  beforeDispatch?: () => Promise<DaemonResponse | undefined>;
  omitLaunchIdentity?: boolean;
  prebooted?: boolean;
  deviceShutdownDenied?: boolean;
}) {
  const { sessionStore, env, stateDir } = params;
  vi.mocked(resolveTargetDevice).mockResolvedValue(STOPPED_AVD);
  mockEnsureReadyRuntime.mockImplementation(async (input) => {
    if (!params.prebooted) {
      input.onAndroidEmulatorLaunch?.(params.omitLaunchIdentity ? undefined : LAUNCH_IDENTITY);
    }
    return BOOTED_EMULATOR;
  });
  const response = await handleSessionCommands({
    host: createTestHostEnvironment({ env }),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
    lifecycleOperationsLoader: async (device, signal, shutdownTarget) => {
      const { applicationLifecycleRuntimeFixture } =
        await import('../../../../__tests__/support/application-lifecycle-runtime-fixture.ts');
      const operations = await applicationLifecycleRuntimeFixture(device, signal, shutdownTarget);
      return Object.freeze({
        ...operations,
        openApplication: async () => (params.afterBoot ? await params.afterBoot() : { timing: {} }),
      });
    },
    req: {
      token: 't',
      command: 'open',
      session: SESSION,
      positionals: ['Demo'],
      flags: { platform: 'android' },
      meta: { requestId: REQUEST_ID },
      ...(params.beforeDispatch
        ? {
            internal: {
              openLifecycle: { beforeDispatch: params.beforeDispatch },
            },
          }
        : {}),
    },
    sessionName: SESSION,
    logPath: path.join(stateDir, 'daemon.log'),
    ...(params.deviceShutdownDenied === undefined
      ? {}
      : { deviceShutdownDenied: params.deviceShutdownDenied }),
  });
  return response;
}

function createRoutedSession() {
  const stateDir = mkdtempForTestSync('agent-device-failed-open-launch-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims'),
  };
  const sessionStore = new SessionStore(path.join(stateDir, 'sessions'), {
    env,
    cwd: process.cwd(),
  });
  return {
    runColdOpen: (
      params: Omit<Parameters<typeof runColdOpen>[0], 'sessionStore' | 'env' | 'stateDir'>,
    ) => runColdOpen({ ...params, sessionStore, env, stateDir }),
    seedForeignLiveClaim: (device: DeviceInfo) => seedForeignLiveClaim(env, device),
    claimsDir: env.AGENT_DEVICE_CLAIMS_DIR!,
    sessionStore,
  };
}

/** The error message a cold open's own step fails with, which must stay the reported failure. */
const STEP_FAILURE = 'pm list features timed out';

/**
 * What a failed open reported, whichever way it failed: the thrown error when the open's own step
 * throws, or the returned error when the open comes back with a failure.
 */
async function failureOf(
  open: Promise<Awaited<ReturnType<typeof runColdOpen>>>,
): Promise<{ message: string; details: Record<string, unknown> }> {
  try {
    const response = await open;
    if (!response || response.ok) throw new Error('expected the open to fail');
    return { message: response.error.message, details: response.error.details ?? {} };
  } catch (error) {
    if (error instanceof AppError)
      return { message: error.message, details: (error.details ?? {}) as Record<string, unknown> };
    throw error;
  }
}

function launchMissSteps(): unknown[] {
  return emitDiagnostic.mock.calls
    .map(([diagnostic]) => diagnostic)
    .filter((diagnostic) => diagnostic?.phase === 'launch_process_identity_miss')
    .map((diagnostic) => (diagnostic.data as { step?: unknown }).step);
}

beforeEach(() => {
  mockEnsureReadyRuntime.mockReset();
  mockEnsureReadyRuntime.mockResolvedValue(undefined);
  emitDiagnostic.mockClear();
  resetLaunchedProcessOwnerAnswers();
});

test('a cold open hands readiness the answer for who holds the device it is booting', async () => {
  const runs = createRoutedSession();
  // The boot runs before any session or claim of this open exists, so the only owner readiness can
  // hear about is somebody else's (#4867).
  runs.sessionStore.publish(
    'other-holder',
    makeSession('other-holder', { device: BOOTED_EMULATOR }),
  );

  await runs.runColdOpen({});

  const input = mockEnsureReadyRuntime.mock.calls[0]?.[0];
  await expect(input?.isAndroidEmulatorHeldByOther?.(BOOTED_EMULATOR)).resolves.toBe(true);
  // A serial nobody holds is the other answer, so the stop is not blocked at large. A boot that never
  // resolved a serial is never asked about: sessions and claims are keyed under the serial, so an AVD
  // name could only ever answer "not held". Readiness keeps that launch itself, and the readiness suite
  // pins that answer (#4867).
  await expect(
    input?.isAndroidEmulatorHeldByOther?.({ ...BOOTED_EMULATOR, id: 'emulator-5556' }),
  ).resolves.toBe(false);
});

test('a claim being written for a booting device answers as ownership', async () => {
  const runs = createRoutedSession();
  // Somebody is recording a claim for this device right now, which is the same answer a claim that
  // refuses this open gives; a boot may not stop the emulator that claim is for. The whole open would
  // wait behind this lock for its own claim, so the readiness question is asked directly.
  const release = await acquireProcessLock({
    lockDirPath: deviceClaimLockPath(runs.claimsDir, BOOTED_EMULATOR),
    owner: { pid: process.ppid, startTime: null, acquiredAtMs: Date.now() },
    timeoutMs: 5_000,
    description: 'test-held device claim lock',
  });

  try {
    await expect(
      openSeesDeviceHeldByOtherUnderClaimLock({
        sessionStore: runs.sessionStore,
        sessionName: SESSION,
        workspace: process.cwd(),
        device: BOOTED_EMULATOR,
      }),
    ).resolves.toBe(true);
  } finally {
    await release();
  }

  await expect(
    openSeesDeviceHeldByOtherUnderClaimLock({
      sessionStore: runs.sessionStore,
      sessionName: SESSION,
      workspace: process.cwd(),
      device: BOOTED_EMULATOR,
    }),
  ).resolves.toBe(false);
});

test('a cold open whose later step fails stops the emulator it launched and keeps its own error', async () => {
  const runs = createRoutedSession();

  const failure = await failureOf(
    runs.runColdOpen({
      afterBoot: async () => {
        throw new AppError('COMMAND_FAILED', STEP_FAILURE, { reason: 'probe-timeout' });
      },
    }),
  );

  // The open's own failure is what the caller hears, with this open's cleanup reported beside it.
  expect(failure).toEqual({
    message: STEP_FAILURE,
    details: { reason: 'probe-timeout', failedOpenEmulatorCleanup: 'stopped' },
  });
  expect(owner.stops).toEqual([LAUNCH_IDENTITY]);
  // Nothing about this launch was uncertain, so the open says nothing else about the process.
  expect(launchMissSteps()).toEqual([]);
  expect(runs.sessionStore.get(SESSION)).toBeUndefined();
});

test('a cold open the daemon policy keeps from stopping its launch reports why on its error', async () => {
  const runs = createRoutedSession();

  const failure = await failureOf(
    runs.runColdOpen({
      deviceShutdownDenied: true,
      afterBoot: async () => {
        throw new AppError('COMMAND_FAILED', STEP_FAILURE);
      },
    }),
  );

  expect(failure.message).toBe(STEP_FAILURE);
  expect(failure.details).toEqual({
    failedOpenEmulatorCleanup: 'kept_running',
    failedOpenEmulatorCleanupReason: 'daemon-policy-denied',
  });
  // The policy is decided before the host is ever asked, and the kept device is named once.
  expect(owner.stops).toEqual([]);
  expect(launchMissSteps()).toEqual(['open-kept-by-daemon-policy']);
});

test('a cold open that launched an emulator it cannot name leaves it running and says so', async () => {
  const runs = createRoutedSession();

  const failure = await failureOf(
    runs.runColdOpen({
      omitLaunchIdentity: true,
      afterBoot: async () => {
        throw new AppError('COMMAND_FAILED', STEP_FAILURE);
      },
    }),
  );

  expect(failure.message).toBe(STEP_FAILURE);
  expect(failure.details).toEqual({
    failedOpenEmulatorCleanup: 'kept_running',
    failedOpenEmulatorCleanupReason: 'no-process-identity',
  });
  // No identity means no signal: this open never probes the process table for a likely emulator.
  expect(owner.stops).toEqual([]);
  expect(launchMissSteps()).toEqual(['open-recorded-no-process']);
});

test('a cold open that published a session without a launch identity leaves that boot to the session', async () => {
  const runs = createRoutedSession();

  // The unreadable-identity launch is still recorded as the session's boot once the session is
  // published, so the failed dispatch is the session's to settle on close, not an unowned launch.
  const response = await runs.runColdOpen({
    omitLaunchIdentity: true,
    beforeDispatch: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'Recording rejected' },
    }),
  });

  expect(response).toMatchObject({ ok: false, error: { message: 'Recording rejected' } });
  expect(response?.ok === false ? (response.error.details ?? {}) : {}).not.toHaveProperty(
    'failedOpenEmulatorCleanup',
  );
  expect(owner.stops).toEqual([]);
  expect(launchMissSteps()).toEqual([]);
  expect(runs.sessionStore.get(SESSION)?.bootedByOpen).toBe(true);
});

test('a cold open canceled after its launch stops the emulator and reports the cancellation', async () => {
  const runs = createRoutedSession();
  const registration = registerRequestAbort(REQUEST_ID);
  try {
    const response = await runs.runColdOpen({
      afterBoot: async () => {
        markRequestCanceled(REQUEST_ID);
        return { timing: {} };
      },
    });

    // A cancellation is reported as the returned error, so the cleanup rides on that one.
    expect(response).toMatchObject({
      ok: false,
      error: { details: { failedOpenEmulatorCleanup: 'stopped' } },
    });
    expect(owner.stops).toEqual([LAUNCH_IDENTITY]);
    expect(runs.sessionStore.get(SESSION)).toBeUndefined();
  } finally {
    clearRequestAbortRegistration(registration);
  }
});

test('a cold open of an emulator that was already running stops nothing', async () => {
  const runs = createRoutedSession();

  const failure = await failureOf(
    runs.runColdOpen({
      prebooted: true,
      afterBoot: async () => {
        throw new AppError('COMMAND_FAILED', STEP_FAILURE);
      },
    }),
  );

  // This open started no device process, so it reports no cleanup and stops nothing.
  expect(failure.details).not.toHaveProperty('failedOpenEmulatorCleanup');
  expect(owner.stops).toEqual([]);
  expect(launchMissSteps()).toEqual([]);
});

test('a cold open that failed with the booted device already taken by another session keeps it running', async () => {
  const runs = createRoutedSession();
  // Open B took the booted serial while this open was still working: the conflict refusal must
  // not turn into a stop of the emulator B is now using (#4764 review).
  runs.sessionStore.publish(
    'other-holder',
    makeSession('other-holder', { device: BOOTED_EMULATOR }),
  );

  const response = await runs.runColdOpen({});

  expect(response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(response?.ok === false ? response.error.details : {}).toMatchObject({
    session: 'other-holder',
    failedOpenEmulatorCleanup: 'kept_running',
    failedOpenEmulatorCleanupReason: 'device-in-use',
  });
  expect(owner.stops).toEqual([]);
  expect(launchMissSteps()).toEqual(['open-kept-device-in-use']);
});

test("a cold open that failed against another session's live claim keeps it running", async () => {
  const runs = createRoutedSession();
  // A claim from another workspace whose owner process is alive is the other route to "somebody
  // else holds this device": acquisition refuses with DEVICE_IN_USE, and the launch stays.
  runs.seedForeignLiveClaim(BOOTED_EMULATOR);

  const response = await runs.runColdOpen({});

  expect(response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(response?.ok === false ? response.error.details : {}).toMatchObject({
    reason: 'DEVICE_CLAIM_LIVE_OWNER',
    failedOpenEmulatorCleanup: 'kept_running',
    failedOpenEmulatorCleanupReason: 'device-in-use',
  });
  expect(owner.stops).toEqual([]);
  expect(launchMissSteps()).toEqual(['open-kept-device-in-use']);
});

test('a cold open stops its launch only while it holds the device claim lock', async () => {
  const runs = createRoutedSession();
  let lockDuringStop: ProcessLockInspection | undefined;
  let finishStop: () => void = () => undefined;
  const stopHeld = new Promise<void>((resolve) => {
    finishStop = resolve;
  });

  owner.onStop = async () => {
    // Read from inside the stop: the device's claim lock — the one `acquireDeviceClaim` writes a
    // claim under — names this process, so no owner can be recorded for the device meanwhile.
    lockDuringStop = inspectProcessLock(deviceClaimLockPath(runs.claimsDir, BOOTED_EMULATOR));
    await stopHeld;
  };

  const settled = failureOf(
    runs.runColdOpen({
      afterBoot: async () => {
        throw new AppError('COMMAND_FAILED', STEP_FAILURE);
      },
    }),
  );

  // Waits for the stop to report what it saw, and releases it right after: no timing assumption.
  await pollUntilSettled({
    probe: async () => lockDuringStop,
    settled: (inspection) => inspection !== undefined,
    deadline: Deadline.fromTimeoutMs(5_000),
    intervalMs: 10,
  });
  expect(lockDuringStop?.state).toBe('held');
  expect(lockDuringStop?.state === 'held' ? lockDuringStop.owner.pid : undefined).toBe(process.pid);

  finishStop();
  const failure = await settled;

  expect(failure.message).toBe(STEP_FAILURE);
  expect(failure.details.failedOpenEmulatorCleanup).toBe('stopped');
  expect(owner.stops).toEqual([LAUNCH_IDENTITY]);
  // Released with the stop: a cleanup that is over fences no later owner of the device.
  expect(inspectProcessLock(deviceClaimLockPath(runs.claimsDir, BOOTED_EMULATOR)).state).toBe(
    'absent',
  );
});

test('the cleanup keeps the launch when the device claim lock is held by another owner', async () => {
  const runs = createRoutedSession();
  // The lock is held by a live process of another owner, so the cleanup cannot make its re-check
  // safely: it attempts no stop and reports the device as owned. A whole failed open cannot be used
  // here — its own claim would wait behind this lock — so the cleanup owner is asked directly.
  const release = await acquireProcessLock({
    lockDirPath: deviceClaimLockPath(runs.claimsDir, BOOTED_EMULATOR),
    owner: { pid: process.ppid, startTime: null, acquiredAtMs: Date.now() },
    timeoutMs: 5_000,
    description: 'test-held device claim lock',
  });

  const result = await withFailedOpenLaunchCleanup({
    device: BOOTED_EMULATOR,
    launch: { attempted: true, identity: LAUNCH_IDENTITY },
    sessionStore: runs.sessionStore,
    sessionName: SESSION,
    workspace: process.cwd(),
    deviceShutdownDenied: false,
    launchedProcess: daemonPlatformServicesFixture().launchedDeviceProcess,
    run: async () => {
      throw new AppError('COMMAND_FAILED', STEP_FAILURE);
    },
  }).catch((error: unknown) => error);

  await release();

  expect(result).toBeInstanceOf(AppError);
  expect((result as AppError).message).toBe(STEP_FAILURE);
  expect((result as AppError).details).toEqual({
    failedOpenEmulatorCleanup: 'kept_running',
    failedOpenEmulatorCleanupReason: 'device-in-use',
  });
  expect(owner.stops).toEqual([]);
  expect(launchMissSteps()).toEqual(['open-kept-claim-in-flight']);
});

/** The host-global per-device lock `acquireDeviceClaim` writes a claim under, for `device`. */
function deviceClaimLockPath(claimsDir: string, device: DeviceInfo): string {
  const deviceKey = canonicalLocalDeviceKey(deviceIdentity(device));
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  return path.join(claimsDir, `${hash}.json.lock`);
}

/**
 * Writes the claim another daemon's session holds for `device`, owned by a live process of its own
 * (this test process's parent), in the claims dir the case's environment selects.
 */
function seedForeignLiveClaim(env: NodeJS.ProcessEnv, device: DeviceInfo): void {
  const deviceKey = canonicalLocalDeviceKey(deviceIdentity(device));
  const stateDir = mkdtempForTestSync('agent-device-failed-open-foreign-owner-');
  fs.mkdirSync(env.AGENT_DEVICE_CLAIMS_DIR!, { recursive: true });
  fs.writeFileSync(
    path.join(
      env.AGENT_DEVICE_CLAIMS_DIR!,
      `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
    ),
    JSON.stringify({
      schemaVersion: 3,
      deviceKey,
      device: { ...deviceIdentity(device), name: device.name },
      session: 'foreign-holder',
      workspace: '/workspaces/foreign',
      stateDir,
      ownerPid: process.ppid,
      ownerStartTime: null,
      ownerToken: 'foreign-token',
      createdAtMs: 1,
      updatedAtMs: Date.now(),
      claimOwnerKind: 'open-session',
    }),
  );
  publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });
}

test('a successful cold open leaves its boot to the session it published', async () => {
  const runs = createRoutedSession();

  const opened = await runs.runColdOpen({});

  expect(opened?.ok).toBe(true);
  expect(owner.stops).toEqual([]);
  // The session owns this boot, which is exactly what a later close acts on.
  expect(runs.sessionStore.get(SESSION)?.bootedByOpen).toBe(true);
  expect(runs.sessionStore.get(SESSION)?.androidLaunchIdentity).toEqual(LAUNCH_IDENTITY);
});

test('an open that published its session before failing leaves that session to stop the launch', async () => {
  const runs = createRoutedSession();

  // The session is published, and owns this boot, before the open is dispatched. What fails after
  // that is a session's problem to settle on close, not a launch nobody owns.
  const response = await runs.runColdOpen({
    beforeDispatch: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'Recording rejected' },
    }),
  });

  expect(response).toMatchObject({ ok: false, error: { message: 'Recording rejected' } });
  expect(response?.ok === false ? (response.error.details ?? {}) : {}).not.toHaveProperty(
    'failedOpenEmulatorCleanup',
  );
  expect(owner.stops).toEqual([]);
  const session = runs.sessionStore.get(SESSION);
  expect(session?.bootedByOpen).toBe(true);
  expect(session?.androidLaunchIdentity).toEqual(LAUNCH_IDENTITY);
});

test('a cold open whose launch cannot be confirmed stopped still reports its own error', async () => {
  const runs = createRoutedSession();
  owner.stop = 'unconfirmed';

  const failure = await failureOf(
    runs.runColdOpen({
      afterBoot: async () => {
        throw new AppError('COMMAND_FAILED', STEP_FAILURE);
      },
    }),
  );

  expect(failure.message).toBe(STEP_FAILURE);
  expect(failure.details).toEqual({ failedOpenEmulatorCleanup: 'not_confirmed' });
  expect(owner.stops).toEqual([LAUNCH_IDENTITY]);
  expect(launchMissSteps()).toEqual(['launched-process-stop-unconfirmed']);
});

test('a cold open the host refuses to answer for still reports its own error and assumes a running launch', async () => {
  const runs = createRoutedSession();
  owner.stopError = new Error('EIO: i/o error, kill');

  const failure = await failureOf(
    runs.runColdOpen({
      afterBoot: async () => {
        throw new AppError('COMMAND_FAILED', STEP_FAILURE);
      },
    }),
  );

  // A refused stop replaces neither the open's error nor the verdict: an unanswered stop is one
  // the caller must assume is still running.
  expect(failure.message).toBe(STEP_FAILURE);
  expect(failure.details).toEqual({ failedOpenEmulatorCleanup: 'not_confirmed' });
  expect(owner.stops).toEqual([LAUNCH_IDENTITY]);
  expect(launchMissSteps()).toEqual(['launched-process-stop-failed']);
});

test('a cold open that fails with an error carrying no details still records its cleanup', async () => {
  const runs = createRoutedSession();

  // A plain Error is not the daemon's to annotate, so the request record is the only place this
  // open's cleanup can still be read; the error itself reaches the caller unchanged.
  await expect(
    runs.runColdOpen({
      afterBoot: async () => {
        throw new Error(STEP_FAILURE);
      },
    }),
  ).rejects.toThrow(STEP_FAILURE);

  expect(owner.stops).toEqual([LAUNCH_IDENTITY]);
  expect(launchMissSteps()).toEqual(['failed-open-cleanup-report-unclaimed']);
});
