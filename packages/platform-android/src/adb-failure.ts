type AndroidAdbFailureReason =
  | 'timeout'
  | 'device_offline'
  | 'device_unauthorized'
  | 'device_not_found'
  | 'multiple_devices'
  | 'no_devices'
  | 'connection_dropped'
  | 'server_version_mismatch'
  | 'install_insufficient_storage'
  | 'install_update_incompatible'
  | 'install_version_downgrade'
  | 'install_failed';

export type AndroidAdbFailureClassification = Readonly<{
  reason: AndroidAdbFailureReason;
  hint: string;
  retriable?: boolean;
}>;

type AndroidAdbFailureMatcher = readonly [
  pattern: RegExp,
  failure: AndroidAdbFailureClassification,
  matchStdout?: true,
];

const ANDROID_ADB_FAILURE_MATCHERS = [
  [
    /device unauthorized|device still authorizing/,
    {
      reason: 'device_unauthorized',
      hint: 'USB debugging is not authorized — accept the authorization prompt on the device screen (re-plug the cable if none appears), then retry.',
    },
  ],
  [
    /device offline/,
    {
      reason: 'device_offline',
      hint: 'The device is connected but offline — wait for it to finish booting or run adb reconnect, then retry.',
      retriable: true,
    },
  ],
  [
    /more than one (?:device\/emulator|device and emulator)/,
    {
      reason: 'multiple_devices',
      hint: 'Multiple Android devices are connected — pass --serial <serial> (see adb devices) to select one.',
    },
  ],
  [
    /no devices\/emulators found|no devices found/,
    {
      reason: 'no_devices',
      hint: 'No Android devices detected — boot an emulator or connect a device and verify it appears in adb devices.',
    },
  ],
  [
    /device (?:'[^']*' )?not found/,
    {
      reason: 'device_not_found',
      hint: 'The device disconnected or is restarting — verify it is listed in adb devices, then retry.',
      retriable: true,
    },
  ],
  [
    /adb server version \(\d+\) doesn't match this client/,
    {
      reason: 'server_version_mismatch',
      hint: 'Multiple adb installs conflict — adb restarts its server automatically, so retry; align PATH to a single adb to stop recurrences.',
      retriable: true,
    },
  ],
  [
    /transport error|connection reset|broken pipe|protocol fault/,
    {
      reason: 'connection_dropped',
      hint: 'The adb connection dropped — retry; if it persists, run adb kill-server and reconnect the device.',
      retriable: true,
    },
  ],
  [
    /install_failed_insufficient_storage/,
    {
      reason: 'install_insufficient_storage',
      hint: 'The device is out of storage — free up space or uninstall unused apps, then retry the install.',
    },
    true,
  ],
  [
    /install_failed_update_incompatible/,
    {
      reason: 'install_update_incompatible',
      hint: 'The installed app has an incompatible signature — uninstall the existing app first, then retry the install.',
    },
    true,
  ],
  [
    /install_failed_version_downgrade/,
    {
      reason: 'install_version_downgrade',
      hint: 'The APK is older than the installed app — uninstall the app first (or install with downgrade allowed), then retry.',
    },
    true,
  ],
  [
    /install_failed_\w+|install_parse_failed_\w+/,
    {
      reason: 'install_failed',
      hint: 'The Android package installer rejected the APK — see the INSTALL_FAILED code in the error output for the exact cause.',
    },
    true,
  ],
] as const satisfies readonly AndroidAdbFailureMatcher[];

const ANDROID_ADB_TIMEOUT_FAILURE: AndroidAdbFailureClassification = Object.freeze({
  reason: 'timeout',
  hint: 'adb timed out — the adb server may be wedged. Run adb kill-server && adb start-server, check adb devices, then retry.',
});

export function classifyAndroidAdbFailure(
  stderr: string,
  stdout = '',
): AndroidAdbFailureClassification | undefined {
  const stderrText = stderr.toLowerCase();
  const stdoutText = stdout.toLowerCase();
  for (const [pattern, classification, matchStdout] of ANDROID_ADB_FAILURE_MATCHERS) {
    if (pattern.test(stderrText) || (matchStdout && pattern.test(stdoutText))) {
      return classification;
    }
  }
  return undefined;
}

import { AppError } from '@agent-device/kernel/errors';
import type { HostCommandResult } from '@agent-device/contracts/platform';

export function androidDiscoveryCommandError(
  message: string,
  result: HostCommandResult,
  fallbackHint: string,
): AppError {
  const failure = classifyAndroidAdbFailure(result.stderr, result.stdout);
  return new AppError('COMMAND_FAILED', message, {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    processExitError: true,
    hint: failure?.hint ?? fallbackHint,
    ...(failure ? { adbFailure: failure.reason } : {}),
    ...(failure?.retriable === undefined ? {} : { retriable: failure.retriable }),
  });
}

export function attachAndroidDiscoveryTimeout<T>(error: T): T {
  if (
    !(error instanceof AppError) ||
    error.code !== 'COMMAND_FAILED' ||
    typeof error.details?.timeoutMs !== 'number'
  ) {
    return error;
  }
  error.details = {
    ...error.details,
    adbFailure: ANDROID_ADB_TIMEOUT_FAILURE.reason,
    ...(typeof error.details.hint === 'string'
      ? {}
      : {
          hint: ANDROID_ADB_TIMEOUT_FAILURE.hint,
        }),
  };
  return error;
}
