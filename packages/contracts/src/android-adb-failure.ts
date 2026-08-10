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
  /** Machine-readable failure family attached to error details as `adbFailure`. */
  reason: AndroidAdbFailureReason;
  hint: string;
  /** Present only when an unchanged retry can succeed. */
  retriable?: boolean;
}>;

type AndroidAdbFailureMatcher = AndroidAdbFailureClassification &
  Readonly<{
    pattern: RegExp;
    /** Android package-manager install verdicts may be emitted on stdout. */
    matchStdout?: boolean;
  }>;

const ANDROID_ADB_FAILURE_MATCHERS: readonly AndroidAdbFailureMatcher[] = [
  {
    reason: 'device_unauthorized',
    pattern: /device unauthorized|device still authorizing/,
    hint: 'USB debugging is not authorized — accept the authorization prompt on the device screen (re-plug the cable if none appears), then retry.',
  },
  {
    reason: 'device_offline',
    pattern: /device offline/,
    hint: 'The device is connected but offline — wait for it to finish booting or run adb reconnect, then retry.',
    retriable: true,
  },
  {
    reason: 'multiple_devices',
    pattern: /more than one (?:device\/emulator|device and emulator)/,
    hint: 'Multiple Android devices are connected — pass --serial <serial> (see adb devices) to select one.',
  },
  {
    reason: 'no_devices',
    pattern: /no devices\/emulators found|no devices found/,
    hint: 'No Android devices detected — boot an emulator or connect a device and verify it appears in adb devices.',
  },
  {
    reason: 'device_not_found',
    pattern: /device (?:'[^']*' )?not found/,
    hint: 'The device disconnected or is restarting — verify it is listed in adb devices, then retry.',
    retriable: true,
  },
  {
    reason: 'server_version_mismatch',
    pattern: /adb server version \(\d+\) doesn't match this client/,
    hint: 'Multiple adb installs conflict — adb restarts its server automatically, so retry; align PATH to a single adb to stop recurrences.',
    retriable: true,
  },
  {
    reason: 'connection_dropped',
    pattern: /transport error|connection reset|broken pipe|protocol fault/,
    hint: 'The adb connection dropped — retry; if it persists, run adb kill-server and reconnect the device.',
    retriable: true,
  },
  {
    reason: 'install_insufficient_storage',
    pattern: /install_failed_insufficient_storage/,
    hint: 'The device is out of storage — free up space or uninstall unused apps, then retry the install.',
    matchStdout: true,
  },
  {
    reason: 'install_update_incompatible',
    pattern: /install_failed_update_incompatible/,
    hint: 'The installed app has an incompatible signature — uninstall the existing app first, then retry the install.',
    matchStdout: true,
  },
  {
    reason: 'install_version_downgrade',
    pattern: /install_failed_version_downgrade/,
    hint: 'The APK is older than the installed app — uninstall the app first (or install with downgrade allowed), then retry.',
    matchStdout: true,
  },
  {
    reason: 'install_failed',
    pattern: /install_failed_\w+|install_parse_failed_\w+/,
    hint: 'The Android package installer rejected the APK — see the INSTALL_FAILED code in the error output for the exact cause.',
    matchStdout: true,
  },
];

export const ANDROID_ADB_TIMEOUT_FAILURE: AndroidAdbFailureClassification = Object.freeze({
  reason: 'timeout',
  hint: 'adb timed out — the adb server may be wedged. Run adb kill-server && adb start-server, check adb devices, then retry.',
});

/**
 * Classifies transport failures from stderr. Package-manager install verdicts
 * additionally inspect stdout because adb emits those semantic results there.
 */
export function classifyAndroidAdbFailure(
  stderr: string,
  stdout = '',
): AndroidAdbFailureClassification | undefined {
  const stderrText = stderr.toLowerCase();
  const stdoutText = stdout.toLowerCase();
  for (const { pattern, matchStdout, ...classification } of ANDROID_ADB_FAILURE_MATCHERS) {
    if (pattern.test(stderrText) || (matchStdout && pattern.test(stdoutText))) {
      return classification;
    }
  }
  return undefined;
}
