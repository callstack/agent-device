import type {
  InventoryPlatformModule,
  PlatformModuleMetadata,
} from '@agent-device/contracts/platform-module';
import type { PlatformRuntimeModule } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerContext } from '@agent-device/contracts/interactor-types';

const metadata = Object.freeze({
  family: 'apple',
} satisfies PlatformModuleMetadata);

export const runtimeModule = Object.freeze({
  ...metadata,
  loadRuntime: async (host) => {
    const { createApplePlatformRuntime } = await import('./runtime.ts');
    return createApplePlatformRuntime(host);
  },
} satisfies PlatformRuntimeModule);

export const inventoryModule = Object.freeze({
  ...metadata,
  loadInventory: async (host) => {
    const { createAppleInventorySource } = await import('./inventory.ts');
    return createAppleInventorySource(host);
  },
} satisfies InventoryPlatformModule<'apple'>);

/** Loads Apple shutdown mechanics only when the neutral shutdown capability is exercised. */
export async function loadShutdownRuntime(
  dependencies: Pick<DeviceShutdownRuntimeDependencies, 'appleTools'>,
) {
  const { createAppleShutdownRuntime } = await import('./shutdown/runtime.ts');
  return createAppleShutdownRuntime(dependencies);
}

export const appleToolchainCheck = async (
  ...args: Parameters<(typeof import('./doctor.ts'))['appleToolchainCheck']>
) => (await import('./doctor.ts')).appleToolchainCheck(...args);
export const appleRunnerWarmupCheck = async (
  ...args: Parameters<(typeof import('./doctor.ts'))['appleRunnerWarmupCheck']>
) => (await import('./doctor.ts')).appleRunnerWarmupCheck(...args);

export const applePlugin = {
  id: 'apple',
  platforms: ['apple'],
  familySelector: 'apple',
  providers: { platformGatedResolvers: ['appleRunnerProvider', 'appleToolProvider'] },
  createInteractor: async (device: DeviceInfo, runner: RunnerContext) => {
    const { createAppleInteractor } = await import('./interactor.ts');
    return createAppleInteractor(device, runner);
  },
} as const satisfies PlatformPlugin;

export type {
  AppleMacOsHelperProvider,
  AppleMacOsHostProvider,
  ApplePlistProvider,
  AppleToolAvailabilityChecker,
  AppleToolCommandExecutor,
  AppleToolProvider,
  AppleToolSubcommandExecutor,
  AppleXcrunToolProvider,
} from './core/tool-provider.ts';
export type {
  IosPhysicalDeviceBackend,
  IosPhysicalDeviceControl,
  IosPhysicalDeviceTunnel,
} from './core/physical-device-control.ts';
export type { PreparedIosInstallArtifact } from './core/install-artifact.ts';
export type {
  AppleMemoryPerfSample,
  AppleMemorySnapshotResult,
  AppleProcessSample,
} from './core/perf.ts';
export type {
  AppleXctraceCpuProfileReport,
  AppleXctracePerfCapture,
  AppleXctracePerfMode,
  AppleXctracePerfResult,
} from './core/perf-xctrace.ts';
export type { MacOsPermissionTarget, MacOsSnapshotNode } from './os/macos/helper.ts';

type AppleToolProvider = import('./core/tool-provider.ts').AppleToolProvider;
type AppleInteractor = import('@agent-device/contracts/interactor-types').Interactor;
type AppleInteractorFactory = (typeof import('./interactor.ts'))['createAppleInteractor'];

