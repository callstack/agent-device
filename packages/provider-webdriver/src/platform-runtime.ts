import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  bindProviderScreenshotInteractor,
  bindProviderSnapshotInteractor,
  createUnavailablePlatformRuntimeFacts,
  sameRuntimeOwner,
  screenshotRuntimeOperationFacts,
  snapshotRuntimeOperationFacts,
  viewportRuntimeOperationFacts,
  type AppDeploymentInput,
  type DeployMaterializedAppInput,
  type DeviceBinding,
  type MaterializeAppSourceInput,
  type MaterializedAppSource,
  type PlatformRuntimeHost,
  type PlatformRuntimeOperations,
  type PlatformRuntimeOwner,
  type RuntimeFacts,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import { readRecentNetworkTrafficFromText } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { WebDriverDeploymentRuntime } from './runtime-deployment.ts';
import { bindWebDriverApplicationLifecycle } from './lifecycle.ts';

type WebDriverPlatformDeploymentRuntime = Pick<
  WebDriverDeploymentRuntime,
  'fact' | 'deployApp' | 'deployMaterializedApp'
>;

const available = Object.freeze({ available: true } as const);
const appLogUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose screen recording.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is unavailable for provider-owned devices.',
} as const);
const appsUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing' as const,
  hint: 'WebDriver provider runtimes do not expose app inventory.',
});
const deploymentUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose app deployment.',
} as const);
const pushUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Push notifications are unavailable for WebDriver provider-owned devices.',
} as const);
const inactiveSession = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'The WebDriver provider session is no longer active for this device.',
} as const);
const snapshotUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose snapshot capture for this device.',
} as const);
const screenshotUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose screenshot capture for this device.',
} as const);
const snapshotCustomActionsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose iOS simulator custom snapshot actions.',
} as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose viewport resizing.',
} as const);

const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose a foreground app-state operation.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Apple runner preparation is unavailable for WebDriver-owned devices.',
} as const);
const openTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver open is supported only for its owned iOS or Android mobile-device sessions.',
} as const);
const closeTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver close is supported only for its owned iOS or Android mobile-device sessions.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Runtime hints are not applied to provider-owned devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose port reverse.',
} as const);

function webDriverLifecycleFacts(device: DeviceInfo) {
  const selectedMobileDevice =
    (device.platform === 'android' && device.kind === 'device' && device.target === 'mobile') ||
    (device.platform === 'apple' &&
      device.kind === 'device' &&
      device.target === 'mobile' &&
      device.appleOs === 'ios');
  const target = selectedMobileDevice ? available : openTargetUnavailable;
  const close = selectedMobileDevice ? available : closeTargetUnavailable;
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: target,
    prepareApplicationOpen: target,
    openApplication: target,
    applyRuntimeHints: runtimeHintsUnavailable,
    clearRuntimeHints: runtimeHintsUnavailable,
    closeApplication: close,
    finalizeApplicationClose: close,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}
/** How this provider instance was configured: identity, session liveness, and declared capture. */
export type WebDriverPlatformRuntimeOptions = Readonly<{
  host: PlatformRuntimeHost;
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>;
  ownsDevice(device: DeviceInfo): boolean;
  isSessionActive?(device: DeviceInfo): boolean;
  deployment?: WebDriverPlatformDeploymentRuntime;
  screenshotAvailable?: boolean;
  snapshotAvailable?: boolean;
  getInteractor?(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
}>;

export function createWebDriverPlatformRuntimeOwner(
  options: WebDriverPlatformRuntimeOptions,
): PlatformRuntimeOwner {
  return Object.freeze({
    owner: options.owner,
    ownsDevice: options.ownsDevice,
    inspectFacts: async (device) => webDriverFacts(options, device),
    bind: async (request) => {
      if (
        request.intent.kind === 'exact-owner' &&
        !sameRuntimeOwner(request.intent.owner, options.owner)
      ) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'WebDriver runtime owner identity does not match',
        );
      }
      if (!options.ownsDevice(request.device)) {
        throw new AppError('UNSUPPORTED_PLATFORM', 'WebDriver runtime does not own this device');
      }
      if (!webDriverSessionActive(options, request.device)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'The WebDriver provider session is no longer active for this device.',
        );
      }
      return bindWebDriverPlatformRuntime(options, request.device, request.scope.signal);
    },
    shutdown: async () => undefined,
  });
}

