import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppsFilter } from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { AppError } from '@agent-device/kernel/errors';
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
  createDoublespeedAppLogEnvelope,
  doublespeedAppLogDescriptorCodec,
  type DoublespeedAppLogDescriptor,
} from './app-log-descriptor.ts';
import { startDoublespeedAppLogPoller, type DoublespeedAppLogReader } from './app-log-poller.ts';
import {
  createDoublespeedAppDeploymentOperations,
  type DoublespeedAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import {
  DOUBLESPEED_PROVIDER,
  isSupportedDoublespeedDevice,
  parseDoublespeedDeviceId,
} from './device.ts';
import {
  deploymentOptions,
  doublespeedLifecycleFacts,
  doublespeedRecoveryFacts,
  doublespeedRuntimeFacts,
  liveSessionUnavailable,
} from './facts-runtime.ts';
import { bindDoublespeedInteractionOperations } from './interaction-operations.ts';
import { bindDoublespeedApplicationLifecycle } from './lifecycle.ts';

const APP_LOG_BACKEND = 'ios-simulator' as const;

export type DoublespeedAppLogReconnectOutcome =
  | Readonly<{ status: 'opened'; reader: DoublespeedAppLogReader }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'ownership-lost' }>;

export type DoublespeedPlatformRuntimeOwnerOptions = Omit<
  DoublespeedAppDeploymentRuntimeOptions,
  'isSessionActive'
> &
  Readonly<{
    host: PlatformRuntimeHost;
    runtimeInstance: string;
    ownsDevice(device: DeviceInfo): boolean;
    getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
    openCurrent(device: DeviceInfo): Promise<DoublespeedAppLogReader | undefined>;
    hasLiveSession(device: DeviceInfo): boolean;
    reconnect(
      descriptor: DoublespeedAppLogDescriptor,
      signal?: AbortSignal,
    ): Promise<DoublespeedAppLogReconnectOutcome>;
    listApps(
      device: DeviceInfo,
      filter: AppsFilter,
      signal: AbortSignal,
    ): Promise<readonly { id: string; name: string }[]>;
    getAppState(device: DeviceInfo, signal: AbortSignal): Promise<AppStateRuntimeResult>;
  }>;

