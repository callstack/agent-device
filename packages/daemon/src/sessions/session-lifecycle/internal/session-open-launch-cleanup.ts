import type {
  FailedOpenLaunchCleanup,
  LaunchedDeviceProcessService,
  LaunchedProcessStopConfirmation,
} from '@agent-device/contracts/device-boot';
import {
  FAILED_OPEN_KEPT_RUNNING_REASONS,
  failedOpenLaunchCleanupDetails,
} from '@agent-device/contracts/device-boot';
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
import {
  canonicalLocalDeviceKey,
  deviceClaimIdentity,
  inspectDeviceClaimAcquisition,
  withDeviceClaimLockHeld,
} from '@agent-device/daemon-contracts/device-claims';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { processStartTimesDiffer } from '@agent-device/host-kit/process';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { SessionStore } from '../../../core/session-store.ts';
import { findSessionHoldingDevice } from '../../open-device-contention-wait.ts';
import type { SessionOpenResult } from './session-open-execution.ts';

/**
 * What one cold open knows about the device process it may have started. `attempted` says the open
 * took the boot path for a device that was not booted; `identity` names the process that boot
 * reported. The identity is absent both for a device that was already running and for a launch whose
 * start time could not be read, and nothing here may try to tell those apart by looking for a process.
 */
export type OpenDeviceLaunch = Readonly<{
  attempted: boolean;
  identity: AndroidEmulatorLaunchIdentity | undefined;
}>;

/**
 * Runs one cold open's post-boot steps and stops the device process they left running with no owner:
 * a launch this open started, whose process the host named, with no published session owning the
 * boot and no other session or claim holding the device (#4764). The open's own failure stays the
 * reported failure; the cleanup rides its details. The stop costs at most 3 s: TERM, then KILL.
 */
export async function withFailedOpenLaunchCleanup(params: {
  device: DeviceInfo;
  launch: OpenDeviceLaunch;
  sessionStore: SessionStore;
  sessionName: string;
  /** The workspace this open's own claim carries, so a claim it took is not read as foreign. */
  workspace: string;
  deviceShutdownDenied: boolean;
  launchedProcess: LaunchedDeviceProcessService;
  run: () => Promise<SessionOpenResult>;
}): Promise<SessionOpenResult> {
  let result: SessionOpenResult;
  try {
    result = await params.run();
  } catch (error) {
    const cleanup = await stopUnownedLaunch(params);
    if (cleanup) addCleanupToThrownError(error, cleanup);
    throw error;
  }
  if (result.type === 'opened') return result;
  const cleanup = await stopUnownedLaunch(params);
  if (!cleanup) return result;
  return { ...result, response: addCleanupToResponse(result.response, cleanup) };
}

/**
 * Stops this open's launch unless the boot never named a process, the open published a session that
 * owns the boot, another owner holds the device, or the daemon's policy denies `device-shutdown`.
 * Returns nothing when this open started no device process to report, so an open that never took the
 * boot path stays silent.
 *
 * The claim answer the stop depends on and the bounded stop itself run as one exclusion under the
 * device's claim lock — the lock `acquireDeviceClaim` writes a claim under — so no owner can be
 * acquired for the device between "nothing conflicts" and the signal. A lock somebody else holds
 * keeps the launch: a device being claimed right now is not this open's to stop.
 */
async function stopUnownedLaunch(params: {
  device: DeviceInfo;
  launch: OpenDeviceLaunch;
  sessionStore: SessionStore;
  sessionName: string;
  workspace: string;
  deviceShutdownDenied: boolean;
  launchedProcess: LaunchedDeviceProcessService;
}): Promise<FailedOpenLaunchCleanup | undefined> {
  const { launch, device, sessionStore } = params;
  if (!launch.attempted) return undefined;
  if (launchHasPublishedSessionOwner(params)) return undefined;
  const identity = launch.identity;
  // An open that lost the booted device to another owner must leave that owner's emulator running,
  // whatever its own failure was. These ownership answers precede the reasons this open could keep the
  // launch for itself, so a kept launch reports the reason that kept it.
  if (findSessionHoldingDevice(sessionStore, device.id, params.sessionName)) {
    return keepLaunchForDeviceInUse();
  }
  if (await claimHeldByAnotherOwner(params)) {
    return keepLaunchForDeviceInUse();
  }
  if (!identity) {
    emitLaunchProcessMiss('open-recorded-no-process', {});
    return {
      outcome: 'kept_running',
      reason: FAILED_OPEN_KEPT_RUNNING_REASONS.noProcessIdentity,
    };
  }
  if (params.deviceShutdownDenied) {
    emitLaunchProcessMiss('open-kept-by-daemon-policy', { pid: identity.pid });
    return {
      outcome: 'kept_running',
      reason: FAILED_OPEN_KEPT_RUNNING_REASONS.daemonPolicyDenied,
    };
  }
  const settled = await withDeviceClaimLockHeld(
    canonicalLocalDeviceKey(deviceClaimIdentity(device)),
    sessionStore.host.env,
    // The answer above can be stale: a second daemon can clear, then take, this device's claim
    // while this open is deciding. The same question is asked again under the lock that claim
    // writes take, and only its answer lets the stop proceed.
    async () =>
      (await claimHeldByAnotherOwner(params))
        ? keepLaunchForDeviceInUse()
        : await stopLaunch(params, identity),
  );
  if (settled.status === 'ran') return settled.result;
  // A claim is being written for this device right now, which is the same answer a claim that
  // refuses this open gives: the launch belongs to whoever that claim is for.
  emitLaunchProcessMiss('open-kept-claim-in-flight', { pid: identity.pid });
  return {
    outcome: 'kept_running',
    reason: FAILED_OPEN_KEPT_RUNNING_REASONS.deviceInUse,
  };
}

