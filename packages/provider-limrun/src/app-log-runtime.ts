import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import type { AppsFilter, ProviderPortReverseOptions } from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import { parseLimrunDeviceId } from './device.ts';
import type {
  AppStateRuntimeResult,
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import {
  appLogSessionArtifactsMatch,
  assertAppLogSessionArtifacts,
  createAppLogRecoveryOperations,
  createAppLogStartResult,
  readRecentNetworkTrafficFromText,
} from '@agent-device/capture-kit';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  bindProviderScreenshotInteractor,
  bindProviderSnapshotInteractor,
  createUnavailablePlatformRuntimeFacts,
  providerRuntimeOwner,
  sameRuntimeOwner,
  screenshotRuntimeOperationFacts,
  elementTextRuntimeOperationFacts,
  snapshotRuntimeOperationFacts,
  viewportRuntimeOperationFacts,
} from '@agent-device/contracts/platform';
import {
  createLimrunAppLogEnvelope,
  limrunAppLogDescriptorCodec,
  type LimrunAppLogDescriptor,
} from './app-log-descriptor.ts';
import { startLimrunAppLogPoller, type LimrunAppLogReader } from './app-log-poller.ts';
import { bindLimrunApplicationLifecycle } from './lifecycle.ts';
import {
  createLimrunAppDeploymentOperations,
  limrunAppDeploymentFacts,
  type LimrunAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import { createLimrunRequestOperationDrain } from './request-cancellation.ts';

export type LimrunAppLogReconnectOutcome =
  | Readonly<{ status: 'opened'; reader: LimrunAppLogReader }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'ownership-lost' }>;

export type LimrunPlatformRuntimeOwnerOptions = Omit<
  LimrunAppDeploymentRuntimeOptions,
  'isSessionActive'
> &
  Readonly<{
    host: PlatformRuntimeHost;
    runtimeInstance: string;
    ownsDevice(device: DeviceInfo): boolean;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
    openCurrent(device: DeviceInfo): Promise<LimrunAppLogReader | undefined>;
    hasLiveSession(device: DeviceInfo): boolean;
    reconnect(
      descriptor: LimrunAppLogDescriptor,
      signal?: AbortSignal,
    ): Promise<LimrunAppLogReconnectOutcome>;
    listApps(
      device: DeviceInfo,
      filter: AppsFilter,
      signal: AbortSignal,
    ): Promise<readonly { id: string; name: string }[]>;
    getAppState(device: DeviceInfo, signal: AbortSignal): Promise<AppStateRuntimeResult>;
    configurePortReverse(
      options: ProviderPortReverseOptions,
    ): Promise<Record<string, unknown> | undefined>;
  }>;

function deploymentOptions(
  options: LimrunPlatformRuntimeOwnerOptions,
): LimrunAppDeploymentRuntimeOptions {
  return { ...options, isSessionActive: options.hasLiveSession };
}

const available = Object.freeze({ available: true } as const);
const customSnapshotUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Custom snapshot actions are available only for Limrun iOS simulator sessions.',
} as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun does not expose viewport resizing.',
} as const);
/**
 * A point read needs a local tool (adb uiautomator, the XCUITest runner). Limrun's transport
 * carries none of them, so the owner reports no live read and `get` answers from the captured
 * tree; provider ownership never borrows the local family read.
 */
const elementTextUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun-owned devices read element text from the captured tree only.',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun does not expose an exact-owner screen-recording runtime.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is unavailable for provider-owned devices.',
} as const);
const liveSessionUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'Limrun requires a matching live provider session for this device.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Apple runner preparation is unavailable for Limrun-owned devices.',
} as const);
const openTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun open requires a Limrun-owned iOS simulator or Android emulator.',
} as const);
const closeTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun close requires a Limrun-owned iOS simulator or Android emulator.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Runtime hints are not applied to provider-owned devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun port reverse requires an active Android Limrun session.',
} as const);
function limrunLifecycleFacts(device: DeviceInfo, live: boolean) {
  const openTarget = limrunOpenTargetFact(device, live);
  const closeTarget = limrunCloseTargetFact(device, live);
  const portReverse = limrunPortReverseFact(device, live);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: runtimeHintsUnavailable,
    clearRuntimeHints: runtimeHintsUnavailable,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverse,
  });
}

