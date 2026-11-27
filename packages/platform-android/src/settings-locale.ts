import { SETTING_RESET_STATE } from '@agent-device/contracts/settings-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, discloseDispatch, type ReasonTable } from '@agent-device/kernel/errors';
import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';
import { readAndroidSdkInt } from './device-sdk-int.ts';
import type { PreparedAndroidAutomationHelper } from './automation-helper-artifact.ts';

/** The `error.details.reason` values a locale write states when it refuses or fails. */
const ANDROID_LOCALE_REASONS = {
  // The Android system locale list did not start with the requested locale after the update.
  localeNotApplied: { reason: 'locale-not-applied' },
  // The helper package lists no base APK, or that APK's SHA-256 differs from the trusted manifest.
  helperApkUnverified: { reason: 'locale-helper-apk-unverified' },
  // Android before 8.0 can reuse a verified install path for another APK, so the shell route is refused.
  apiLevelUnsupported: { reason: 'locale-api-level-unsupported' },
} as const satisfies ReasonTable<'settings'>;

/** The helper class that runs as the shell user through `app_process`; see its Javadoc. */
const SYSTEM_LOCALE_COMMAND = 'com.callstack.agentdevice.snapshothelper.SystemLocaleCommand';

/**
 * Devices, by snapshot-helper device key, whose helper APK a locale command refused. The next
 * locale command there inspects the install instead of trusting the shared install memo, which
 * other helper commands keep using.
 */
const refusedLocaleInstalls = new Set<string>();

/** Android 8.0 gives each install a random directory, so a verified base APK path names one APK. */
const LOCALE_MIN_SDK = 26;

/**
 * Sets the system locale list to one locale, a BCP 47 tag the settings contract already parsed.
 * `adb shell` has no command for it (`cmd locale` sets per-app locales only, and
 * `persist.sys.locale` needs root and a framework restart), so the helper APK's
 * {@link SYSTEM_LOCALE_COMMAND} makes the update as the shell user. reset applies
 * `ro.product.locale`, the locale the image boots with before anyone picks one.
 */
export async function setAndroidLocale(
  device: DeviceInfo,
  state: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  await requireLocaleApiLevel(device, signal);
  const requested = state === SETTING_RESET_STATE ? await readAndroidDefaultLocale(device) : state;
  const { prepareAndroidAutomationHelper } = await import('./automation-helper-artifact.ts');
  const { getAndroidSnapshotHelperSessionDeviceKey } =
    await import('./snapshot-helper-retirement.ts');
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  const prepared = await prepareAndroidAutomationHelper(device, signal, {
    inspectInstalled: refusedLocaleInstalls.has(deviceKey),
  });
  refusedLocaleInstalls.delete(deviceKey);
  const apkPath = await readVerifiedHelperApkPath(device, prepared, signal);
  signal?.throwIfAborted();
  const result = await runAndroidShell(
    device,
    ['env', `CLASSPATH=${apkPath}`, 'app_process', '/system/bin', SYSTEM_LOCALE_COMMAND, requested],
    { allowFailure: true, signal },
  );
  const fields = readKeyValueLines(result.stdout);
  if (result.exitCode !== 0 || fields.current === undefined) {
    throw discloseDispatch(
      androidAdbResultError('Failed to set the Android system locale', result, {
        locale: requested,
        ...(fields.error === undefined ? {} : { helperError: fields.error }),
      }),
      'unknown',
    );
  }
  const current = fields.current.split(',')[0] ?? '';
  if (current.toLowerCase() !== requested.toLowerCase()) {
    throw new AppError('COMMAND_FAILED', `Android kept the locale ${current || '(empty)'}.`, {
      reason: ANDROID_LOCALE_REASONS.localeNotApplied.reason,
      dispatched: 'unknown',
      locale: requested,
      locales: fields.current,
    });
  }
  return { locale: current, previousLocale: fields.previous?.split(',')[0] ?? null };
}

