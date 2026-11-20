import type { AndroidPerfHost } from '@agent-device/contracts/perf-runtime-host';
import type {
  AppDeploymentInstaller,
  AppDeploymentRuntimeOperations,
} from '@agent-device/contracts/app-deployment-runtime';
import type { AppleApplicationTools } from '@agent-device/contracts/application-lifecycle-runtime';
import type { AppsFilter } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { DiagnosticEventInput } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppError } from '@agent-device/kernel/errors';
import type { ProviderPluginHost } from '@agent-device/plugins/host';

// This entry is not a published export. A provider plugin built in this repository reads these
// types through a workspace path; publishing them would place the platform declarations in the
// shared chunk every `agent-device/plugins` consumer loads.

type AndroidMechanics = typeof import('@agent-device/platform-android/mechanics');
type AndroidAdbProvider = import('@agent-device/platform-android/mechanics').AndroidAdbProvider;
type AndroidAdbInvocation = import('@agent-device/platform-android/mechanics').AndroidAdbInvocation;
type AndroidAdbExecutor = Parameters<AndroidMechanics['runAdbShell']>[0];
type AndroidPerfOperations = Awaited<ReturnType<AndroidMechanics['createAndroidPerfOperations']>>;
type AppleRunnerOperations = typeof import('@agent-device/platform-apple/runner/operations');
type AppleToolProviderModule = typeof import('@agent-device/platform-apple/tool-provider');
type HostRetry = typeof import('@agent-device/host-kit/retry');

/** What a provider asks of an Android install: the request's host, its signal and its installer. */
export type ProviderAndroidDeploymentRequest = Readonly<{
  host: PlatformRuntimeHost;
  signal: AbortSignal;
  install: AppDeploymentInstaller;
}>;

/**
 * The Android host a provider plugin drives its leased devices through. Every operation takes the
 * provider's own ADB executor, so the provider decides how a command reaches its device and the
 * platform decides what the command is. Commands run under the host these capabilities were built
 * for; an enclosing request's environment is not added.
 */
export type ProviderAndroidHost = Readonly<{
  /** Runs one addressed invocation over the host ADB transport. */
  runAdb: AndroidMechanics['runAndroidHostAdb'];
  /** Addresses one device command at `serial`. */
  deviceAdbInvocation(serial: string, command: readonly string[]): AndroidAdbInvocation;
  /** Addresses one server-level command, which selects no device. */
  hostAdbInvocation(command: readonly string[]): AndroidAdbInvocation;
  adbError(
    message: string,
    result: Parameters<AndroidMechanics['androidAdbResultError']>[1],
    invocation?: AndroidAdbInvocation,
  ): AppError;
  /**
   * The Android interactor for one leased device, bound to that lease's executor. The platform owns
   * the interactor; the provider owns only the executor it answers through.
   */
  createLeaseInteractor(device: DeviceInfo, adb: AndroidAdbProvider): Interactor;
  bindPerformance(
    device: DeviceInfo,
    adb: AndroidAdbProvider,
    host: AndroidPerfHost,
    owner: RuntimeOwnerRef,
  ): Promise<Pick<AndroidPerfOperations, 'perfFrames' | 'perfMemorySample' | 'perfMemorySnapshot'>>;
  bindDeployment(
    device: DeviceInfo,
    adb: AndroidAdbProvider,
    request: ProviderAndroidDeploymentRequest,
  ): Promise<Partial<AppDeploymentRuntimeOperations>>;
  createPortReverse: AndroidMechanics['createAndroidPortReverseManager'];
  inferAppName: AndroidMechanics['inferAndroidAppName'];
  listApps(
    adb: AndroidAdbExecutor,
    filter: AppsFilter,
  ): Promise<Array<{ id: string; name?: string }>>;
  getForegroundApp(
    adb: AndroidAdbExecutor,
    signal?: AbortSignal,
  ): Promise<{ appId?: string; activity?: string } | undefined>;
  getKeyboardState: AndroidMechanics['getAndroidKeyboardStatusWithAdb'];
  dismissKeyboard: AndroidMechanics['dismissAndroidKeyboardWithAdb'];
  readLogs(adb: AndroidAdbExecutor, lineLimit: number): Promise<string>;
  /** Stops the app. Tolerates a device that refuses. */
  forceStopApp(adb: AndroidAdbExecutor, packageName: string, signal?: AbortSignal): Promise<void>;
}>;

