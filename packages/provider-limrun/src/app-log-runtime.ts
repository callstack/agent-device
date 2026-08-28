import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppsFilter, ProviderPortReverseOptions } from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { bindLimrunInteractionOperations } from './interaction-operations.ts';
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
  appLogSessionArtifactsMatch,
  assertAppLogSessionArtifacts,
  createAppLogRecoveryOperations,
  createAppLogStartResult,
  readRecentNetworkTrafficFromText,
} from '@agent-device/capture-kit';
import { availableApplicationLifecycleOperations } from '@agent-device/contracts/application-lifecycle-runtime';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import {
  createLimrunAppLogEnvelope,
  limrunAppLogDescriptorCodec,
  type LimrunAppLogDescriptor,
} from './app-log-descriptor.ts';
import { startLimrunAppLogPoller, type LimrunAppLogReader } from './app-log-poller.ts';
import { bindLimrunApplicationLifecycle } from './lifecycle.ts';
import {
  createLimrunAppDeploymentOperations,
  type LimrunAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import { createLimrunRequestOperationDrain } from './request-cancellation.ts';
import {
  deploymentOptions,
  limrunAppLogFacts,
  limrunAppLogRecoveryFacts,
  limrunLifecycleFacts,
  liveSessionUnavailable,
} from './facts-runtime.ts';

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
            home: liveSessionUnavailable,
            orientation: liveSessionUnavailable,
            tvRemote: liveSessionUnavailable,
            keyboardStatus: liveSessionUnavailable,
            keyboardDismiss: liveSessionUnavailable,
            keyboardEnter: liveSessionUnavailable,
            readClipboard: liveSessionUnavailable,
            writeClipboard: liveSessionUnavailable,
            appSwitcher: liveSessionUnavailable,
            triggerAppEvent: liveSessionUnavailable,
            setSetting: liveSessionUnavailable,
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
  const runtimeFacts = recoveryOnly
    ? limrunAppLogRecoveryFacts(options, device)
    : limrunAppLogFacts(options, device);
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
        resolveAppReference: (app) => options.resolveAppReference?.(device, app) ?? app,
        configurePortReverse: options.configurePortReverse,
      }),
      runtimeFacts.operations,
    ),
    ...bindLimrunInteractionOperations({ device, signal, getInteractor: options.getInteractor }),
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
