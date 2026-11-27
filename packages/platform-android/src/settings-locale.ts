import { SETTING_RESET_STATE } from '@agent-device/contracts/settings-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, discloseDispatch, type ReasonTable } from '@agent-device/kernel/errors';
import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';
import type { PreparedAndroidAutomationHelper } from './automation-helper-artifact.ts';

/** The `error.details.reason` values a locale write states when it refuses or fails. */
const ANDROID_LOCALE_REASONS = {
  // The Android system locale list did not start with the requested locale after the update.
  localeNotApplied: { reason: 'locale-not-applied' },
  // The installed helper APK is not the one the helper manifest names, so it does not run as shell.
  helperApkUnverified: { reason: 'locale-helper-apk-unverified' },
} as const satisfies ReasonTable<'settings'>;

/** The helper class that runs as the shell user through `app_process`; see its Javadoc. */
const SYSTEM_LOCALE_COMMAND = 'com.callstack.agentdevice.snapshothelper.SystemLocaleCommand';

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
  const requested = state === SETTING_RESET_STATE ? await readAndroidDefaultLocale(device) : state;
  const { prepareAndroidAutomationHelper } = await import('./automation-helper-artifact.ts');
  const prepared = await prepareAndroidAutomationHelper(device, signal);
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

/**
 * The helper's base APK, which holds the class `app_process` loads as the shell user. The install
 * step may trust a cached decision or a higher installed versionCode, so this path proves its own
 * bytes: the file that runs is the one whose SHA-256 matches the trusted manifest. A refusal drops
 * the cached install decision, so the next command inspects the device again.
 */
async function readVerifiedHelperApkPath(
  device: DeviceInfo,
  prepared: Pick<PreparedAndroidAutomationHelper, 'adbProvider' | 'artifact' | 'deviceKey'>,
  signal?: AbortSignal,
): Promise<string> {
  const { readBaseApkPath, readAndroidDeviceFileSha256 } =
    await import('./helper-package-install.ts');
  const { packageName, versionCode, sha256: expectedSha256 } = prepared.artifact.manifest;
  const refuse = async (
    message: string,
    details: Record<string, unknown>,
    cause?: unknown,
  ): Promise<never> => {
    const { forgetAndroidSnapshotHelperInstall } = await import('./snapshot-helper-install.ts');
    forgetAndroidSnapshotHelperInstall({ deviceKey: prepared.deviceKey, packageName, versionCode });
    throw new AppError(
      'COMMAND_FAILED',
      message,
      {
        ...details,
        deviceId: device.id,
        packageName,
        reason: ANDROID_LOCALE_REASONS.helperApkUnverified.reason,
        dispatched: 'no',
        hint: `Uninstall ${packageName} from the device, then retry so agent-device reinstalls its helper.`,
      },
      cause,
    );
  };
  const result = await runAndroidShell(device, ['pm', 'path', packageName], {
    allowFailure: true,
    signal,
  });
  const apkPath = result.exitCode === 0 ? readBaseApkPath(result.stdout) : undefined;
  if (apkPath === undefined) {
    return await refuse(`Android reported no base APK path for ${packageName}.`, {
      stdout: result.stdout,
    });
  }
  let installedSha256: string;
  try {
    installedSha256 = await readAndroidDeviceFileSha256(prepared.adbProvider, apkPath, signal);
  } catch (error) {
    signal?.throwIfAborted();
    return await refuse(
      `Could not read the installed helper APK for ${packageName}.`,
      { apkPath },
      error,
    );
  }
  if (installedSha256 === expectedSha256) return apkPath;
  return await refuse(
    `The installed helper APK for ${packageName} does not match the helper manifest.`,
    { apkPath, expectedSha256, installedSha256 },
  );
}

function readKeyValueLines(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}
