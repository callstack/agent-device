import { asAppError, type ReasonTable } from '@agent-device/kernel/errors';

/**
 * Why a simulator, emulator or XCTest runner failed to start, as {@link classifyBootFailure} and the
 * platform boot paths classify it. `contracts/boot-failure` lists the subset a host or transport
 * change can clear.
 */
export const BOOT_FAILURE_REASONS = {
  // The iOS simulator did not finish booting within its budget.
  iosBootTimeout: { reason: 'IOS_BOOT_TIMEOUT' },
  // The XCTest runner did not accept a connection: xcodebuild exited before it was ready, or the
  // connection timed out, was refused or dropped.
  iosRunnerConnectTimeout: { reason: 'IOS_RUNNER_CONNECT_TIMEOUT' },
  // The XCTest runner for this device is owned by another agent-device daemon, or is still busy
  // after this session's device lease was admitted.
  iosRunnerOwnedByOtherDaemon: { reason: 'IOS_RUNNER_OWNED_BY_OTHER_DAEMON' },
  // Xcode command-line tools are missing or not on PATH.
  iosToolMissing: { reason: 'IOS_TOOL_MISSING' },
  // The Android emulator did not finish booting, or an adb command timed out while it booted.
  androidBootTimeout: { reason: 'ANDROID_BOOT_TIMEOUT' },
  // adb is missing, its host refused the request, or the device is unauthorized.
  adbTransportUnavailable: { reason: 'ADB_TRANSPORT_UNAVAILABLE' },
  // The boot output shows the host ran out of memory or processes, or a boot process was killed, as
  // on an overloaded CI machine.
  ciResourceStarvationSuspected: { reason: 'CI_RESOURCE_STARVATION_SUSPECTED' },
  // The XCTest runner cannot be installed because its provisioning profile does not cover the
  // device. Register the device with the signing team; retrying alone keeps failing.
  iosRunnerDeviceNotProvisioned: { reason: 'IOS_RUNNER_DEVICE_NOT_PROVISIONED' },
  // A boot command failed for another reason, including an iOS signing or profile failure; its
  // stdout and stderr say which.
  bootCommandFailed: { reason: 'BOOT_COMMAND_FAILED' },
  // The boot failed with no output or error to classify.
  unknown: { reason: 'UNKNOWN' },
} as const satisfies ReasonTable<'device boot'>;

export type BootFailureReason =
  (typeof BOOT_FAILURE_REASONS)[keyof typeof BOOT_FAILURE_REASONS]['reason'];

type BootDiagnosticContext = {
  platform?: 'ios';
  phase?: 'boot' | 'connect' | 'transport';
};

