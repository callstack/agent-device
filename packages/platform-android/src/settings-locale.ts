import { randomBytes } from 'node:crypto';
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
  // The helper package lists no base APK, or its staged copy differs from the trusted manifest digest.
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
  await recheckRefusedHelperInstall(device);
  const prepared = await prepareAndroidAutomationHelper(device, signal);
  const result = await withVerifiedHelperApk(device, prepared, signal, async (apkPath) => {
    signal?.throwIfAborted();
    return await runAndroidShell(
      device,
      [
        'env',
        `CLASSPATH=${apkPath}`,
        'app_process',
        '/system/bin',
        SYSTEM_LOCALE_COMMAND,
        requested,
      ],
      { allowFailure: true, signal },
    );
  });
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

/** The shell user's scratch directory: apps cannot write there, so a staged APK keeps its bytes. */
const SHELL_SCRATCH_DIRECTORY = '/data/local/tmp';

/**
 * Install decisions a locale refusal put in doubt, keyed by snapshot-helper device key. Only the
 * next locale command on that device drops the cached decision, so other helper commands keep it.
 */
const refusedHelperInstalls = new Map<string, { packageName: string; versionCode: number }>();

async function recheckRefusedHelperInstall(device: DeviceInfo): Promise<void> {
  const { getAndroidSnapshotHelperSessionDeviceKey } =
    await import('./snapshot-helper-retirement.ts');
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  const refused = refusedHelperInstalls.get(deviceKey);
  if (refused === undefined) return;
  refusedHelperInstalls.delete(deviceKey);
  const { forgetAndroidSnapshotHelperInstall } = await import('./snapshot-helper-install.ts');
  forgetAndroidSnapshotHelperInstall({ deviceKey, ...refused });
}

/**
 * Runs `run` with a copy of the helper's base APK staged in the shell scratch directory, after the
 * copy's SHA-256 matched the trusted manifest. The install step may trust a cached decision or a
 * higher installed versionCode, and some releases reuse install directories, so the shell user
 * executes only the staged bytes this function hashed. Every failure here precedes the locale
 * write, so it states `dispatched: no` and names a helper install that preparation completed.
 */
async function withVerifiedHelperApk<T>(
  device: DeviceInfo,
  prepared: Pick<
    PreparedAndroidAutomationHelper,
    'adbProvider' | 'artifact' | 'deviceKey' | 'install'
  >,
  signal: AbortSignal | undefined,
  run: (apkPath: string) => Promise<T>,
): Promise<T> {
  const { readBaseApkPath, readAndroidDeviceFileSha256 } =
    await import('./helper-package-install.ts');
  const { packageName, versionCode, sha256: expectedSha256 } = prepared.artifact.manifest;
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
    refusedHelperInstalls.set(prepared.deviceKey, { packageName, versionCode });
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
  const installedApkPath = readBaseApkPath(paths.stdout);
  if (installedApkPath === undefined) {
    throw refuse(`Android reported no base APK path for ${packageName}.`, { stdout: paths.stdout });
  }
  const stagedApkPath = `${SHELL_SCRATCH_DIRECTORY}/agent-device-locale-${randomBytes(8).toString('hex')}.apk`;
  try {
    const copy = await runAndroidShell(device, ['cp', installedApkPath, stagedApkPath], {
      allowFailure: true,
      signal,
    });
    if (copy.exitCode !== 0) {
      throw notDispatched(
        androidAdbResultError(`Failed to stage the APK of ${packageName}`, copy, {
          packageName,
          installedApkPath,
          stagedApkPath,
        }),
      );
    }
    let stagedSha256: string;
    try {
      stagedSha256 = await readAndroidDeviceFileSha256(prepared.adbProvider, stagedApkPath, signal);
    } catch (error) {
      throw notDispatched(error);
    }
    if (stagedSha256 !== expectedSha256) {
      throw refuse(
        `The installed helper APK for ${packageName} does not match the helper manifest.`,
        {
          installedApkPath,
          expectedSha256,
          installedSha256: stagedSha256,
        },
      );
    }
    return await run(stagedApkPath);
  } finally {
    await runAndroidShell(device, ['rm', '-f', stagedApkPath], { allowFailure: true }).catch(
      () => undefined,
    );
  }
}

function readKeyValueLines(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}