export const detectSoleRunningIosSimulatorApp = async (
  ...args: Parameters<
    (typeof import('./core/app-resolution.ts'))['detectSoleRunningIosSimulatorApp']
  >
) => (await import('./core/app-resolution.ts')).detectSoleRunningIosSimulatorApp(...args);
export const findIosSimulatorInstalledApp = async (
  ...args: Parameters<(typeof import('./core/app-resolution.ts'))['findIosSimulatorInstalledApp']>
) => (await import('./core/app-resolution.ts')).findIosSimulatorInstalledApp(...args);
export async function invalidateIosAppResolutionCache<T>(
  device: Parameters<
    (typeof import('./core/app-resolution.ts'))['invalidateIosAppResolutionCache']
  >[0],
  operation: () => Promise<T>,
): Promise<T> {
  const { invalidateIosAppResolutionCache: invalidate } = await import('./core/app-resolution.ts');
  return await invalidate(device, operation);
}
export const listIosApps = async (
  ...args: Parameters<(typeof import('./core/app-resolution.ts'))['listIosApps']>
) => (await import('./core/app-resolution.ts')).listIosApps(...args);
export const resolveIosApp = async (
  ...args: Parameters<(typeof import('./core/app-resolution.ts'))['resolveIosApp']>
) => (await import('./core/app-resolution.ts')).resolveIosApp(...args);
export const resolveIosSimulatorDeepLinkBundleId = async (
  ...args: Parameters<
    (typeof import('./core/app-resolution.ts'))['resolveIosSimulatorDeepLinkBundleId']
  >
) => (await import('./core/app-resolution.ts')).resolveIosSimulatorDeepLinkBundleId(...args);

export const closeIosApp = async (
  ...args: Parameters<(typeof import('./core/app-launch.ts'))['closeIosApp']>
) => (await import('./core/app-launch.ts')).closeIosApp(...args);
export const openIosApp = async (
  ...args: Parameters<(typeof import('./core/app-launch.ts'))['openIosApp']>
) => (await import('./core/app-launch.ts')).openIosApp(...args);
export const openIosDevice = async (
  ...args: Parameters<(typeof import('./core/app-launch.ts'))['openIosDevice']>
) => (await import('./core/app-launch.ts')).openIosDevice(...args);
export const screenshotIos = async (
  ...args: Parameters<(typeof import('./core/screenshot.ts'))['screenshotIos']>
) => (await import('./core/screenshot.ts')).screenshotIos(...args);
export const setIosSetting = async (
  ...args: Parameters<(typeof import('./core/app-settings.ts'))['setIosSetting']>
) => (await import('./core/app-settings.ts')).setIosSetting(...args);
export const pushIosNotification = async (
  ...args: Parameters<(typeof import('./core/app-device-io.ts'))['pushIosNotification']>
) => (await import('./core/app-device-io.ts')).pushIosNotification(...args);
export const readIosClipboardText = async (
  ...args: Parameters<(typeof import('./core/app-device-io.ts'))['readIosClipboardText']>
) => (await import('./core/app-device-io.ts')).readIosClipboardText(...args);
export const writeIosClipboardText = async (
  ...args: Parameters<(typeof import('./core/app-device-io.ts'))['writeIosClipboardText']>
) => (await import('./core/app-device-io.ts')).writeIosClipboardText(...args);

export const readAppleAlert = async (
  ...args: Parameters<(typeof import('./alert.ts'))['readAppleAlert']>
) => (await import('./alert.ts')).readAppleAlert(...args);
export const awaitAppleAlert = async (
  ...args: Parameters<(typeof import('./alert.ts'))['awaitAppleAlert']>
) => (await import('./alert.ts')).awaitAppleAlert(...args);
export const actOnAppleAlert = async (
  ...args: Parameters<(typeof import('./alert.ts'))['actOnAppleAlert']>
) => (await import('./alert.ts')).actOnAppleAlert(...args);

export function createAppleInteractor(
  ...args: Parameters<AppleInteractorFactory>
): AppleInteractor {
  let implementation: Promise<AppleInteractor> | undefined;
  const load = (): Promise<AppleInteractor> =>
    (implementation ??= import('./interactor.ts').then(({ createAppleInteractor: create }) =>
      create(...args),
    ));
  const method = <K extends keyof AppleInteractor>(name: K): AppleInteractor[K] =>
    ((...methodArgs: unknown[]) =>
      load().then((interactor) => {
        const operation = interactor[name];
        if (typeof operation !== 'function') {
          throw new TypeError(`Apple interactor method '${String(name)}' is unavailable`);
        }
        return Reflect.apply(operation, interactor, methodArgs);
      })) as AppleInteractor[K];

  return {
    open: method('open'),
    openDevice: method('openDevice'),
    close: method('close'),
    tap: method('tap'),
    pressPoint: method('pressPoint'),
    tapElementSelector: method('tapElementSelector'),
    doubleTap: method('doubleTap'),
    longPress: method('longPress'),
    focus: method('focus'),
    type: method('type'),
    fill: method('fill'),
    scroll: method('scroll'),
    screenshot: method('screenshot'),
    snapshot: method('snapshot'),
    readTextAtPoint: method('readTextAtPoint'),
    findText: method('findText'),
    findSelector: method('findSelector'),
    gestureViewport: method('gestureViewport'),
    back: method('back'),
    home: method('home'),
    setOrientation: method('setOrientation'),
    performGesture: method('performGesture'),
    appSwitcher: method('appSwitcher'),
    tvRemote: method('tvRemote'),
    keyboardDismiss: method('keyboardDismiss'),
    keyboardEnter: method('keyboardEnter'),
    readClipboard: method('readClipboard'),
    writeClipboard: method('writeClipboard'),
    setSetting: method('setSetting'),
    readAlert: method('readAlert'),
    awaitAlert: method('awaitAlert'),
    acceptAlert: method('acceptAlert'),
    dismissAlert: method('dismissAlert'),
  };
}

