import { createLimrunIosAppLogReader } from '../core/interactors/limrun-ios-app-logs.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import type {
  ProviderAndroidExecutor,
  ProviderAndroidExecutorOptions,
  ProviderAndroidExecutorResult,
  ProviderAndroidHost,
  ProviderHostCapabilities,
} from '@agent-device/plugins/host';

type LimrunAndroidAdapter = LimrunRuntimeDependencies['android'];
/**
 * The provider's own adb shapes, read from the dependency contract it declares. The provider names
 * them in its implementation and publishes only this aggregate, so the adapter reads them where
 * they already appear instead of mirroring them.
 */
type LimrunAdbExecutor = Parameters<LimrunAndroidAdapter['createPortReverse']>[0];
type LimrunAdbProvider = Parameters<LimrunAndroidAdapter['bindPerformance']>[1];
type LimrunAdbCommandOptions = NonNullable<Parameters<LimrunAdbExecutor>[1]>;
type LimrunAdbCommandResult = Awaited<ReturnType<LimrunAdbExecutor>>;
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

/**
 * Builds the Limrun runtime's dependencies for `host`. The registry's host capabilities, when the
 * caller passes them, serve the shared platform mechanics through one boundary; without them the
 * adapter reaches the same platform owners through its own lazy edges. Every path runs under
 * `host`, so an ambient process environment never answers a provider command.
 */