// fallow-ignore-next-line complexity
export function classifyBootFailure(input: {
  error?: unknown;
  message?: string;
  stdout?: string;
  stderr?: string;
  context?: BootDiagnosticContext;
}): BootFailureReason {
  const appErr = input.error ? asAppError(input.error) : null;
  const platform = input.context?.platform;
  const phase = input.context?.phase;
  if (appErr?.code === 'TOOL_MISSING') return BOOT_FAILURE_REASONS.iosToolMissing.reason;
  const details = (appErr?.details ?? {}) as Record<string, unknown>;
  const detailMessage = typeof details.message === 'string' ? details.message : undefined;
  const detailStdout = typeof details.stdout === 'string' ? details.stdout : undefined;
  const detailStderr = typeof details.stderr === 'string' ? details.stderr : undefined;
  const nestedBoot =
    details.boot && typeof details.boot === 'object'
      ? (details.boot as Record<string, unknown>)
      : null;
  const nestedBootstatus =
    details.bootstatus && typeof details.bootstatus === 'object'
      ? (details.bootstatus as Record<string, unknown>)
      : null;

  const haystack = [
    input.message,
    appErr?.message,
    input.stdout,
    input.stderr,
    detailMessage,
    detailStdout,
    detailStderr,
    typeof nestedBoot?.stdout === 'string' ? nestedBoot.stdout : undefined,
    typeof nestedBoot?.stderr === 'string' ? nestedBoot.stderr : undefined,
    typeof nestedBootstatus?.stdout === 'string' ? nestedBootstatus.stdout : undefined,
    typeof nestedBootstatus?.stderr === 'string' ? nestedBootstatus.stderr : undefined,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  // Matched before the connect-timeout branch: a runner that could not be
  // installed also never accepts a connection. The stable CoreDevice code is
  // specific to a profile that does not cover the target device; generic
  // profile text also appears for unrelated signing failures.
  if (platform === 'ios' && haystack.includes('0xe8008012')) {
    return BOOT_FAILURE_REASONS.iosRunnerDeviceNotProvisioned.reason;
  }
  if (
    platform === 'ios' &&
    (haystack.includes('provisioning profile') || haystack.includes('embedded profile'))
  ) {
    return BOOT_FAILURE_REASONS.bootCommandFailed.reason;
  }
  if (
    platform === 'ios' &&
    (haystack.includes('runner did not accept connection') ||
      (phase === 'connect' &&
        (haystack.includes('timed out') ||
          haystack.includes('timeout') ||
          haystack.includes('econnrefused') ||
          haystack.includes('connection refused') ||
          haystack.includes('fetch failed') ||
          haystack.includes('socket hang up'))))
  ) {
    return BOOT_FAILURE_REASONS.iosRunnerConnectTimeout.reason;
  }
  if (
    platform === 'ios' &&
    phase === 'boot' &&
    (haystack.includes('timed out') || haystack.includes('timeout'))
  ) {
    return BOOT_FAILURE_REASONS.iosBootTimeout.reason;
  }
  if (
    haystack.includes('resource temporarily unavailable') ||
    haystack.includes('killed: 9') ||
    haystack.includes('cannot allocate memory') ||
    haystack.includes('system is low on memory')
  ) {
    return BOOT_FAILURE_REASONS.ciResourceStarvationSuspected.reason;
  }
  if (appErr?.code === 'COMMAND_FAILED' || haystack.length > 0)
    return BOOT_FAILURE_REASONS.bootCommandFailed.reason;
  return BOOT_FAILURE_REASONS.unknown.reason;
}

export function bootFailureHint(reason: BootFailureReason): string {
  switch (reason) {
    case BOOT_FAILURE_REASONS.iosBootTimeout.reason:
      return 'Retry simulator boot and inspect simctl bootstatus logs; in CI reduce parallel jobs or use a larger runner.';
    case BOOT_FAILURE_REASONS.iosRunnerConnectTimeout.reason:
      return 'Retry runner startup, inspect xcodebuild logs, and verify simulator responsiveness before command execution.';
    case BOOT_FAILURE_REASONS.iosRunnerOwnedByOtherDaemon.reason:
      return 'Close the owning agent-device session or stop its daemon with retained-runner cleanup before retrying.';
    case BOOT_FAILURE_REASONS.iosRunnerDeviceNotProvisioned.reason:
      return 'The XCTest runner cannot be installed on this device: its provisioning profile does not cover it. Register the device with the signing team (Xcode > Settings > Accounts, or add its UDID to the provisioning profile) and retry. Retrying without that will keep failing.';
    case BOOT_FAILURE_REASONS.androidBootTimeout.reason:
      return 'Retry emulator startup and verify sys.boot_completed reaches 1; consider increasing startup budget in CI.';
    case BOOT_FAILURE_REASONS.adbTransportUnavailable.reason:
      return 'Check adb server/device transport (adb devices -l), restart adb, and ensure the target device is online and authorized.';
    case BOOT_FAILURE_REASONS.ciResourceStarvationSuspected.reason:
      return 'CI machine may be resource constrained; reduce parallel jobs or use a larger runner.';
    case BOOT_FAILURE_REASONS.iosToolMissing.reason:
      return 'Xcode command-line tools are missing or not in PATH; run xcode-select --install and verify xcrun works.';
    case BOOT_FAILURE_REASONS.bootCommandFailed.reason:
      return 'Inspect command stderr/stdout for the failing boot phase and retry after environment validation.';
    default:
      return 'Retry once and inspect verbose logs for the failing phase.';
  }
}
