import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppsFilter, ProviderPortReverseOptions } from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import {
  LIMRUN_FOLD_UNAVAILABLE,
  LIMRUN_TELEPHONY_UNAVAILABLE,
  bindLimrunInteractionOperations,
} from './interaction-operations.ts';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { AppError } from '@agent-device/kernel/errors';
import { isSupportedLimrunAppLogDevice, parseLimrunDeviceId } from './device.ts';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import {
  type DeviceBinding,
  providerRuntimeOwner,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  createProviderAppLogOperations,
  type ProviderAppLogReader,
  type ProviderAppLogReconnectOutcome,
} from '@agent-device/capture-kit/provider-app-log';
import { availableApplicationLifecycleOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import { limrunAppLogDescriptorCodec, type LimrunAppLogDescriptor } from './app-log-descriptor.ts';
import type { LimrunInstanceOwnership } from './instance-access.ts';
import { bindLimrunApplicationLifecycle } from './lifecycle.ts';
import {
  createLimrunAppDeploymentOperations,
  type LimrunAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import { createLimrunRequestOperationDrain } from './request-cancellation.ts';
import {
  createLimrunScreenRecordingOperations,
  type LimrunScreenRecordingSession,
} from './recording-runtime.ts';
import {
  deploymentOptions,
  limrunAppLogFacts,
  limrunAppLogRecoveryFacts,
  limrunLifecycleFacts,
  liveSessionUnavailable,
} from './facts-runtime.ts';
import type { LimrunNetworkCapture } from './network-capture.ts';
import { bindLimrunNetworkOperations } from './network-runtime.ts';

export type LimrunAppLogReader = ProviderAppLogReader &
  Readonly<{
    platform: 'ios' | 'android';
    leaseId: string;
    instanceId: string;
    ownership: LimrunInstanceOwnership;
  }>;

export type LimrunAppLogReconnectOutcome = ProviderAppLogReconnectOutcome<LimrunAppLogReader>;

export type LimrunPlatformRuntimeOwnerOptions = Omit<
  LimrunAppDeploymentRuntimeOptions,
  'isSessionActive'
> &
  Readonly<{
    host: PlatformRuntimeHost;
    runtimeInstance: string;
    ownsDevice(device: DeviceInfo): boolean;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
    getDeviceSession(device: DeviceInfo): LimrunScreenRecordingSession | undefined;
    resolveAppReference?(device: DeviceInfo, app: string): string;
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
    /** The live HTTP(S) capture source for a device with a live session, else undefined. */
    getNetworkCapture(device: DeviceInfo): Promise<LimrunNetworkCapture | undefined>;
  }>;

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
        ? limrunAppLogFacts(options, device)
        : createUnavailablePlatformRuntimeFacts(device, owner, {
            appLog: liveSessionUnavailable,
            appState: liveSessionUnavailable,
            appDeployment: liveSessionUnavailable,
            network: liveSessionUnavailable,
            screenshot: liveSessionUnavailable,
            viewport: liveSessionUnavailable,
            focus: liveSessionUnavailable,
            gesture: liveSessionUnavailable,
            scroll: liveSessionUnavailable,
            typeText: liveSessionUnavailable,
            touch: liveSessionUnavailable,
            elementText: liveSessionUnavailable,
            back: liveSessionUnavailable,
            orientation: liveSessionUnavailable,
            tvRemote: liveSessionUnavailable,
            keyboard: liveSessionUnavailable,
            clipboard: liveSessionUnavailable,
            systemButton: liveSessionUnavailable,
            fold: LIMRUN_FOLD_UNAVAILABLE,
            telephony: LIMRUN_TELEPHONY_UNAVAILABLE,
            triggerAppEvent: liveSessionUnavailable,
            settings: liveSessionUnavailable,
            readAlert: liveSessionUnavailable,
            awaitAlert: liveSessionUnavailable,
            acceptAlert: liveSessionUnavailable,
            dismissAlert: liveSessionUnavailable,
            audioProbeCapture: liveSessionUnavailable,
            audioProbeQuery: liveSessionUnavailable,
            perf: liveSessionUnavailable,
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
      return await bindLimrunAppLogs(
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

async function bindLimrunAppLogs(
  options: LimrunPlatformRuntimeOwnerOptions,
  owner: ReturnType<typeof providerRuntimeOwner>,
  device: DeviceInfo,
  signal: AbortSignal,
  recoveryOnly: boolean,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  const runtimeFacts = recoveryOnly
    ? limrunAppLogRecoveryFacts(options, device)
    : limrunAppLogFacts(options, device);
  const deploymentOperationDrain = createLimrunRequestOperationDrain();
  const appLogs = createProviderAppLogOperations({
    host: options.host,
    device,
    owner,
    signal,
    provider: 'Limrun',
    backend: device.platform === 'apple' ? 'ios-simulator' : 'android',
    sessionCheck: 'limrunSessionAvailable',
    unavailableMessage: 'Limrun app logs require an active instance',
    codec: limrunAppLogDescriptorCodec,
    openCurrent: async () => await options.openCurrent(device),
    describe: (reader, target) => ({
      transport: 'limrun-log-poller' as const,
      platform: reader.platform,
      leaseId: reader.leaseId,
      instanceId: reader.instanceId,
      ownership: reader.ownership,
      appBundleId: target.appBundleId,
      outputPath: target.outputPath,
    }),
    matchesDevice: (descriptor) => descriptorMatchesDevice(descriptor, device),
    reconnect: async (descriptor, reconnectSignal) =>
      await options.reconnect(descriptor, reconnectSignal),
  });
  const capture = await options.getNetworkCapture(device);
  const operations = {
    ...appLogs,
    ...(capture ? bindLimrunNetworkOperations({ capture, appLogDump: appLogs.networkDump }) : {}),
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
        resolveAppReference: (app) => options.resolveAppReference?.(device, app) ?? app,
        configurePortReverse: options.configurePortReverse,
      }),
      runtimeFacts.operations,
    ),
    ...bindLimrunInteractionOperations({
      device,
      signal,
      getInteractor: options.getInteractor,
      presentIosAcquisition: options.host.snapshot.presentIosAcquisition,
    }),
    ...bindAdmittedProviderInteractorOperations({
      device,
      signal,
      resolveInteractor: (runner) => options.getInteractor(device, runner),
      facts: runtimeFacts.operations,
    }),
    ...createLimrunAppDeploymentOperations(
      deploymentOptions(options),
      device,
      signal,
      deploymentOperationDrain,
    ),
    ...createLimrunScreenRecordingOperations({
      host: options.host,
      device,
      owner,
      signal,
      getDeviceSession: options.getDeviceSession,
    }),
  } satisfies DeviceBinding<PlatformRuntimeOperations>['operations'];
  return Object.freeze({
    device,
    owner,
    facts: runtimeFacts,
    operations: Object.freeze(
      recoveryOnly
        ? { appLogReattach: appLogs.appLogReattach, appLogCleanup: appLogs.appLogCleanup }
        : operations,
    ),
    [Symbol.asyncDispose]: async () => await deploymentOperationDrain[Symbol.asyncDispose](),
  });
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
