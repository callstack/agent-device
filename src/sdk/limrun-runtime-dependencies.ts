import { AppError } from '@agent-device/kernel/errors';
import { createAndroidInteractor } from '../core/interactors/android.ts';
import {
  androidAdbResultError,
  createAndroidPortReverseManager,
} from '../platforms/android/adb-executor.ts';
import {
  getAndroidAppStateWithAdb,
  listAndroidAppsWithAdb,
} from '../platforms/android/app-helpers.ts';
import { inferAndroidAppName } from '../platforms/android/app-lifecycle.ts';
import {
  dismissAndroidKeyboardWithAdb,
  getAndroidKeyboardStatusWithAdb,
} from '../platforms/android/device-input-state.ts';
import { captureAndroidLogcatWithAdb } from '../platforms/android/logcat.ts';
import { resolveIosAppAlias } from '../platforms/apple/core/app-resolution.ts';
import { readIosBundleInfo } from '../platforms/apple/core/install-artifact.ts';
import type { LimrunRuntimeDependencies } from '../providers/limrun/runtime-dependencies.ts';
import { execFailureDetails, runCmd } from '../utils/exec.ts';
import { readVersion } from '../utils/version.ts';

export function createLimrunRuntimeDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: readVersion(),
    android: {
      createInteractor: (device, adb) => createAndroidInteractor(device, adb),
      createPortReverse: (adb) => createAndroidPortReverseManager(adb),
      inferAppName: inferAndroidAppName,
      listApps: async (adb, filter) =>
        (
          await listAndroidAppsWithAdb(adb, {
            filter,
            target: 'mobile',
          })
        ).map((app) => ({ id: app.package, name: app.name })),
      getForegroundApp: async (adb) => {
        const app = await getAndroidAppStateWithAdb(adb);
        return app.package ? { appId: app.package, activity: app.activity } : undefined;
      },
      getKeyboardState: getAndroidKeyboardStatusWithAdb,
      dismissKeyboard: dismissAndroidKeyboardWithAdb,
      readLogs: async (adb, lineLimit) =>
        await captureAndroidLogcatWithAdb(adb, {
          lines: lineLimit,
          timeoutMs: 5_000,
        }),
      adbError: androidAdbResultError,
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
      resolveAppAlias: resolveIosAppAlias,
      readBundleAppName: async (appPath) => (await readIosBundleInfo(appPath)).appName,
    },
  };
}
