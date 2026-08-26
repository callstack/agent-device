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
import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';
import type { AndroidAdbExecutorResult } from './adb-transport.ts';

/**
 * Enriches a failed adb command error in place with the classified hint,
 * `retriable` flag, and machine-readable `adbFailure` family, so every adb call
 * site surfaces guidance without per-site classification. Exec-layer timeouts
 * classify as `timeout` even though they leave no stderr. No-op for errors that
 * are not adb command failures or that carry no recognized failure signal; an
 * existing hint or retriable verdict is never overwritten.
 */
export function attachAdbFailureHint<T>(error: T): T {
  if (!(error instanceof AppError) || error.code !== 'COMMAND_FAILED') return error;
  const classification = classifyAdbCommandError(error);
  if (!classification) return error;
  error.details = {
    ...error.details,
    adbFailure: classification.reason,
    ...(typeof error.details?.hint === 'string' ? {} : { hint: classification.hint }),
    ...(classification.retriable !== undefined && error.details?.retriable === undefined
      ? { retriable: classification.retriable }
      : {}),
  };
  return error;
}

// Timeout wins over text matchers: the exec layer deliberately builds timeout
// errors around "timed out after Nms" because partial output from the killed
// process is untrustworthy — classifying that partial stderr (e.g. flagging a
// half-written transport line retriable) would point away from the real fix.
function classifyAdbCommandError(error: AppError): AndroidAdbFailureClassification | undefined {
  if (typeof error.details?.timeoutMs === 'number') return ANDROID_ADB_TIMEOUT_FAILURE;
  const stderr = typeof error.details?.stderr === 'string' ? error.details.stderr : '';
  const stdout = typeof error.details?.stdout === 'string' ? error.details.stdout : '';
  return classifyAndroidAdbFailure(stderr, stdout);
}

/**
 * Builds the COMMAND_FAILED AppError for a failed `allowFailure` adb result and
 * runs it through the failure classifier. This is the shared construction point
 * for call sites that tolerate a failure to inspect it and then throw — those
 * errors never cross the executor throw path, so they classify here instead.
 * Site-provided `details` win on key collisions, and a site `hint` is preserved
 * over the classified one.
 *
 * Nonzero exits set processExitError so normalizeError appends the first stderr
 * line to the curated message — the classified hint and stderr-excerpt
 * enrichment compose instead of competing. Semantic failures thrown at exit 0
 * (e.g. an `am start` error printed on a successful exit) stay unflagged so a
 * stray stderr line never decorates a message the process exit does not back up.
 */
export function androidAdbResultError(
  message: string,
  result: Pick<AndroidAdbExecutorResult, 'exitCode' | 'stdout' | 'stderr'>,
  details?: Record<string, unknown>,
): AppError {
  const failureDetails =
    result.exitCode === 0
      ? { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...details }
      : {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          processExitError: true,
          ...details,
        };
  return attachAdbFailureHint(new AppError('COMMAND_FAILED', message, failureDetails));
}

export function withAdbFailureHints<Args extends unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      throw attachAdbFailureHint(error);
    }
  };
}

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
