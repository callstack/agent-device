import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import { execFailureDetails, withCommandHost } from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type {
  ProviderAndroidHost,
  ProviderAppleHost,
  ProviderHostCapabilities,
} from './sdk/plugin-device-host.ts';

type AndroidAdbProvider = import('@agent-device/platform-android/mechanics').AndroidAdbProvider;

type RunOnHost = <T>(task: () => Promise<T>) => Promise<T>;

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () => (loading ??= load());
}

/**
 * The device capabilities every provider plugin `setup` host carries, built for `host`.
 */
export function createProviderHostCapabilities(host: HostEnvironment): ProviderHostCapabilities {
  const runOnHost: RunOnHost = (task) => withCommandHost({ host, requestEnv: undefined }, task);
  return Object.freeze({
    stateDir: resolveDaemonPaths(host.env.AGENT_DEVICE_STATE_DIR, {
      env: host.env,
      cwd: host.cwd,
    }).baseDir,
    emitDiagnostic,
    loadAndroid: once(async () => await createProviderAndroidHost(runOnHost)),
    loadApple: once(async () => await createProviderAppleHost(host, runOnHost)),
    loadHostKit: once(async () => {
      const [{ retryWithPolicy, Deadline }, { extractArchiveSafely }] = await Promise.all([
        import('@agent-device/host-kit/retry'),
        import('@agent-device/host-kit/archive'),
      ]);
      return Object.freeze({ retryWithPolicy, Deadline, extractArchiveSafely, execFailureDetails });
    }),
  } satisfies ProviderHostCapabilities);
}

async function createProviderAndroidHost(runOnHost: RunOnHost): Promise<ProviderAndroidHost> {
  // The host adb port refuses an unbound host; this wiring binds it and loads no device state.
  await import('./platform-runtime-android-adb-host.ts');
  const [mechanics, { createAndroidInteractor }, { getAndroidAppStateWithAdb }] = await Promise.all(
    [
      import('@agent-device/platform-android/mechanics'),
      // `getInteractor` is synchronous, so the factory is loaded with the facet.
      import('./core/interactors/android.ts'),
      import('./platform-runtime.ts'),
    ],
  );
  const scoped = (device: DeviceInfo, adb: AndroidAdbProvider) => (task: () => Promise<unknown>) =>
    runOnHost(() => mechanics.withAndroidAdbProvider(adb, { serial: device.id }, task));
  return Object.freeze({
    runAdb: async (invocation, options) =>
      await runOnHost(() => mechanics.runAndroidHostAdb(invocation, options)),
    deviceAdbInvocation: (serial, command) =>
      mechanics.androidAdbInvocation(mechanics.androidAdbSerialTarget(serial), command),
    hostAdbInvocation: (command) =>
      mechanics.androidAdbInvocation(mechanics.androidAdbHostTarget(), command),
    adbError: (message, result, invocation) =>
      mechanics.androidAdbResultError(
        message,
        result,
        invocation
          ? { command: `adb ${mechanics.serializeAndroidAdbInvocation(invocation).join(' ')}` }
          : undefined,
      ),
    createLeaseInteractor: (device, adb) =>
      withMethodScope(createAndroidInteractor(device, adb), runOnHost),
    bindPerformance: async (device, adb, runtimeHost, owner) => {
      const scopedHost = withMethodScope({ ...runtimeHost }, scoped(device, adb) as RunOnHost);
      const { perfFrames, perfMemorySample, perfMemorySnapshot } =
        await mechanics.createAndroidPerfOperations({
          device,
          owner,
          resolveHost: () => scopedHost,
        });
      return { perfFrames, perfMemorySample, perfMemorySnapshot };
    },
    bindDeployment: async (device, adb, request) => {
      const operations = await mechanics.createAndroidAppDeploymentOperations({
        ...request,
        device,
      });
      return withMethodScope({ ...operations }, scoped(device, adb) as RunOnHost);
    },
    createPortReverse: mechanics.createAndroidPortReverseManager,
    inferAppName: mechanics.inferAndroidAppName,
    listApps: async (adb, filter) =>
      (await mechanics.listAndroidAppsWithAdb(adb, { filter, target: 'mobile' })).map((app) => ({
        id: app.package,
        name: app.name,
      })),
    getForegroundApp: async (adb, signal) => {
      const app = await getAndroidAppStateWithAdb(
        async (args, options) => await adb(args, { ...options, signal }),
        signal,
      );
      return app.package ? { appId: app.package, activity: app.activity } : undefined;
    },
    getKeyboardState: mechanics.getAndroidKeyboardStatusWithAdb,
    dismissKeyboard: mechanics.dismissAndroidKeyboardWithAdb,
    readLogs: async (adb, lineLimit) =>
      await mechanics.captureAndroidLogcatWithAdb(adb, { lines: lineLimit, timeoutMs: 5_000 }),
    forceStopApp: async (adb, packageName, signal) => {
      await mechanics.runAdbShell(
        async (args, options) => await adb(args, { ...options, signal }),
        ['am', 'force-stop', packageName],
        { allowFailure: true },
      );
    },
  } satisfies ProviderAndroidHost);
}

async function createProviderAppleHost(
  host: HostEnvironment,
  runOnHost: RunOnHost,
): Promise<ProviderAppleHost> {
  const [runner, tools, { buildSimctlArgsForDevice }, { createAppleApplicationTools }] =
    await Promise.all([
      import('@agent-device/platform-apple/runner/operations'),
      import('@agent-device/platform-apple/tool-provider'),
      import('@agent-device/platform-apple/simctl'),
      import('./platform-runtime-apple-application-tools.ts'),
    ]);
  const { resolveOpenTarget, applyRuntimeHints, clearRuntimeHints } = createAppleApplicationTools(
    host.env,
  );
  return Object.freeze({
    applicationTools: Object.freeze({ resolveOpenTarget, applyRuntimeHints, clearRuntimeHints }),
    runner: Object.freeze({
      // Both are built under this host, so no enclosing request's environment reaches the runner.
      createRuntime: async (options) =>
        await runOnHost(() => runner.createAppleRunnerRuntime({ ...options, host })),
      createLaunchedProvider: async (device, options) =>
        await runOnHost(() => runner.createLaunchedAppleRunnerProvider(device, options, host.env)),
      mintToken: runner.mintRunnerToken,
      listenerEnv: runner.runnerListenerEnv,
      startupTimeoutMs: runner.RUNNER_STARTUP_TIMEOUT_MS,
      xctestrunCaptureOptions: runner.RUNNER_XCTESTRUN_CAPTURE_OPTIONS,
    }),
    tools: Object.freeze({
      withProvider: tools.withAppleToolProvider,
      hasScopedProvider: tools.hasScopedAppleToolProvider,
      runXcrun: tools.runXcrun,
      simctlArgsForDevice: buildSimctlArgsForDevice,
      parsePlist: tools.parseApplePlist,
    }),
    readBundleAppName: async (appPath) =>
      await runOnHost(async () => {
        const { readIosBundleInfo } = await import('@agent-device/platform-apple/install-artifact');
        return (await readIosBundleInfo(appPath)).appName;
      }),
  } satisfies ProviderAppleHost);
}