function limrunOpenTargetFact(device: DeviceInfo, live: boolean) {
  return isSupportedLimrunAppLogDevice(device)
    ? live
      ? available
      : liveSessionUnavailable
    : openTargetUnavailable;
}

function limrunCloseTargetFact(device: DeviceInfo, live: boolean) {
  return isSupportedLimrunAppLogDevice(device)
    ? live
      ? available
      : liveSessionUnavailable
    : closeTargetUnavailable;
}

function limrunPortReverseFact(device: DeviceInfo, live: boolean) {
  if (!live) return liveSessionUnavailable;
  return device.platform === 'android' ? available : portReverseUnavailable;
}

export function createLimrunPlatformRuntimeOwner(
  options: LimrunPlatformRuntimeOwnerOptions,
): PlatformRuntimeOwner {
  const owner = providerRuntimeOwner('limrun', options.runtimeInstance);
  const ownsDevice = (device: DeviceInfo) =>
    isSupportedLimrunAppLogDevice(device) && options.ownsDevice(device);
  const hasLiveSession = (device: DeviceInfo) =>
    ownsDevice(device) && options.hasLiveSession(device);
  return Object.freeze({
    owner,
    ownsDevice,
    inspectFacts: async (device) =>
      hasLiveSession(device)
        ? facts(options, device)
        : createUnavailablePlatformRuntimeFacts(device, owner, {
            appLog: liveSessionUnavailable,
            appState: liveSessionUnavailable,
            appDeployment: liveSessionUnavailable,
            network: liveSessionUnavailable,
            screenshot: liveSessionUnavailable,
            viewport: liveSessionUnavailable,
            elementText: liveSessionUnavailable,
            readiness: liveSessionUnavailable,
            shutdown: liveSessionUnavailable,
            lifecycle: limrunLifecycleFacts(device, false),
          }),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Limrun app-log owner identity does not match');
      }
      if (!isSupportedLimrunAppLogDevice(request.device)) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          'Limrun app logs require an iOS simulator or Android emulator device identity',
        );
      }
      const hasMatchingLiveSession = hasLiveSession(request.device);
      if (request.intent.kind !== 'exact-owner' && !hasMatchingLiveSession) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Limrun provider session is no longer live for the selected device',
          { reason: 'provider-session-unavailable' },
        );
      }
      return bindLimrunAppLogs(
        options,
        owner,
        request.device,
        request.scope.signal,
        !hasMatchingLiveSession,
      );
    },
    shutdown: async () => undefined,
  });
}