export function createDoublespeedPlatformRuntimeOwner(
  options: DoublespeedPlatformRuntimeOwnerOptions,
): PlatformRuntimeOwner {
  const owner = providerRuntimeOwner(DOUBLESPEED_PROVIDER, options.runtimeInstance);
  const ownsDevice = (device: DeviceInfo) =>
    isSupportedDoublespeedDevice(device) && options.ownsDevice(device);
  const hasLiveSession = (device: DeviceInfo) =>
    ownsDevice(device) && options.hasLiveSession(device);
  return Object.freeze({
    owner,
    ownsDevice,
    inspectFacts: async (device) =>
      hasLiveSession(device)
        ? doublespeedRuntimeFacts(options, device)
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
            lifecycle: doublespeedLifecycleFacts(device, false),
          }),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Doublespeed app-log owner identity does not match',
        );
      }
      if (!isSupportedDoublespeedDevice(request.device)) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          'Doublespeed app logs require an iOS simulator device identity',
        );
      }
      const hasMatchingLiveSession = hasLiveSession(request.device);
      if (request.intent.kind !== 'exact-owner' && !hasMatchingLiveSession) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Doublespeed provider session is no longer live for the selected device',
          { reason: 'provider-session-unavailable' },
        );
      }
      return bindDoublespeedAppLogs(
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

function bindDoublespeedAppLogs(
  options: DoublespeedPlatformRuntimeOwnerOptions,
  owner: ReturnType<typeof providerRuntimeOwner>,
  device: DeviceInfo,
  signal: AbortSignal,
  recoveryOnly: boolean,
): DeviceBinding<PlatformRuntimeOperations> {
  const runtimeFacts = recoveryOnly
    ? doublespeedRecoveryFacts(options, device)
    : doublespeedRuntimeFacts(options, device);
  const recovery = createAppLogRecoveryOperations({
    codec: doublespeedAppLogDescriptorCodec,
    reattach: async (descriptor, context) => {
      if (
        !descriptorMatchesDevice(descriptor, device) ||
        !appLogSessionArtifactsMatch(options.host, context.sessionId, descriptor)
      ) {
        return {
          status: 'unreattachable',
          reason: 'descriptor-invalid',
          message:
            'Doublespeed app-log descriptor does not match the bound device or owning session',
        };
      }
      const reconnected = await options.reconnect(descriptor, signal);
      if (reconnected.status === 'missing') return { status: 'missing' };
      if (reconnected.status === 'ownership-lost') {
        return { status: 'unreattachable', reason: 'ownership-fence-lost' };
      }
      return {
        status: 'active',
        handle: await startDoublespeedAppLogPoller({
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
            message:
              'Doublespeed app-log descriptor does not match the bound device or owning session',
          },
  });
  const operations = {
    appLogInspect: async () => ({ backend: APP_LOG_BACKEND }),
    appLogDoctor: async () => ({
      backend: APP_LOG_BACKEND,
      checks: {
        doublespeedSessionAvailable: await currentSessionAvailable(options, device, signal),
      },
      notes: [],
    }),
    appLogStart: async (input) => {
      assertAppLogSessionArtifacts(options.host, input);
      signal.throwIfAborted();
      const reader = await options.openCurrent(device);
      if (!reader) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Doublespeed app logs require an active simulator',
        );
      }
      const descriptor: DoublespeedAppLogDescriptor = {
        transport: 'doublespeed-log-poller',
        leaseId: reader.leaseId,
        simulatorId: reader.simulatorId,
        appBundleId: input.appBundleId,
        outputPath: input.outputPath,
      };
      let pollerOwnsReader = false;
      try {
        signal.throwIfAborted();
        const envelope = createDoublespeedAppLogEnvelope({
          sessionId: input.sessionId,
          device,
          owner,
          fence: input.fence,
          descriptor,
        });
        pollerOwnsReader = true;
        const handle = await startDoublespeedAppLogPoller({
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
      const dump = readRecentNetworkTrafficFromText(recent.text, {
        ...input,
        path: recent.path,
        exists: recent.exists,
        lineNumberOffset: recent.skippedLines,
        backend: APP_LOG_BACKEND,
      });
      const notes =
        dump.entries.length === 0
          ? ['No HTTP(s) entries were found in recent session app logs.']
          : [];
      return Object.freeze({ source: 'app-log' as const, backend: APP_LOG_BACKEND, dump, notes });
    },
    ensureReady: async () => ({ ...device, booted: true }),
    bootTarget: async () => ({ ...device, booted: true }),
    listApps: async (input) => await options.listApps(input.device, input.filter, signal),
    appState: async () => await options.getAppState(device, signal),
    ...availableApplicationLifecycleOperations(
      bindDoublespeedApplicationLifecycle({
        device,
        signal,
        getInteractor: options.getInteractor,
      }),
      runtimeFacts.operations,
    ),
    ...bindDoublespeedInteractionOperations({
      device,
      signal,
      getInteractor: options.getInteractor,
    }),
    ...bindAdmittedProviderInteractorOperations({
      device,
      signal,
      resolveInteractor: (runner) => options.getInteractor(device, runner),
      facts: runtimeFacts.operations,
    }),
    ...createDoublespeedAppDeploymentOperations(deploymentOptions(options), device, signal),
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
    [Symbol.asyncDispose]: async () => undefined,
  });
}

async function currentSessionAvailable(
  options: DoublespeedPlatformRuntimeOwnerOptions,
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

function descriptorMatchesDevice(
  descriptor: DoublespeedAppLogDescriptor,
  device: DeviceInfo,
): boolean {
  if (!isSupportedDoublespeedDevice(device)) return false;
  return parseDoublespeedDeviceId(device.id)?.leaseId === descriptor.leaseId;
}
