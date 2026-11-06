import { createLimrunIosAppLogReader } from '../core/interactors/limrun-ios-app-logs.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import '../platform-runtime-android-adb-host.ts';
// ProviderDeviceRuntime.getInteractor is synchronous, so this factory is the deliberate static edge;
// making it lazy would require a proxy interactor rather than this seam.
import { createAndroidInteractor } from '../core/interactors/android.ts';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
  runAndroidHostAdb,
} from '@agent-device/platform-android/mechanics';
import { withCommandHost } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';

export function createLimrunRuntimeDependencies(host: HostEnvironment): LimrunRuntimeDependencies {
  const runOnHost = <T>(task: () => Promise<T>) =>
    withCommandHost({ host, requestEnv: undefined }, task);
  return {
    clientVersion: readVersion(),
    android: {
      bindDeployment: async (device, adb, request) => {
        const { createAndroidAppDeploymentOperations, withAndroidAdbProvider } =
          await import('@agent-device/platform-android/mechanics');
        const operations = await createAndroidAppDeploymentOperations({ ...request, device });
        return withMethodScope({ ...operations }, (task) =>
          runOnHost(() => withAndroidAdbProvider(adb, { serial: device.id }, task)),
        );
      },
      createInteractor: (device, adb) =>
        withMethodScope(createAndroidInteractor(device, adb), runOnHost),
      createPortReverse: async (adb, options) => {
        const { createAndroidPortReverseManager } =
          await import('@agent-device/platform-android/mechanics');
        return createAndroidPortReverseManager(adb, options);
      },
      inferAppName: async (packageName) => {
        const { inferAndroidAppName } = await import('@agent-device/platform-android/mechanics');
        return inferAndroidAppName(packageName);
      },
      listApps: async (adb, filter) => {
        const { listAndroidAppsWithAdb } = await import('@agent-device/platform-android/mechanics');
        return (
          await listAndroidAppsWithAdb(adb, {
            filter,
            target: 'mobile',
          })
        ).map((app) => ({ id: app.package, name: app.name }));
      },
      getForegroundApp: async (_device, adb, signal) => {
        const { getAndroidAppStateWithAdb } = await import('../platform-runtime.ts');
        const app = await getAndroidAppStateWithAdb(
          async (args, options) => await adb(args, { ...options, signal }),
          signal,
        );
        return app.package ? { appId: app.package, activity: app.activity } : undefined;
      },
      getKeyboardState: async (adb) => {
        const { getAndroidKeyboardStatusWithAdb } =
          await import('@agent-device/platform-android/mechanics');
        return await getAndroidKeyboardStatusWithAdb(adb);
      },
      dismissKeyboard: async (adb) => {
        const { dismissAndroidKeyboardWithAdb } =
          await import('@agent-device/platform-android/mechanics');
        return await dismissAndroidKeyboardWithAdb(adb);
      },
      readLogs: async (adb, lineLimit) => {
        const { captureAndroidLogcatWithAdb } =
          await import('@agent-device/platform-android/mechanics');
        return await captureAndroidLogcatWithAdb(adb, {
          lines: lineLimit,
          timeoutMs: 5_000,
        });
      },
      forceStopApp: async (adb, packageName, signal) => {
        const { runAdbShell } = await import('@agent-device/platform-android/mechanics');
        await runAdbShell(
          async (args, options) => await adb(args, { ...options, signal }),
          ['am', 'force-stop', packageName],
          { allowFailure: true },
        );
      },
      deviceAdbInvocation: (serial, command) =>
        androidAdbInvocation(androidAdbSerialTarget(serial), command),
      hostAdbInvocation: (command) => androidAdbInvocation(androidAdbHostTarget(), command),
      adbError: async (message, result, invocation) => {
        // Error construction is async so the platform helper remains lazy until an ADB failure.
        const { androidAdbResultError, serializeAndroidAdbInvocation } =
          await import('@agent-device/platform-android/mechanics');
        return androidAdbResultError(
          message,
          result,
          invocation
            ? { command: `adb ${serializeAndroidAdbInvocation(invocation).join(' ')}` }
            : undefined,
        );
      },
    },
    host: withMethodScope<LimrunRuntimeDependencies['host']>(
      {
        runAdb: async (invocation, options) => await runAndroidHostAdb(invocation, options),
        downloadFile: async (options) => {
          const { downloadLimrunFile } = await import('../core/limrun-download-file.ts');
          await downloadLimrunFile(options);
        },
      },
      runOnHost,
    ),
    ios: {
      // The scoped wrapper returns promises; this factory must return its reader synchronously.
      createAppLogReader: createLimrunIosAppLogReader,
      ...withMethodScope<Omit<LimrunRuntimeDependencies['ios'], 'createAppLogReader'>>(
        {
          createRunner: async (session) => {
            const { createLimrunIosRunner } =
              await import('../core/interactors/limrun-ios-runner.ts');
            const { createAppleApplicationTools } =
              await import('../platform-runtime-apple-application-tools.ts');
            return createLimrunIosRunner(session, host, createAppleApplicationTools(host.env));
          },
          readBundleAppName: async (appPath) => {
            const { readIosBundleInfo } =
              await import('@agent-device/platform-apple/install-artifact');
            return (await readIosBundleInfo(appPath)).appName;
          },
        },
        runOnHost,
      ),
    },
  };
}