function bindLimrunAppLogs(
  options: LimrunPlatformRuntimeOwnerOptions,
  owner: ReturnType<typeof providerRuntimeOwner>,
  device: DeviceInfo,
  signal: AbortSignal,
  recoveryOnly: boolean,
): DeviceBinding<PlatformRuntimeOperations> {
  const runtimeFacts = recoveryOnly ? recoveryFacts(options, device) : facts(options, device);
  const deploymentOperationDrain = createLimrunRequestOperationDrain();
  const recovery = createAppLogRecoveryOperations({
    codec: limrunAppLogDescriptorCodec,
    reattach: async (descriptor, context) => {
      if (
        !descriptorMatchesDevice(descriptor, device) ||
        !appLogSessionArtifactsMatch(options.host, context.sessionId, descriptor)
      ) {
        return {
          status: 'unreattachable',
          reason: 'descriptor-invalid',
          message: 'Limrun app-log descriptor does not match the bound device or owning session',
        };
      }
      const reconnected = await options.reconnect(descriptor, signal);
      if (reconnected.status === 'missing') return { status: 'missing' };
      if (reconnected.status === 'ownership-lost') {
        return { status: 'unreattachable', reason: 'ownership-fence-lost' };
      }
      return {
        status: 'active',
        handle: await startLimrunAppLogPoller({
          host: options.host,
          reader: reconnected.reader,
          appBundleId: descriptor.appBundleId,
          outputPath: descriptor.outputPath,
        }),
      };
    },
    cleanup: async (descriptor, context) =>
      descriptorMatchesDevice(descriptor, device) &&
      appLogSessionArtifactsMatch(options.host, context.sessionId, descriptor)
        ? { status: 'cleaned' }
        : {
            status: 'cleanup-pending',
            reason: 'ownership-fence-lost',
            message: 'Limrun app-log descriptor does not match the bound device or owning session',
          },
  });
  const operations = {
    appLogInspect: async () => ({ backend: backendForDevice(device) }),
    appLogDoctor: async () => ({
      backend: backendForDevice(device),
      checks: { limrunSessionAvailable: await currentSessionAvailable(options, device, signal) },
      notes: [],
    }),
    appLogStart: async (input) => {
      assertAppLogSessionArtifacts(options.host, input);
      signal.throwIfAborted();
      const reader = await options.openCurrent(device);
      if (!reader) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Limrun app logs require an active instance');
      }
      const descriptor: LimrunAppLogDescriptor = {
        transport: 'limrun-log-poller',
        platform: reader.platform,
        leaseId: reader.leaseId,
        instanceId: reader.instanceId,
        appBundleId: input.appBundleId,
        outputPath: input.outputPath,
      };
      let pollerOwnsReader = false;
      try {
        signal.throwIfAborted();
        const envelope = createLimrunAppLogEnvelope({
          sessionId: input.sessionId,
          device,
          owner,
          fence: input.fence,
          descriptor,
        });
        pollerOwnsReader = true;
        const handle = await startLimrunAppLogPoller({
          host: options.host,
          reader,
          appBundleId: input.appBundleId,
          outputPath: input.outputPath,
        });
        return createAppLogStartResult(handle, envelope);
      } catch (error) {
        if (!pollerOwnsReader) await reader[Symbol.asyncDispose]();
        throw error;
      }
    },
    ...recovery,
    networkDump: async (input) => {
      const recent = await options.host.appLogs.readRecent(input.sessionId, input.maxScanLines);
      const backend = backendForDevice(device);
      const dump = readRecentNetworkTrafficFromText(recent.text, {
        ...input,
        path: recent.path,
        exists: recent.exists,
        lineNumberOffset: recent.skippedLines,
        backend,
      });
      const notes =
        dump.entries.length === 0
          ? ['No HTTP(s) entries were found in recent session app logs.']
          : [];
      return Object.freeze({ source: 'app-log' as const, backend, dump, notes });
    },
    ensureReady: async () => ({ ...device, booted: true }),
    bootTarget: async () => ({ ...device, booted: true }),
    listApps: async (input) => await options.listApps(input.device, input.filter, signal),
    ...(device.platform === 'android'
      ? {
          appState: async () => await options.getAppState(device, signal),
        }
      : {}),
    ...availableApplicationLifecycleOperations(
      bindLimrunApplicationLifecycle({
        device,
        signal,
        getInteractor: options.getInteractor,
        configurePortReverse: options.configurePortReverse,
      }),
      runtimeFacts.operations,
    ),
    ...bindProviderSnapshotInteractor({
      device,
      signal,
      resolveInteractor: (runner) => options.getInteractor(device, runner),
    }),
    ...bindProviderScreenshotInteractor({
      device,
      signal,
      resolveInteractor: (runner) => options.getInteractor(device, runner),
    }),
    ...createLimrunAppDeploymentOperations(
      deploymentOptions(options),
      device,
      signal,
      deploymentOperationDrain,
    ),
  } satisfies DeviceBinding<PlatformRuntimeOperations>['operations'];
  return Object.freeze({
    device,
    owner,
    facts: runtimeFacts,
    operations: Object.freeze(
      recoveryOnly
        ? { appLogReattach: recovery.appLogReattach, appLogCleanup: recovery.appLogCleanup }
        : operations,
    ),
    [Symbol.asyncDispose]: async () => await deploymentOperationDrain[Symbol.asyncDispose](),
  });
}

async function currentSessionAvailable(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const reader = await options.openCurrent(device);
  if (!reader) return false;
  try {
    signal.throwIfAborted();
  } finally {
    await reader[Symbol.asyncDispose]();
  }
  return true;
}