export const ensureBootedSimulator = async (
  ...args: Parameters<(typeof import('./core/simulator.ts'))['ensureBootedSimulator']>
) => (await import('./core/simulator.ts')).ensureBootedSimulator(...args);
export const shutdownSimulator = async (
  ...args: Parameters<(typeof import('./core/simulator.ts'))['shutdownSimulator']>
) => (await import('./core/simulator.ts')).shutdownSimulator(...args);

export function createLocalAppleToolProvider(
  provider: Partial<AppleToolProvider> = {},
): AppleToolProvider {
  let implementation: Promise<AppleToolProvider> | undefined;
  const load = (): Promise<AppleToolProvider> =>
    (implementation ??= import('./core/tool-provider.ts').then(
      ({ createLocalAppleToolProvider: create }) => create(provider),
    ));

  const delegate = <T extends (...args: never[]) => unknown>(
    select: (loaded: AppleToolProvider) => T | undefined,
    override: T | undefined,
  ): T =>
    (override ??
      ((...args: Parameters<T>) =>
        load().then((loaded) => {
          const operation = select(loaded);
          if (!operation) {
            throw new TypeError('Apple tool provider operation is unavailable');
          }
          return operation(...args);
        }))) as T;

  const runCommand = delegate((loaded) => loaded.runCommand, provider.runCommand);
  const whichCommand = delegate((loaded) => loaded.whichCommand, provider.whichCommand);
  const simctl = provider.simctl ?? {
    run: delegate((loaded) => loaded.simctl?.run, undefined),
  };
  const devicectl = provider.devicectl ?? {
    run: delegate((loaded) => loaded.devicectl?.run, undefined),
  };
  const plist = provider.plist ?? {
    readJson: delegate((loaded) => loaded.plist?.readJson, undefined),
  };
  const macosHost = provider.macosHost ?? {
    openBundle: delegate((loaded) => loaded.macosHost?.openBundle, undefined),
    openTarget: delegate((loaded) => loaded.macosHost?.openTarget, undefined),
    readClipboard: delegate((loaded) => loaded.macosHost?.readClipboard, undefined),
    writeClipboard: delegate((loaded) => loaded.macosHost?.writeClipboard, undefined),
    readDarkMode: delegate((loaded) => loaded.macosHost?.readDarkMode, undefined),
    setDarkMode: delegate((loaded) => loaded.macosHost?.setDarkMode, undefined),
    listApps: delegate((loaded) => loaded.macosHost?.listApps, undefined),
  };

  return {
    ...provider,
    runCommand,
    whichCommand,
    simctl,
    devicectl,
    plist,
    macosHost,
  };
}
export const runAppleToolCommand = async (
  ...args: Parameters<(typeof import('./core/tool-provider.ts'))['runAppleToolCommand']>
) => (await import('./core/tool-provider.ts')).runAppleToolCommand(...args);
export const runXcrun = async (
  ...args: Parameters<(typeof import('./core/tool-provider.ts'))['runXcrun']>
) => (await import('./core/tool-provider.ts')).runXcrun(...args);
export const readApplePlistJson = async (
  ...args: Parameters<(typeof import('./core/tool-provider.ts'))['readApplePlistJson']>
) => (await import('./core/tool-provider.ts')).readApplePlistJson(...args);
export async function withAppleToolProvider<T>(
  provider: Parameters<(typeof import('./core/tool-provider.ts'))['withAppleToolProvider']>[0],
  task: () => Promise<T>,
): Promise<T> {
  const { withAppleToolProvider: runWithAppleToolProvider } =
    await import('./core/tool-provider.ts');
  return await runWithAppleToolProvider(provider, task);
}