async function readAndroidDefaultLocale(device: DeviceInfo): Promise<string> {
  const result = await runAndroidShell(device, ['getprop', 'ro.product.locale']);
  const reported = result.stdout.trim();
  if (reported.length > 0) return reported;
  throw new AppError('COMMAND_FAILED', 'Android reported no default locale in ro.product.locale.', {
    deviceId: device.id,
    dispatched: 'no',
    hint: 'Pass the locale to restore, such as settings locale en-US.',
  });
}

async function requireLocaleApiLevel(device: DeviceInfo, signal?: AbortSignal): Promise<void> {
  const { sdkInt, result } = await readAndroidSdkInt(device, signal);
  if (sdkInt === null) {
    throw discloseDispatch(
      androidAdbResultError('Failed to read the Android API level', result, {
        deviceId: device.id,
      }),
      'no',
    );
  }
  if (sdkInt >= LOCALE_MIN_SDK) return;
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `settings locale needs Android 8.0 (API ${LOCALE_MIN_SDK}) or newer.`,
    {
      reason: ANDROID_LOCALE_REASONS.apiLevelUnsupported.reason,
      deviceId: device.id,
      sdkInt,
      dispatched: 'no',
    },
  );
}

/**
 * The helper's base APK, which `app_process` loads as the shell user. The install step may trust
 * a cached decision or a higher installed versionCode, so this path proves its own bytes: the file
 * that runs is the one whose SHA-256 matches the trusted manifest. Every failure here precedes the
 * locale write, so it states `dispatched: no` and names a helper install that preparation completed.
 */
async function readVerifiedHelperApkPath(
  device: DeviceInfo,
  prepared: Pick<
    PreparedAndroidAutomationHelper,
    'adbProvider' | 'artifact' | 'deviceKey' | 'install'
  >,
  signal?: AbortSignal,
): Promise<string> {
  const { readBaseApkPath, readAndroidDeviceFileSha256 } =
    await import('./helper-package-install.ts');
  const { packageName, sha256: expectedSha256 } = prepared.artifact.manifest;
  const notDispatched = (error: unknown): unknown => {
    if (!(error instanceof AppError)) return error;
    if (prepared.install.installed) {
      error.details = {
        ...error.details,
        helperInstalled: true,
        helperInstallReason: prepared.install.reason,
      };
    }
    return discloseDispatch(error, 'no');
  };
  const refuse = (message: string, details: Record<string, unknown>): unknown => {
    refusedLocaleInstalls.add(prepared.deviceKey);
    return notDispatched(
      new AppError('COMMAND_FAILED', message, {
        ...details,
        deviceId: device.id,
        packageName,
        reason: ANDROID_LOCALE_REASONS.helperApkUnverified.reason,
        hint: `Retry the command so agent-device inspects and reinstalls its helper. If the device keeps a newer helper build, uninstall ${packageName} first.`,
      }),
    );
  };
  const paths = await runAndroidShell(device, ['pm', 'path', packageName], {
    allowFailure: true,
    signal,
  });
  if (paths.exitCode !== 0) {
    throw notDispatched(
      androidAdbResultError(`Failed to resolve the APK of ${packageName}`, paths, { packageName }),
    );
  }
  const apkPath = readBaseApkPath(paths.stdout);
  if (apkPath === undefined) {
    throw refuse(`Android reported no base APK path for ${packageName}.`, {
      stdout: paths.stdout,
    });
  }
  let installedSha256: string;
  try {
    installedSha256 = await readAndroidDeviceFileSha256(prepared.adbProvider, apkPath, signal);
  } catch (error) {
    throw notDispatched(error);
  }
  if (installedSha256 === expectedSha256) return apkPath;
  throw refuse(`The installed helper APK for ${packageName} does not match the helper manifest.`, {
    apkPath,
    expectedSha256,
    installedSha256,
  });
}

function readKeyValueLines(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}
