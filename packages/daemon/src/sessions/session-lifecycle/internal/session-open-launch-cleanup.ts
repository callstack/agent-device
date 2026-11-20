import type {
  FailedOpenLaunchCleanup,
  LaunchedDeviceProcessService,
  LaunchedProcessStopConfirmation,
} from '@agent-device/contracts/device-boot';
import { failedOpenLaunchCleanupDetails } from '@agent-device/contracts/device-boot';
import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { processStartTimesDiffer } from '@agent-device/host-kit/process';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { SessionStore } from '../../../core/session-store.ts';
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
 * #4764: an open that launched an emulator and then ended without a session leaves that emulator
 * running with no owner — no later `close` ever learns this open booted it, so nothing stops it.
 * This runs the open's remaining steps and stops the launch when they end with no published session
 * owning it, whether they return a failure, throw, or report the request canceled.
 *
 * The open's own failure stays the reported failure: this only adds the cleanup's result to that
 * error's details. A launch is stopped only when the boot named its process, so an emulator that was
 * already running, and a launch the host could not name, are both left alone.
 */
export async function withFailedOpenLaunchCleanup(params: {
  device: DeviceInfo;
  launch: OpenDeviceLaunch;
  sessionStore: SessionStore;
  sessionName: string;
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
 * owns the boot, or the daemon's policy denies `device-shutdown`. Returns nothing when this open
 * started no device process to report, so an open that never took the boot path stays silent.
 */
async function stopUnownedLaunch(params: {
  device: DeviceInfo;
  launch: OpenDeviceLaunch;
  sessionStore: SessionStore;
  sessionName: string;
  deviceShutdownDenied: boolean;
  launchedProcess: LaunchedDeviceProcessService;
}): Promise<FailedOpenLaunchCleanup | undefined> {
  const { launch, device, launchedProcess } = params;
  if (!launch.attempted) return undefined;
  if (launchHasPublishedSessionOwner(params)) return undefined;
  const identity = launch.identity;
  if (!identity) {
    emitLaunchProcessMiss('open-recorded-no-process', {});
    return { outcome: 'kept_running', reason: 'no-process-identity' };
  }
  if (params.deviceShutdownDenied) {
    emitLaunchProcessMiss('open-kept-by-daemon-policy', { pid: identity.pid });
    return { outcome: 'kept_running', reason: 'daemon-policy-denied' };
  }
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