/**
 * Stops the launch under the claim lock, reporting what the host confirmed. The stop is bounded at
 * 3 s (TERM, then KILL), which is what makes it safe to hold the device's claim lock across it.
 */
async function stopLaunch(
  params: { device: DeviceInfo; launchedProcess: LaunchedDeviceProcessService },
  identity: AndroidEmulatorLaunchIdentity,
): Promise<FailedOpenLaunchCleanup> {
  const { device, launchedProcess } = params;
  let confirmation: LaunchedProcessStopConfirmation;
  try {
    confirmation = await launchedProcess.stopLaunchedDeviceProcess(device, identity);
  } catch {
    // The host refused the stop itself rather than answering it. The open's own failure stays the
    // reported failure, and a stop that never completed is one the caller must assume is running.
    emitLaunchProcessMiss('launched-process-stop-failed', { pid: identity.pid });
    return { outcome: 'not_confirmed' };
  }
  if (confirmation === 'unconfirmed')
    emitLaunchProcessMiss('launched-process-stop-unconfirmed', { pid: identity.pid });
  return confirmation === 'stopped' ? { outcome: 'stopped' } : { outcome: 'not_confirmed' };
}

/** The one report for a launch kept because the device has an owner this open must not disturb. */
function keepLaunchForDeviceInUse(): FailedOpenLaunchCleanup {
  emitLaunchProcessMiss('open-kept-device-in-use', {});
  return { outcome: 'kept_running', reason: FAILED_OPEN_KEPT_RUNNING_REASONS.deviceInUse };
}

/**
 * Whether a session published under this address owns the boot, which is what a failed open that got
 * as far as publishing one leaves behind. Ownership means the pair `close` acts on is recorded: the
 * boot fact beside this open's own launch identity. The pair must match whole: a recorded pid whose
 * start time differs from this launch's is a pid that changed hands, not this open's boot.
 */
function launchHasPublishedSessionOwner(params: {
  sessionStore: SessionStore;
  sessionName: string;
  launch: OpenDeviceLaunch;
}): boolean {
  const session = params.sessionStore.get(params.sessionName);
  if (!session || session.bootedByOpen !== true) return false;
  const recorded = session.androidLaunchIdentity;
  if (params.launch.identity === undefined) return recorded === undefined;
  if (recorded?.pid !== params.launch.identity.pid) return false;
  return !processStartTimesDiffer(recorded.startTime, params.launch.identity.startTime);
}

/**
 * Whether the device's claim refuses this open. The answer is the exact decision acquisition makes
 * for this open: the same session and workspace this open would claim under answers `held`, an
 * unsettled foreign owner answers `conflict`. A `reconcile` settlement belongs to acquisition itself
 * and keeps nothing here. The caller asks twice: once here, and once under
 * {@link withDeviceClaimLockHeld} when the answer is about to decide a stop.
 */
async function claimHeldByAnotherOwner(params: {
  sessionStore: SessionStore;
  sessionName: string;
  workspace: string;
  device: DeviceInfo;
}): Promise<boolean> {
  const settlements = await inspectDeviceClaimAcquisition({
    device: params.device,
    command: 'open',
    session: params.sessionName,
    workspace: params.workspace,
    stateDir: params.sessionStore.resolveDaemonStateDir(),
    env: params.sessionStore.host.env,
    coveredClaimIsOwnedByRequest: () => false,
  });
  return settlements.some((settlement) => settlement.status === 'conflict');
}

/** Adds the cleanup result to a failed open's returned error, keeping that error's own fields. */
function addCleanupToResponse(response: DaemonResponse, cleanup: FailedOpenLaunchCleanup) {
  if (response.ok) return response;
  const details = failedOpenLaunchCleanupDetails(cleanup);
  return {
    ...response,
    error: { ...response.error, details: { ...response.error.details, ...details } },
  };
}

/** Adds the cleanup result to a failed open's thrown error, which the caller rethrows unchanged. */
function addCleanupToThrownError(error: unknown, cleanup: FailedOpenLaunchCleanup): void {
  const details = failedOpenLaunchCleanupDetails(cleanup);
  if (error instanceof AppError) {
    error.details = { ...error.details, ...details };
    return;
  }
  // An error the daemon did not produce carries no details bag for the caller, so the request
  // record is the only place this open's cleanup can still be read.
  emitLaunchProcessMiss('failed-open-cleanup-report-unclaimed', details);
}

/**
 * The one diagnostic for an open that could not settle the state of the process its own boot
 * started. `step` names the step that decided it, which is the only thing separating the cases this
 * reports.
 */
function emitLaunchProcessMiss(step: string, data: Record<string, unknown> = {}): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'launch_process_identity_miss',
    data: { step, ...data },
  });
}
