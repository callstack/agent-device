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
 * it stop?" without naming a platform or a process tool. The caller passes the recorded launch
 * identity (its pid and start time) through unchanged.
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

  /**
   * Stops the launch the caller caused, without asking the device to shut down first. A caller that
   * never published a session has no device to ask, so this addresses only the process the host
   * itself started: a launch the host does not record gets no signal and answers
   * `unconfirmed`, and one the recorded start time no longer names gets no signal and answers
   * `stopped`, because the process the host launched is gone. A host that refuses the stop itself reports an
   * error, which a caller treats the same way: the launch must be assumed to be running. A device
   * whose owner launches no host process answers `stopped`, because nothing of the caller's own is
   * left running.
   */
  stopLaunchedDeviceProcess(
    device: DeviceInfo,
    identity: AndroidEmulatorLaunchIdentity,
  ): Promise<LaunchedProcessStopConfirmation>;
}>;

/**
 * What the boot step of an `open` reports about its OWN call. Boot ownership needs positive proof, so
 * an owner that started the boot reports `performed: true`, and an owner that found the device already
 * up reports that too — `already-booted` is the tool's own answer for a device that was up before the
 * call, `no-boot-attempt` is the answer when readiness settled the device without reaching a boot. An
 * owner whose readiness step reports nothing leaves the port unset rather than guessing.
 */
export type DeviceBootPerformance =
  | Readonly<{ performed: true }>
  | Readonly<{ performed: false; reason: 'already-booted' | 'no-boot-attempt' }>;

/**
 * The warning token plain `close` publishes when the platform answered its own boot step with "this
 * call did not boot the device", so the session has no boot of its own to stop and whatever is running
 * belongs to somebody else. Callers read a member; none writes a literal.
 */
export const CLOSE_BOOT_OWNER_UNVERIFIED_REASONS = {
  bootOwnerUnverified: 'boot-owner-unverified',
} as const satisfies Record<string, string>;

/**
 * The `details.failedOpenEmulatorCleanupReason` values a failed open publishes, from the owner of
 * this outcome. Callers read a member; none writes a literal.
 */
export const FAILED_OPEN_KEPT_RUNNING_REASONS = {
  daemonPolicyDenied: 'daemon-policy-denied',
  noProcessIdentity: 'no-process-identity',
  deviceInUse: 'device-in-use',
} as const satisfies Record<string, string>;

type FailedOpenKeptRunningReason =
  (typeof FAILED_OPEN_KEPT_RUNNING_REASONS)[keyof typeof FAILED_OPEN_KEPT_RUNNING_REASONS];

/**
 * What happened to the device process an `open` launched when that open published no session, and so
 * claimed nothing to stop it later. `stopped` confirms the process is gone; `kept_running` names why
 * nothing was signaled: the daemon's policy denies `device-shutdown`, the launch recorded no process
 * identity to signal, or another session or claim holds the booted device and this open must not stop
 * what that owner is using; `not_confirmed` means the stop was made but the process was still running
 * when the budget ended, or the host refused to answer for the stop at all.
 */
export type FailedOpenLaunchCleanup =
  | Readonly<{ outcome: 'stopped' }>
  | Readonly<{
      outcome: 'kept_running';
      reason: FailedOpenKeptRunningReason;
    }>
  | Readonly<{ outcome: 'not_confirmed' }>;

/** The `details` entries for one launch cleanup, so every report of it agrees. */
export function failedOpenLaunchCleanupDetails(cleanup: FailedOpenLaunchCleanup): Readonly<{
  failedOpenEmulatorCleanup: FailedOpenLaunchCleanup['outcome'];
  failedOpenEmulatorCleanupReason?: FailedOpenKeptRunningReason;
}> {
  return cleanup.outcome === 'kept_running'
    ? {
        failedOpenEmulatorCleanup: cleanup.outcome,
        failedOpenEmulatorCleanupReason: cleanup.reason,
      }
    : { failedOpenEmulatorCleanup: cleanup.outcome };
}