export const prepareIosInstallArtifact = async (
  ...args: Parameters<(typeof import('./core/install-artifact.ts'))['prepareIosInstallArtifact']>
) => (await import('./core/install-artifact.ts')).prepareIosInstallArtifact(...args);
export const symbolicateCrashArtifact = async (
  ...args: Parameters<(typeof import('./core/debug-symbols.ts'))['symbolicateCrashArtifact']>
) => (await import('./core/debug-symbols.ts')).symbolicateCrashArtifact(...args);
export const queryAppleRunnerSelector = async (
  ...args: Parameters<
    (typeof import('./core/runner-selector-query.ts'))['queryAppleRunnerSelector']
  >
) => (await import('./core/runner-selector-query.ts')).queryAppleRunnerSelector(...args);

export const resolveFrontmostMacOsApp = async (
  ...args: Parameters<(typeof import('./os/macos/helper.ts'))['resolveFrontmostMacOsApp']>
) => (await import('./os/macos/helper.ts')).resolveFrontmostMacOsApp(...args);
export const runMacOsAlertAction = async (
  ...args: Parameters<(typeof import('./os/macos/helper.ts'))['runMacOsAlertAction']>
) => (await import('./os/macos/helper.ts')).runMacOsAlertAction(...args);
export const startMacOsAudioProbeProcess = async (
  ...args: Parameters<(typeof import('./os/macos/helper.ts'))['startMacOsAudioProbeProcess']>
) => (await import('./os/macos/helper.ts')).startMacOsAudioProbeProcess(...args);
export const captureMacOsSurfaceSnapshot = async (
  ...args: Parameters<
    (typeof import('./os/macos/surface-snapshot.ts'))['captureMacOsSurfaceSnapshot']
  >
) => (await import('./os/macos/surface-snapshot.ts')).captureMacOsSurfaceSnapshot(...args);

export const sampleAppleMemoryPerf = async (
  ...args: Parameters<(typeof import('./core/perf.ts'))['sampleAppleMemoryPerf']>
) => (await import('./core/perf.ts')).sampleAppleMemoryPerf(...args);
export const captureAppleMemorySnapshot = async (
  ...args: Parameters<(typeof import('./core/perf.ts'))['captureAppleMemorySnapshot']>
) => (await import('./core/perf.ts')).captureAppleMemorySnapshot(...args);
export const sampleAppleFramePerf = async (
  ...args: Parameters<(typeof import('./core/perf.ts'))['sampleAppleFramePerf']>
) => (await import('./core/perf.ts')).sampleAppleFramePerf(...args);
export const prepareAppleTraceRecordRetry = async (
  ...args: Parameters<(typeof import('./core/perf.ts'))['prepareAppleTraceRecordRetry']>
) => (await import('./core/perf.ts')).prepareAppleTraceRecordRetry(...args);
export const resolveAppleExecutable = async (
  ...args: Parameters<(typeof import('./core/perf.ts'))['resolveAppleExecutable']>
) => (await import('./core/perf.ts')).resolveAppleExecutable(...args);
export const resolveIosDevicePerfTarget = async (
  ...args: Parameters<(typeof import('./core/perf.ts'))['resolveIosDevicePerfTarget']>
) => (await import('./core/perf.ts')).resolveIosDevicePerfTarget(...args);
export const readAppleProcessSamples = async (
  ...args: Parameters<(typeof import('./core/perf.ts'))['readAppleProcessSamples']>
) => (await import('./core/perf.ts')).readAppleProcessSamples(...args);