function bindWebDriverPlatformRuntime(
  options: WebDriverPlatformRuntimeOptions,
  device: DeviceInfo,
  signal: AbortSignal,
): DeviceBinding<PlatformRuntimeOperations> {
  const backend = device.platform === 'apple' ? 'ios-device' : 'android';
  const facts = webDriverFacts(options, device);
  const deploy = facts.operations.deployApp;
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = Object.freeze({
    ensureReady: async () => ({ ...device, booted: true }),
    bootTarget: async () => ({ ...device, booted: true }),
    ...availableApplicationLifecycleOperations(
      bindWebDriverApplicationLifecycle({
        device,
        signal,
        getInteractor: (selectedDevice, runner) => options.getInteractor?.(selectedDevice, runner),
      }),
      facts.operations,
    ),
    ...(facts.operations.captureSnapshot.available
      ? bindProviderSnapshotInteractor({
          device,
          signal,
          resolveInteractor: (runner) => options.getInteractor?.(device, runner),
        })
      : {}),
    ...(facts.operations.captureScreenshot.available
      ? bindProviderScreenshotInteractor({
          device,
          signal,
          resolveInteractor: (runner) => options.getInteractor?.(device, runner),
        })
      : {}),
    networkDump: async (input) => {
      const recent = await options.host.appLogs.readRecent(input.sessionId, input.maxScanLines);
      const dump = readRecentNetworkTrafficFromText(recent.text, {
        ...input,
        path: recent.path,
        exists: recent.exists,
        lineNumberOffset: recent.skippedLines,
        backend,
      });
      return Object.freeze({
        source: 'app-log' as const,
        backend,
        dump,
        notes: Object.freeze(
          dump.entries.length === 0
            ? ['No HTTP(s) entries were found in recent session app logs.']
            : [],
        ),
      });
    },
    ...(deploy.available && options.deployment
      ? {
          deployApp: async (input: AppDeploymentInput) =>
            await options.deployment!.deployApp(device, input, signal),
          materializeAppSource: async (input: MaterializeAppSourceInput) =>
            await materializeWebDriverSource(options.host, device, input, signal),
          deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
            await options.deployment!.deployMaterializedApp(device, input, signal),
        }
      : {}),
  });
  return Object.freeze({
    device,
    owner: options.owner,
    facts,
    operations,
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function webDriverFacts(
  options: Omit<WebDriverPlatformRuntimeOptions, 'host'>,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  if (!webDriverSessionActive(options, device)) {
    return createUnavailablePlatformRuntimeFacts(device, options.owner, {
      appLog: inactiveSession,
      appDeployment: inactiveSession,
      network: inactiveSession,
      screenRecording: inactiveSession,
      screenshot: inactiveSession,
      viewport: inactiveSession,
      lifecycle: applicationLifecycleOperationFacts({
        resolveOpenTarget: inactiveSession,
        prepareApplicationOpen: inactiveSession,
        openApplication: inactiveSession,
        applyRuntimeHints: inactiveSession,
        clearRuntimeHints: inactiveSession,
        closeApplication: inactiveSession,
        finalizeApplicationClose: inactiveSession,
        prepareAppleRunner: inactiveSession,
        configureProviderPortReverse: inactiveSession,
      }),
    });
  }
  const deployment = options.deployment?.fact(device) ?? deploymentUnavailable;
  const unavailable = createUnavailablePlatformRuntimeFacts(device, options.owner, {
    appLog: appLogUnavailable,
    appDeployment: deploymentUnavailable,
    network: appLogUnavailable,
    screenRecording: recordingUnavailable,
    screenshot: screenshotUnavailable,
    viewport: viewportUnavailable,
    lifecycle: webDriverLifecycleFacts(device),
  });
  // Both capture cells need the same reachability: an interactor this provider can drive, on a
  // device shape it supports. Each then adds its own declared-capability gate.
  const reachable = options.getInteractor !== undefined && webDriverInteractorDevice(device);
  const snapshotCell =
    reachable && options.snapshotAvailable !== false ? available : snapshotUnavailable;
  const screenshotCell =
    reachable && options.screenshotAvailable !== false ? available : screenshotUnavailable;
  return Object.freeze({
    device: unavailable.device,
    operations: {
      ...unavailable.operations,
      deployApp: deployment,
      materializeAppSource: deployment,
      deployMaterializedApp: deployment,
      sendPushNotification: pushUnavailable,
      appState: appStateUnavailable,
      networkDump: available,
      ...snapshotRuntimeOperationFacts({
        capture: snapshotCell,
        customActions: snapshotCustomActionsUnavailable,
        withoutActiveApp: snapshotCell,
      }),
      ...screenshotRuntimeOperationFacts({ capture: screenshotCell }),
      ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      listApps: appsUnavailable,
      shutdownTarget: {
        available: false,
        reason: 'unsupported-provider-mode',
        hint: 'WebDriver owns the target lifecycle for provider-owned devices.',
      },
    },
  });
}

/** The device shapes this provider can reach at all through its own WebDriver interactor. */
function webDriverInteractorDevice(device: DeviceInfo): boolean {
  return (
    device.kind === 'device' &&
    device.target === 'mobile' &&
    (device.platform === 'android' || (device.platform === 'apple' && device.appleOs === 'ios'))
  );
}

function webDriverSessionActive(
  options: Readonly<{
    ownsDevice(device: DeviceInfo): boolean;
    isSessionActive?(device: DeviceInfo): boolean;
  }>,
  device: DeviceInfo,
): boolean {
  return options.isSessionActive?.(device) ?? options.ownsDevice(device);
}

async function materializeWebDriverSource(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: MaterializeAppSourceInput,
  signal: AbortSignal,
): Promise<MaterializedAppSource> {
  return device.platform === 'apple'
    ? await host.appleDeployment.prepareArtifact(input, { signal })
    : await host.androidDeployment.prepareArtifact(input, { signal });
}