export function createLimrunRuntimeDependencies(
  host: HostEnvironment,
  capabilities?: ProviderHostCapabilities,
): LimrunRuntimeDependencies {
  const runOnHost = <T>(task: () => Promise<T>) =>
    withCommandHost({ host, requestEnv: undefined }, task);
  const android: ProviderAndroidHost | undefined = capabilities?.android;
  /**
   * Hands one of this adapter's executors to the capability boundary. The contract names a stdin
   * payload a plain byte array while this adapter's executors take a Node buffer, so a foreign
   * array becomes a buffer before the executor sees it. A buffer is already a byte array, so a
   * payload this adapter writes reaches its executor untouched.
   */
  const toProviderExecutor = (adb: LimrunAdbExecutor): ProviderAndroidExecutor => {
    return async (args, options) => await adb(args, asLimrunAdbOptions(options));
  };
  /** Scopes platform adb internals to `adb` for `serial` while `task` runs, under this host. */
  const withProviderScope = <T>(
    serial: string,
    adb: LimrunAdbProvider | LimrunAdbExecutor,
    task: () => Promise<T>,
  ): Promise<T> =>
    android
      ? android.withAdbProvider(
          typeof adb === 'function'
            ? toProviderExecutor(adb)
            : { ...adb, exec: toProviderExecutor(adb.exec) },
          serial,
          task,
        )
      : runOnHost(async () => {
          const { withAndroidAdbProvider } =
            await import('@agent-device/platform-android/mechanics');
          return await withAndroidAdbProvider(adb, { serial }, task);
        });
  return {
    clientVersion: readVersion(),
    android: {
      bindPerformance: async (device, adb, runtimeHost, owner) => {
        const { createAndroidPerfOperations } =
          await import('@agent-device/platform-android/mechanics');
        const scopedHost = withMethodScope({ ...runtimeHost }, (task) =>
          withProviderScope(device.id, adb, task),
        );
        const { perfFrames, perfMemorySample, perfMemorySnapshot } =
          await createAndroidPerfOperations({ device, owner, resolveHost: () => scopedHost });
        return { perfFrames, perfMemorySample, perfMemorySnapshot };
      },
      bindDeployment: async (device, adb, request) => {
        const { createAndroidAppDeploymentOperations } =
          await import('@agent-device/platform-android/mechanics');
        const operations = await createAndroidAppDeploymentOperations({ ...request, device });
        return withMethodScope({ ...operations }, (task) =>
          withProviderScope(device.id, adb, task),
        );
      },
      createInteractor: (device, adb) =>
        withMethodScope(createAndroidInteractor(device, adb), runOnHost),
      createPortReverse: (adb, options) =>
        android?.createPortReverse(toProviderExecutor(adb), options) ??
        import('@agent-device/platform-android/mechanics').then(
          ({ createAndroidPortReverseManager }) => createAndroidPortReverseManager(adb, options),
        ),
      inferAppName: async (packageName) => {
        const { inferAndroidAppName } = await import('@agent-device/platform-android/mechanics');
        return inferAndroidAppName(packageName);
      },
      listApps: async (adb, filter) => {
        const apps = await (android?.listApps(toProviderExecutor(adb), {
          filter,
          target: 'mobile',
        }) ??
          import('@agent-device/platform-android/mechanics').then(({ listAndroidAppsWithAdb }) =>
            listAndroidAppsWithAdb(adb, { filter, target: 'mobile' }),
          ));
        return apps.map((app) => ({ id: app.package, name: app.name }));
      },
      getForegroundApp: async (_device, adb, signal) => {
        const { getAndroidAppStateWithAdb } = await import('../platform-runtime.ts');
        const app = await getAndroidAppStateWithAdb(
          async (args, options) => await adb(args, { ...options, signal }),
          signal,
        );
        return app.package ? { appId: app.package, activity: app.activity } : undefined;
      },
      getKeyboardState: (adb) =>
        android?.keyboardState(toProviderExecutor(adb)) ??
        import('@agent-device/platform-android/mechanics').then(
          ({ getAndroidKeyboardStatusWithAdb }) => getAndroidKeyboardStatusWithAdb(adb),
        ),
      dismissKeyboard: (adb) =>
        android?.dismissKeyboard(toProviderExecutor(adb)) ??
        import('@agent-device/platform-android/mechanics').then(
          ({ dismissAndroidKeyboardWithAdb }) => dismissAndroidKeyboardWithAdb(adb),
        ),
      readLogs: (adb, lineLimit) =>
        android?.readLogs(toProviderExecutor(adb), { lines: lineLimit, timeoutMs: 5_000 }) ??
        import('@agent-device/platform-android/mechanics').then(({ captureAndroidLogcatWithAdb }) =>
          captureAndroidLogcatWithAdb(adb, { lines: lineLimit, timeoutMs: 5_000 }),
        ),
      forceStopApp: async (adb, packageName, signal) => {
        // The capability quotes each word for the device shell and forwards the caller's signal;
        // the lazy edge folds the signal into the executor instead. Both tolerate a device that says no.
        if (android) {
          await android.runShell(
            async (args, options) => await adb(args, { ...asLimrunAdbOptions(options), signal }),
            ['am', 'force-stop', packageName],
            { allowFailure: true, signal },
          );
          return;
        }
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
      adbError: (message, result, invocation) =>
        android?.adbError(message, result, invocation) ??
        // Error construction is async so the platform helper remains lazy until an ADB failure.
        import('@agent-device/platform-android/mechanics').then(
          ({ androidAdbResultError, serializeAndroidAdbInvocation }) =>
            androidAdbResultError(
              message,
              result,
              invocation
                ? { command: `adb ${serializeAndroidAdbInvocation(invocation).join(' ')}` }
                : undefined,
            ),
        ),
    },
    host: withMethodScope<LimrunRuntimeDependencies['host']>(
      {
        runAdb: async (invocation, options) => {
          const viaCapabilities = await android?.runAdb(invocation, options);
          return viaCapabilities === undefined
            ? await runAndroidHostAdb(invocation, options)
            : asLimrunAdbResult(viaCapabilities);
        },
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
            const applicationTools =
              capabilities?.apple?.applicationTools ??
              (
                await import('../platform-runtime-apple-application-tools.ts')
              ).createAppleApplicationTools(host.env);
            return createLimrunIosRunner(session, host, applicationTools);
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

/**
 * Reads capability execution options as this adapter's own. The contract names a stdin payload a
 * plain byte array while this adapter's executors take a Node buffer; a buffer is already a byte
 * array, so only a foreign array needs copying.
 */
function asLimrunAdbOptions(
  options: ProviderAndroidExecutorOptions | undefined,
): LimrunAdbCommandOptions | undefined {
  if (options === undefined) return undefined;
  const { stdin, ...rest } = options;
  return {
    ...rest,
    ...(stdin === undefined ? {} : { stdin: Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin) }),
  };
}

/** Reads one capability answer as this adapter's own, keeping its binary stdout as a buffer. */
function asLimrunAdbResult(
  result: ProviderAndroidExecutorResult,
): LimrunAdbCommandResult & { stdoutBuffer?: Buffer } {
  const { stdoutBuffer, ...rest } = result;
  return {
    ...rest,
    ...(stdoutBuffer === undefined
      ? {}
      : {
          stdoutBuffer: Buffer.isBuffer(stdoutBuffer) ? stdoutBuffer : Buffer.from(stdoutBuffer),
        }),
  };
}
