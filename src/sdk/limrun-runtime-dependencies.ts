import { AppError } from '@agent-device/kernel/errors';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
// ProviderDeviceRuntime.getInteractor is synchronous, so this previously eager factory remains the
// deliberate static edge; making it lazy would require a proxy interactor rather than this seam.
import { createAndroidInteractor } from '../core/interactors/android.ts';
import { execFailureDetails, runCmd } from '../utils/exec.ts';
import { readVersion } from '../utils/version.ts';

export function createLimrunRuntimeDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: readVersion(),
    android: {
      createInteractor: (device, adb) => createAndroidInteractor(device, adb),
      createPortReverse: async (adb) => {
        const { createAndroidPortReverseManager } =
          await import('../platforms/android/adb-executor.ts');
        return createAndroidPortReverseManager(adb);
      },
      inferAppName: async (packageName) => {
        const { inferAndroidAppName } = await import('../platforms/android/app-lifecycle.ts');
        return inferAndroidAppName(packageName);
      },
      listApps: async (adb, filter) => {
        const { listAndroidAppsWithAdb } = await import('../platforms/android/app-helpers.ts');
        return (
          await listAndroidAppsWithAdb(adb, {
            filter,
            target: 'mobile',
          })
        ).map((app) => ({ id: app.package, name: app.name }));
      },
      getForegroundApp: async (adb) => {
        const { getAndroidAppStateWithAdb } = await import('../platforms/android/app-helpers.ts');
        const app = await getAndroidAppStateWithAdb(adb);
        return app.package ? { appId: app.package, activity: app.activity } : undefined;
      },
      getKeyboardState: async (adb) => {
        const { getAndroidKeyboardStatusWithAdb } =
          await import('../platforms/android/device-input-state.ts');
        return await getAndroidKeyboardStatusWithAdb(adb);
      },
      dismissKeyboard: async (adb) => {
        const { dismissAndroidKeyboardWithAdb } =
          await import('../platforms/android/device-input-state.ts');
        return await dismissAndroidKeyboardWithAdb(adb);
      },
      readLogs: async (adb, lineLimit) => {
        const { captureAndroidLogcatWithAdb } = await import('../platforms/android/logcat.ts');
        return await captureAndroidLogcatWithAdb(adb, {
          lines: lineLimit,
          timeoutMs: 5_000,
        });
      },
      adbError: async (message, result, details) => {
        // Error construction is async so the platform helper remains lazy until an ADB failure.
        const { androidAdbResultError } = await import('../platforms/android/adb-executor.ts');
        return androidAdbResultError(message, result, details);
      },
    },
    host: {
      runAdb: async (args, options) => await runCmd('adb', args, options),
      archiveDirectory: async ({ sourceDirectory, entryName, archivePath }) => {
        const args = ['-qr', archivePath, entryName];
        const result = await runCmd('zip', args, {
          cwd: sourceDirectory,
          timeoutMs: 120_000,
        });
        if (result.exitCode !== 0) {
          throw new AppError('COMMAND_FAILED', 'Failed to package iOS .app for Limrun install', {
            command: ['zip', ...args].join(' '),
            ...execFailureDetails(result),
          });
        }
      },
    },
    ios: {
      resolveAppAlias: async (app) => {
        const { resolveIosAppAlias } = await import('../platforms/apple/core/app-resolution.ts');
        return resolveIosAppAlias(app);
      },
      readBundleAppName: async (appPath) => {
        const { readIosBundleInfo } = await import('../platforms/apple/core/install-artifact.ts');
        return (await readIosBundleInfo(appPath)).appName;
      },
    },
  };
}
