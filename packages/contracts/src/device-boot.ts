import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidEmulatorLaunchIdentity } from './device-readiness-runtime.ts';

/**
 * Why a device owner could not name the start of its current boot. `unobserved` covers every
 * answer that establishes nothing — the device is not running, the tool call failed, or its
 * output was unreadable — and keeps the caller's decision binary.
 */
export type DeviceBootObservationFailure = 'unsupported-device' | 'unobserved';

export type DeviceBootObservation =
  | Readonly<{ observed: true; bootedAtMs: number }>
  | Readonly<{ observed: false; reason: DeviceBootObservationFailure }>;

/**
 * When a device's CURRENT boot began, as a host-clock epoch in milliseconds. Owners answer for the
 * device kinds they can actually observe and report `unsupported-device` for every other leaf, so a
 * caller never has to know which family answered.
 *
 * A probe answers a question a caller cannot answer from its own state, so its budget must stay far
 * below the operation it precedes, and an unanswered probe must leave that operation as cautious as
 * it was before the probe existed.
 */
export type DeviceBootObservationService = Readonly<{
  observeBootTimeMs(device: DeviceInfo): Promise<DeviceBootObservation>;
}>;

/**
 * What the host says about the process that launched a device, read once immediately before a stop
 * is asked for. `same` is the only answer that lets the stop proceed: `changed` is positive evidence
 * that the recorded process is gone, so whoever answers the device address now is not the launch the
 * caller caused, and `unverified` establishes nothing — the host refused to answer for the recorded
 * process, or the caller recorded none. `not-applicable` is the answer for a device whose owner
 * launches no host process, so the caller never has to know which owner answered.
 */
export type LaunchedProcessCheck = 'not-applicable' | 'same' | 'changed' | 'unverified';

/**
 * Whether the process behind a launch took the shutdown asked of the device. `stopped` covers the
 * process that exited on its own and the one that had to be stopped by pid; `unconfirmed` means it
 * still runs after every stop the host was allowed to make.
 */
export type LaunchedProcessStopConfirmation = 'stopped' | 'unconfirmed';

/**
 * The host half of a device boot: the one process this machine started to bring the device up.
 * Owners answer for the device kinds that launch a host process and report `not-applicable` for
 * every other leaf, so neutral orchestration can ask "is this still the launch I caused?" and "did
 * it stop?" without naming a platform, a pid, or a process tool.
 *
 * Both members are bounded probes on the caller's decision path, so each stays well below the
 * operation it precedes, and an unanswered probe leaves that operation as cautious as it was before
 * the probe existed.
 */
export type LaunchedDeviceProcessService = Readonly<{
  checkLaunchedProcess(
    device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity | undefined,
  ): Promise<LaunchedProcessCheck>;
  confirmLaunchedProcessStopped(
    device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity,
  ): Promise<LaunchedProcessStopConfirmation>;
}>;