export const startAppleXctracePerfCapture = async (
  ...args: Parameters<(typeof import('./core/perf-xctrace.ts'))['startAppleXctracePerfCapture']>
) => (await import('./core/perf-xctrace.ts')).startAppleXctracePerfCapture(...args);
export const stopAppleXctracePerfCapture = async (
  ...args: Parameters<(typeof import('./core/perf-xctrace.ts'))['stopAppleXctracePerfCapture']>
) => (await import('./core/perf-xctrace.ts')).stopAppleXctracePerfCapture(...args);
export const cleanupAppleXctracePerfCapture = async (
  ...args: Parameters<(typeof import('./core/perf-xctrace.ts'))['cleanupAppleXctracePerfCapture']>
) => (await import('./core/perf-xctrace.ts')).cleanupAppleXctracePerfCapture(...args);
export const writeAppleXctracePerfReport = async (
  ...args: Parameters<(typeof import('./core/perf-xctrace.ts'))['writeAppleXctracePerfReport']>
) => (await import('./core/perf-xctrace.ts')).writeAppleXctracePerfReport(...args);

export const runAppleRunnerCommand = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['runAppleRunnerCommand']>
) => (await import('./core/runner-client.ts')).runAppleRunnerCommand(...args);
export const notifyIosRunnerAppRelaunched = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['notifyIosRunnerAppRelaunched']>
) => (await import('./core/runner-client.ts')).notifyIosRunnerAppRelaunched(...args);
export const prewarmAppleRunnerCache = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['prewarmAppleRunnerCache']>
) => (await import('./core/runner-client.ts')).prewarmAppleRunnerCache(...args);
export const prewarmIosRunnerSession = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['prewarmIosRunnerSession']>
) => (await import('./core/runner-client.ts')).prewarmIosRunnerSession(...args);
export const prepareIosRunner = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['prepareIosRunner']>
) => (await import('./core/runner-client.ts')).prepareIosRunner(...args);
export const resolveRunnerAppBundleId = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['resolveRunnerAppBundleId']>
) => (await import('./core/runner-client.ts')).resolveRunnerAppBundleId(...args);
export const detachIosSimulatorRunnerSessionsForShutdown = async (
  ...args: Parameters<
    (typeof import('./core/runner-client.ts'))['detachIosSimulatorRunnerSessionsForShutdown']
  >
) => (await import('./core/runner-client.ts')).detachIosSimulatorRunnerSessionsForShutdown(...args);
export const getRunnerSessionSnapshot = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['getRunnerSessionSnapshot']>
) => (await import('./core/runner-client.ts')).getRunnerSessionSnapshot(...args);
export const scheduleIosRunnerIdleStop = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['scheduleIosRunnerIdleStop']>
) => (await import('./core/runner-client.ts')).scheduleIosRunnerIdleStop(...args);
export const stopIosRunnerSession = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['stopIosRunnerSession']>
) => (await import('./core/runner-client.ts')).stopIosRunnerSession(...args);
export const stopAllIosRunnerSessions = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['stopAllIosRunnerSessions']>
) => (await import('./core/runner-client.ts')).stopAllIosRunnerSessions(...args);
export const cleanupRunnerLeasesForOwner = async (
  owner: Parameters<(typeof import('./runner/runner-lease.ts'))['cleanupRunnerLeasesForOwner']>[0],
): Promise<void> => {
  const { cleanupRunnerLeasesForOwner: cleanup } = await import('./core/runner-client.ts');
  const { runnerLeaseCleanupAdapter } = await import('./runner/runner-disposal.ts');
  await cleanup(owner, runnerLeaseCleanupAdapter);
};
export const readStaleRunnerLease = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['readStaleRunnerLease']>
) => (await import('./core/runner-client.ts')).readStaleRunnerLease(...args);
export const verifyLeaseRunnerPidIdentity = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['verifyLeaseRunnerPidIdentity']>
) => (await import('./core/runner-client.ts')).verifyLeaseRunnerPidIdentity(...args);
export const runApplePressSeries = async (
  ...args: Parameters<(typeof import('./core/runner-client.ts'))['runApplePressSeries']>
) => (await import('./core/runner-client.ts')).runApplePressSeries(...args);
export const applyXctestRunnerAppIconFromDerivedPath = async (
  ...args: Parameters<
    (typeof import('./core/runner-client.ts'))['applyXctestRunnerAppIconFromDerivedPath']
  >
) => (await import('./core/runner-client.ts')).applyXctestRunnerAppIconFromDerivedPath(...args);