function facts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const deployment = limrunAppDeploymentFacts(deploymentOptions(options), device);
  return Object.freeze({
    device: {
      family: device.platform,
      ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      ...(device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
      providerMode: 'provider-runtime',
    },
    operations: {
      appLogInspect: available,
      appLogDoctor: available,
      appLogStart: available,
      appLogReattach: available,
      appLogCleanup: available,
      ...deployment,
      appState:
        device.platform === 'android'
          ? available
          : {
              available: false,
              reason: 'unsupported-provider-mode',
              hint: 'Limrun iOS appstate is session-owned; no sessionless provider foreground probe is exposed.',
            },
      networkDump: available,
      screenRecordingStart: recordingUnavailable,
      screenRecordingReattach: recordingUnavailable,
      screenRecordingCleanup: recordingUnavailable,
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions:
          isIosFamily(device) && device.kind === 'simulator'
            ? available
            : customSnapshotUnavailable,
        withoutActiveApp: available,
      }),
      ...screenshotRuntimeOperationFacts({ capture: available }),
      ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
      ...elementTextRuntimeOperationFacts({ readTextAtPoint: elementTextUnavailable }),
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      listApps: available,
      shutdownTarget: {
        available: false,
        reason: 'unsupported-provider-mode',
        hint: 'Limrun owns the target lifecycle for provider-owned devices.',
      },
      ...limrunLifecycleFacts(device, true),
    },
  });
}

function recoveryFacts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const normalFacts = facts(options, device);
  return Object.freeze({
    device: normalFacts.device,
    operations: {
      ...normalFacts.operations,
      appLogInspect: liveSessionUnavailable,
      appLogDoctor: liveSessionUnavailable,
      appLogStart: liveSessionUnavailable,
      appLogReattach: available,
      appLogCleanup: available,
      appState: liveSessionUnavailable,
      networkDump: liveSessionUnavailable,
      screenRecordingStart: liveSessionUnavailable,
      screenRecordingReattach: liveSessionUnavailable,
      screenRecordingCleanup: liveSessionUnavailable,
      ...snapshotRuntimeOperationFacts({
        capture: liveSessionUnavailable,
        customActions: liveSessionUnavailable,
        withoutActiveApp: liveSessionUnavailable,
      }),
      ...screenshotRuntimeOperationFacts({ capture: liveSessionUnavailable }),
      ...viewportRuntimeOperationFacts({ setViewport: liveSessionUnavailable }),
      ensureReady: liveSessionUnavailable,
      bootTarget: liveSessionUnavailable,
      bootTargetHeadless: liveSessionUnavailable,
      listApps: liveSessionUnavailable,
      deployApp: liveSessionUnavailable,
      materializeAppSource: liveSessionUnavailable,
      deployMaterializedApp: liveSessionUnavailable,
      sendPushNotification: liveSessionUnavailable,
      shutdownTarget: liveSessionUnavailable,
      ...limrunLifecycleFacts(device, false),
    },
  });
}

function backendForDevice(device: DeviceInfo): 'ios-simulator' | 'android' {
  return device.platform === 'apple' ? 'ios-simulator' : 'android';
}

function descriptorMatchesDevice(descriptor: LimrunAppLogDescriptor, device: DeviceInfo): boolean {
  if (!isSupportedLimrunAppLogDevice(device)) return false;
  const parsed = parseLimrunDeviceId(device.id);
  return (
    parsed !== undefined &&
    parsed.leaseId === descriptor.leaseId &&
    parsed.platform === descriptor.platform &&
    (device.platform === 'apple'
      ? descriptor.platform === 'ios'
      : descriptor.platform === 'android')
  );
}

function isSupportedLimrunAppLogDevice(device: DeviceInfo): boolean {
  const parsed = parseLimrunDeviceId(device.id);
  if (!parsed || device.target !== 'mobile') return false;
  return parsed.platform === 'ios'
    ? isSupportedLimrunIosDevice(device)
    : isSupportedLimrunAndroidDevice(device);
}

function isSupportedLimrunIosDevice(device: DeviceInfo): boolean {
  return (
    device.platform === 'apple' &&
    device.appleOs === 'ios' &&
    device.kind === 'simulator' &&
    device.iosPhysicalDeviceBackend === undefined
  );
}

function isSupportedLimrunAndroidDevice(device: DeviceInfo): boolean {
  return (
    device.platform === 'android' &&
    device.appleOs === undefined &&
    device.kind === 'emulator' &&
    device.iosPhysicalDeviceBackend === undefined
  );
}