/**
 * The Apple host a provider plugin drives a leased simulator through: the shared XCTest runner, the
 * tool-provider scope its commands answer in, and the application tools that resolve an open target
 * and write runtime hints. A provider supplies the tool provider that reaches its simulator.
 */
export type ProviderAppleHost = Readonly<{
  applicationTools: Pick<
    AppleApplicationTools,
    'resolveOpenTarget' | 'applyRuntimeHints' | 'clearRuntimeHints'
  >;
  runner: Readonly<{
    /** Builds the runner runtime for `device` under this host. */
    createRuntime(
      options: Omit<Parameters<AppleRunnerOperations['createAppleRunnerRuntime']>[0], 'host'>,
    ): ReturnType<AppleRunnerOperations['createAppleRunnerRuntime']>;
    /** Builds a runner provider whose XCTest run the caller launches. */
    createLaunchedProvider(
      device: Parameters<AppleRunnerOperations['createLaunchedAppleRunnerProvider']>[0],
      options: Parameters<AppleRunnerOperations['createLaunchedAppleRunnerProvider']>[1],
    ): ReturnType<AppleRunnerOperations['createLaunchedAppleRunnerProvider']>;
    mintToken: AppleRunnerOperations['mintRunnerToken'];
    listenerEnv: AppleRunnerOperations['runnerListenerEnv'];
    startupTimeoutMs: number;
    xctestrunCaptureOptions: AppleRunnerOperations['RUNNER_XCTESTRUN_CAPTURE_OPTIONS'];
  }>;
  tools: Readonly<{
    withProvider: AppleToolProviderModule['withAppleToolProvider'];
    hasScopedProvider: AppleToolProviderModule['hasScopedAppleToolProvider'];
    runXcrun: AppleToolProviderModule['runXcrun'];
    simctlArgsForDevice: typeof import('@agent-device/platform-apple/simctl').buildSimctlArgsForDevice;
    parsePlist: AppleToolProviderModule['parseApplePlist'];
  }>;
  readBundleAppName(appPath: string): Promise<string | undefined>;
}>;

/** Host mechanics whose diagnostics and budgets belong to this process. */
export type ProviderHostKit = Readonly<{
  retryWithPolicy: HostRetry['retryWithPolicy'];
  Deadline: HostRetry['Deadline'];
  extractArchiveSafely: typeof import('@agent-device/host-kit/archive').extractArchiveSafely;
  execFailureDetails: typeof import('@agent-device/host-kit/command').execFailureDetails;
}>;

/**
 * What the composing root adds to every provider plugin `setup` host. Each loader imports its
 * platform owner on first use, so a plugin that needs none of them loads none of them.
 */
export type ProviderHostCapabilities = Readonly<{
  /** The daemon's own state directory. */
  stateDir: string;
  /** Records one event in the diagnostics of the request that is running. */
  emitDiagnostic(event: DiagnosticEventInput): void;
  loadAndroid(): Promise<ProviderAndroidHost>;
  loadApple(): Promise<ProviderAppleHost>;
  loadHostKit(): Promise<ProviderHostKit>;
}>;

/**
 * The host a provider `setup` receives from the daemon or `startAgentDevice`: the plugin host plus
 * the device capabilities. A `connect` callback's host carries none of them, so each is optional.
 */
export type DeviceProviderPluginHost = ProviderPluginHost & Partial<ProviderHostCapabilities>;
